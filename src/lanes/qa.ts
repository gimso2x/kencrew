import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type ProcessRunner, runOmpPrint } from "../dispatch/omp";
import type { Logger } from "../log";
import { redact } from "../redact";
import type { LaneQaPolicy } from "../tasks/notify";
import {
	checkLines,
	type GateSubject,
	gateFileStem,
	type LaneReviewDeps,
	laneSubject,
	REVIEW_OVERLAY_YAML,
} from "./review";
import type { LaneQa, LaneRow } from "./status";
import { defaultGit, type GitRunner } from "./verify";

/**
 * The run QA of a closed lane before its auto-merge (`taskAutoLand.qa`, doc/plans/bot-org-risk-gates.md 단계 3): a
 * detached copy of the claim commit (`git worktree add --detach <worktreesDir>/<lane>-<sha> <sha>`, the lane's own
 * worktree is never touched) where a fresh `omp -p --model <qa.model>` runs under the reviewer's isolation overlay
 * and then `qa.overlay`, exercises the acceptance criteria and ends with one JSON line `{verdict, findings}`. The
 * receipt is bound to the claim commit, the copy goes whatever the end. Everything that goes wrong is an
 * `inconclusive` receipt, never a throw.
 */

const FINDINGS_MAX = 10;
const FINDING_CHARS = 200;
/** The QA run's stdout kept for the verdict (the JSON line is the last one). */
const OUTPUT_MAX = 64_000;

export interface LaneQaDeps {
	ompBin: string;
	/** Config `ompProfile` of the QA's `omp -p` (the bot's own profile: login and models). */
	ompProfile?: string;
	/** The safety floors the daemon's `omp -p` children get (`--append-system-prompt`). */
	systemPromptAppendix: string;
	/** `<ompbot home>/qa-worktrees`: the copies of claim commits (0700); every entry there is a QA's copy. */
	worktreesDir: string;
	/** `<ompbot home>/reviews`: where the QA's isolation overlay is written for the run (0600). */
	overlaysDir: string;
	now(): number;
	run?: ProcessRunner;
	git?: GitRunner;
	inheritedEnv?: Record<string, string | undefined>;
	/** Where a failed removal of a copy or the overlay is logged. */
	log?: Pick<Logger, "warn">;
}

/** The QA's deps out of the reviewer's setup (the lanes' and the [TASK] gate's QA share it): its overlays go to `reviewsDir`. */
export function qaDepsOf(
	reviewer: Omit<LaneReviewDeps, "headOf" | "now">,
	worktreesDir: string,
	now: () => number,
	log: Logger,
): LaneQaDeps {
	return {
		ompBin: reviewer.ompBin,
		...(reviewer.ompProfile === undefined ? {} : { ompProfile: reviewer.ompProfile }),
		systemPromptAppendix: reviewer.systemPromptAppendix,
		worktreesDir,
		overlaysDir: reviewer.reviewsDir,
		now,
		...(reviewer.run === undefined ? {} : { run: reviewer.run }),
		...(reviewer.git === undefined ? {} : { git: reviewer.git }),
		...(reviewer.inheritedEnv === undefined ? {} : { inheritedEnv: reviewer.inheritedEnv }),
		log,
	};
}

export interface LaneQaInput {
	lane: LaneRow;
	policy: LaneQaPolicy;
	signal?: AbortSignal;
}

/** The copy of one QA run: `<worktreesDir>/<laneId>-<sha>` (a fixed name: a leftover is found by the next cleanup). */
export const qaWorktreePath = (worktreesDir: string, lane: LaneRow, sha: string): string =>
	copyPath(worktreesDir, laneSubject(lane).id, sha);

const copyPath = (worktreesDir: string, id: string, sha: string): string => join(worktreesDir, `${id}-${sha}`);
const overlayPath = (overlaysDir: string, id: string, sha: string): string =>
	`${gateFileStem(overlaysDir, id, sha)}.qa.omp.yml`;

/** The QA's isolation overlay: `<overlaysDir>/<laneId>-<sha12>.qa.omp.yml` (dropped with the lane's review files). */
export const qaOverlayPath = (overlaysDir: string, lane: LaneRow, sha: string): string =>
	overlayPath(overlaysDir, laneSubject(lane).id, sha);

/** The QA's prompt: what to run (spec and acceptance criteria), what the core re-ran, and the one-line JSON ending. */
function qaPrompt(subject: GateSubject, copy: string): string {
	const sha = subject.sha === "" ? "?" : subject.sha;
	const acceptance = subject.acceptance.map((item) => `- ${item.id}: ${item.text}`);
	const checks = checkLines(subject.checks);
	return [
		"너는 이 변경을 실제로 돌려 보는 실행 QA다.",
		`지금 작업 디렉터리(${copy})는 레인의 클레임 커밋 ${sha}만 꺼낸 임시 사본이고, 끝나면 지워진다.`,
		"수락기준의 동작을 이 사본에서 실제로 실행해(빌드·테스트·명령·스크립트) 확인한다. 코드를 읽기만 하고 판정하지 않는다.",
		"커밋·push·이 사본 밖 파일 수정·서비스 조작은 하지 않는다. 의존성이 없으면 이 사본 안에서만 설치한다.",
		"수락기준 하나라도 실제로 실패하거나 실행으로 확인할 수 없으면 FAIL이다.",
		'마지막 줄에는 정확히 JSON 한 줄 `{"verdict":"PASS"|"FAIL","findings":["<발견 1>", ...]}`만 쓴다. findings에는 실행한 명령과 결과·실패 지점을 10개 이내로 쓴다.',
		"",
		"## 1. 스펙",
		`제목: ${subject.title}`,
		"",
		subject.brief === undefined ? "(브리프 없음)" : subject.brief,
		"",
		"수락기준:",
		...(acceptance.length === 0 ? ["(없음)"] : acceptance),
		"",
		"## 2. 코어가 다시 돌린 [check:] 결과",
		...(checks.length === 0 ? ["(재실행 검사 없음)"] : checks),
	].join("\n");
}

/**
 * The verdict of a QA run's output: its last non-empty line (a closing code fence is skipped) parsed as JSON with
 * `verdict` PASS or FAIL and `findings` an array (missing: none). Anything else is a reason, never a verdict.
 */
export function parseQaVerdict(output: string): { verdict: "PASS" | "FAIL"; findings: string[] } | { reason: string } {
	const last = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("```"))
		.at(-1);
	if (last === undefined) return { reason: "마지막 줄 없음" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(last);
	} catch {
		return { reason: "마지막 줄이 JSON 아님" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return { reason: "마지막 줄이 JSON 아님" };
	const { verdict, findings } = parsed as { verdict?: unknown; findings?: unknown };
	if (verdict !== "PASS" && verdict !== "FAIL") return { reason: "verdict가 PASS·FAIL 아님" };
	if (findings !== undefined && !Array.isArray(findings)) return { reason: "findings가 배열 아님" };
	return {
		verdict,
		findings: (findings ?? [])
			.slice(0, FINDINGS_MAX)
			.map((finding) =>
				redact(typeof finding === "string" ? finding : JSON.stringify(finding)).slice(0, FINDING_CHARS),
			),
	};
}

/** Runs the QA of the lane's claim commit once; resolves with its receipt and never throws. */
export function runLaneQa(input: LaneQaInput, deps: LaneQaDeps): Promise<LaneQa> {
	const { lane, ...rest } = input;
	return runQa({ subject: laneSubject(lane), ...rest }, deps);
}

export interface GateQaInput {
	subject: GateSubject;
	policy: LaneQaPolicy;
	signal?: AbortSignal;
}

/** Runs the QA of the subject's commit once; resolves with its receipt and never throws. */
export async function runQa(input: GateQaInput, deps: LaneQaDeps): Promise<LaneQa> {
	const { subject, policy } = input;
	const { sha } = subject;
	const receipt = (verdict: LaneQa["verdict"], findings: string[], reason?: string): LaneQa => ({
		sha,
		verdict,
		findings,
		model: policy.model,
		at: deps.now(),
		...(reason === undefined ? {} : { reason }),
	});
	const inconclusive = (reason: string): LaneQa => receipt("inconclusive", [], reason);
	const { repo, worktree } = subject;
	if (sha === "" || repo === undefined) return inconclusive("레인에 저장소나 클레임 커밋이 없음");
	const git = deps.git ?? defaultGit;
	const copy = copyPath(deps.worktreesDir, subject.id, sha);
	const overlay = overlayPath(deps.overlaysDir, subject.id, sha);
	try {
		mkdirSync(deps.worktreesDir, { recursive: true, mode: 0o700 });
		chmodSync(deps.worktreesDir, 0o700);
		// Leftovers of an earlier run (a killed daemon) go first: QA runs one at a time, so every entry is stale.
		await cleanQaWorktrees(deps.worktreesDir, git, deps.log);
		const added = await git(["-C", repo, "worktree", "add", "--detach", copy, sha]);
		if (added.code !== 0) return inconclusive(`QA 사본 생성 실패: ${added.stderr.trim().slice(0, 160)}`);
		try {
			// No install in the copy: the lane worktree's dependencies are linked when it has them.
			const modules = worktree === undefined ? undefined : join(worktree, "node_modules");
			if (modules !== undefined && existsSync(modules)) symlinkSync(modules, join(copy, "node_modules"));
			mkdirSync(deps.overlaysDir, { recursive: true, mode: 0o700 });
			chmodSync(deps.overlaysDir, 0o700);
			writeFileSync(overlay, REVIEW_OVERLAY_YAML, { mode: 0o600 });
			chmodSync(overlay, 0o600);
			const result = await runOmpPrint({
				task: qaPrompt(subject, copy),
				cwd: copy,
				isolation: { configPath: overlay },
				overlayConfig: policy.overlay,
				systemPromptAppendix: deps.systemPromptAppendix,
				ompBin: deps.ompBin,
				timeoutMs: policy.timeoutMs,
				maxChars: OUTPUT_MAX,
				model: policy.model,
				...(input.signal === undefined ? {} : { signal: input.signal }),
				...(deps.run === undefined ? {} : { run: deps.run }),
				...(deps.inheritedEnv === undefined ? {} : { inheritedEnv: deps.inheritedEnv }),
				...(deps.ompProfile === undefined ? {} : { ompProfile: deps.ompProfile }),
			});
			if (input.signal?.aborted === true) return inconclusive("중단됨");
			if (result.timedOut) return inconclusive("시간 초과");
			if (result.code !== 0) return inconclusive(`종료 코드 ${result.code ?? "없음"}`);
			const parsed = parseQaVerdict(result.output);
			if ("reason" in parsed) return inconclusive(parsed.reason);
			return receipt(parsed.verdict, parsed.findings);
		} finally {
			try {
				rmSync(overlay, { force: true });
			} catch (error) {
				deps.log?.warn("lane_qa_file_remove_failed", { file: overlay, error: String(error) });
			}
			await removeQaWorktree(copy, git, deps.log);
		}
	} catch (error) {
		return inconclusive(`QA 실행 실패: ${String(error).slice(0, 200)}`);
	}
}

/** `work`'s value, or `undefined` as soon as `signal` aborts (at once when it already has). */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	const aborted = Promise.withResolvers<undefined>();
	const onAbort = (): void => aborted.resolve(undefined);
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([work, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** Waits for a place in the gate slot; resolves with the function that frees it. */
export type GateSlot = () => Promise<() => void>;

/**
 * One review or QA at a time: a QA removes every copy in `qa-worktrees` when it starts, so the lanes' and the [TASK]s'
 * reviews and QAs share one slot (the daemon makes it and hands it to the lane manager and the task gate).
 */
export function createGateSlot(): GateSlot {
	let tail: Promise<void> = Promise.resolve();
	return async () => {
		const previous = tail;
		const freed = Promise.withResolvers<void>();
		tail = previous.then(() => freed.promise);
		await previous;
		return freed.resolve;
	};
}

/**
 * Removes every copy left in `worktreesDir` (a QA cut off by a stop or a crash): `git worktree remove --force`, the
 * directory itself, then `git worktree prune` of its repository. A missing directory is nothing to do; a failure is
 * logged, never thrown.
 */
export async function cleanQaWorktrees(
	worktreesDir: string,
	git: GitRunner = defaultGit,
	log?: Pick<Logger, "warn">,
): Promise<void> {
	let entries: string[];
	try {
		entries = readdirSync(worktreesDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			log?.warn("lane_qa_worktrees_unreadable", { dir: worktreesDir, error: String(error) });
		}
		return;
	}
	for (const entry of entries) await removeQaWorktree(join(worktreesDir, entry), git, log);
}

/** One copy: its repository is read from the copy's `.git` file (`gitdir: <common>/worktrees/<name>`) before removal. */
async function removeQaWorktree(copy: string, git: GitRunner, log?: Pick<Logger, "warn">): Promise<void> {
	const common = commonDirOf(copy);
	try {
		if (common !== undefined) await git(["--git-dir", common, "worktree", "remove", "--force", copy]);
		rmSync(copy, { force: true, recursive: true });
		if (common !== undefined) await git(["--git-dir", common, "worktree", "prune"]);
	} catch (error) {
		log?.warn("lane_qa_worktree_remove_failed", { worktree: copy, error: String(error).slice(0, 200) });
	}
}

/** The git common directory a linked worktree's `.git` file points into; undefined when it is no such worktree. */
function commonDirOf(copy: string): string | undefined {
	try {
		const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(copy, ".git"), "utf8"));
		if (match?.[1] === undefined) return undefined;
		const gitdir = match[1].trim();
		return isAbsolute(gitdir) ? resolve(gitdir, "..", "..") : resolve(copy, gitdir, "..", "..");
	} catch {
		return undefined;
	}
}
