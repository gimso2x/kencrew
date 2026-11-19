import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dispatchEnv } from "../dispatch/omp";
import { coreRebase, type LandLane } from "../lanes/land";
import { defaultGit, type GitResult, type GitRunner } from "../lanes/verify";
import { docsDirOf } from "./docs";
import type { TaskEvaluation } from "./evaluate";
import type { TaskLedger, TaskRow } from "./ledger";
import { holdingIntegrityWarnings } from "./notify";

/**
 * The core's landing of a reached local [TASK] (doc/plans/task-core-land.md): rebase onto the base branch when it moved
 * ahead, refresh the evidence hashes the rebase made stale, judge the fixed tip again, then the lanes' fixed-sha
 * landing (`landLane` through the daemon's one lander) and `done`. What needs judgement — a conflict, a hash without a
 * pair, lost changes, a failed re-judgement — is handed back to the model turn ("머지해") as `handoff`; nothing that
 * reaches the base branch skips the re-judgement.
 */

const REASON_MAX = 300;
const SHOWN = 5;
/** Commit-like tokens in the evidence files (the outcome parser's 7–40 hex digits). */
const HASH_TOKEN = /\b[0-9a-f]{7,40}\b/g;
const EVIDENCE_FILES = ["outcome.md", "PROGRESS.md"] as const;
const PATCH_ID_TIMEOUT_MS = 60_000;

export interface TaskLandRebase {
	/** The task branch before the core's rebase. */
	oldSha: string;
	/** Its tip after the rebase (and the evidence-hash commit, when one was made). */
	newSha: string;
}

export type TaskLandResult =
	/** Merged at `sha` (pushed to `pushed` when the repository has an `origin`), `done`; `notes`: what is left to do by hand. */
	| {
			state: "landed";
			baseBranch: string;
			sha: string;
			pushed?: string;
			rebase?: TaskLandRebase;
			notes: string[];
	  }
	/** Merged and `done`; `origin` refused the push (`reason`). */
	| {
			state: "merged-not-pushed";
			baseBranch: string;
			sha: string;
			reason: string;
			rebase?: TaskLandRebase;
			notes: string[];
	  }
	/** The base branch did not move; the model turn takes over ("머지해"). `rebase`: the branch was left rebased. */
	| { state: "handoff"; reason: string; rebase?: TaskLandRebase }
	/** The base branch did not move and nothing is handed over: the task changed under the landing, or git refused. */
	| { state: "blocked"; reason: string };

/**
 * What a landing call came to: `not_accepted` = "머지해" could not be put in, `in_flight` = this task is landing (or
 * being gated) already, `gating` = the independent review and run QA started in the background (src/tasks/gate.ts),
 * `held` = their receipts hold the merge (`reasons`; empty when that was already told).
 */
export type TaskLandOutcome =
	| TaskLandResult
	| { state: "not_accepted" }
	| { state: "in_flight" }
	| { state: "gating" }
	| { state: "held"; reasons: string[] };

export interface TaskLandDeps {
	git?: GitRunner;
	/** The daemon's one lander (`createLaneLander`), shared with the work lanes. */
	land: LandLane;
	/** `button`: the owner clicked `머지` — an unproven claim word the card already showed does not hand the landing back. */
	mode: "auto" | "button";
	/** Judges the task at its worktree's HEAD with the `[check:]` re-runs and the integrity read (`evaluateTask`). */
	judge(row: TaskRow): Promise<TaskEvaluation>;
	/** Read right before the landing (`taskLandHold`): why it must not happen now; `undefined` = go on. */
	holdReason(): string | undefined;
	ledger: Pick<TaskLedger, "transition">;
	/** After `done`: reaction sync and the herdr workspace; never throws, returns lines for the card. */
	afterDone(row: TaskRow): Promise<string[]>;
}

const clip = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
const handoff = (reason: string, rebase?: TaskLandRebase): TaskLandResult => ({
	state: "handoff",
	reason: clip(reason),
	...(rebase === undefined ? {} : { rebase }),
});
const shown = (items: readonly string[]): string =>
	`${items.slice(0, SHOWN).join(", ")}${items.length > SHOWN ? ` 외 ${items.length - SHOWN}개` : ""}`;

function failureLine(result: GitResult): string {
	const lines = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return (lines.find((line) => /error|fatal|conflict/i.test(line)) ?? lines[0] ?? `exit ${result.code}`).slice(0, 200);
}

/** A failed git call inside the landing: the step ends in `handoff` with this line. */
class GitStepError extends Error {}

async function must(git: GitRunner, args: string[]): Promise<string> {
	const result = await git(args);
	if (result.code !== 0) throw new GitStepError(`git ${args.slice(2, 4).join(" ")}: ${failureLine(result)}`);
	return result.stdout.trim();
}

/** Whether `ancestor` is an ancestor of `of` (`merge-base --is-ancestor`); throws when git cannot tell. */
async function isAncestor(git: GitRunner, dir: string, ancestor: string, of: string): Promise<boolean> {
	const result = await git(["-C", dir, "merge-base", "--is-ancestor", ancestor, of]);
	if (result.code === 0 || result.code === 1) return result.code === 0;
	throw new GitStepError(`git merge-base: ${failureLine(result)}`);
}

/**
 * Whether an `origin` URL may be a live checkout rather than a bare repository: a local path or a `host:path` without a
 * `.git` ending (설계 1). A push into a checked-out branch of such a repository would move it under its owner.
 */
export function maybeLiveCheckout(url: string): boolean {
	const bare = url.replace(/\/+$/, "");
	if (bare.endsWith(".git")) return false;
	if (bare.startsWith("file://")) return true;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bare)) return false;
	if (bare.startsWith("/") || bare.startsWith(".") || bare.startsWith("~")) return true;
	return /^[^/\s]+:/.test(bare);
}

export interface TaskLandHoldState {
	frozen: boolean;
	paused: boolean;
	/** `<home>/autoland.hold` for an auto-merge; `undefined` for an owner's button or when not held. */
	hold: string | undefined;
}

/** Why a landing must stop right before the merge (설계 5): the re-read row left review, or a freeze, pause or hold. */
export function taskLandHold(row: TaskRow | undefined, state: TaskLandHoldState): string | undefined {
	if (row === undefined) return "TASK가 원장에 없음";
	if (row.status !== "review") return `TASK 상태가 ${row.status}로 바뀜`;
	if (state.frozen) return "동결 중";
	if (state.paused) return "멈춤 중";
	if (state.hold !== undefined) return `autoland.hold: ${state.hold}`;
	return undefined;
}

/** Why the core does not land this task at all (설계 1·2); `undefined` = it may. */
async function precondition(git: GitRunner, row: TaskRow): Promise<string | undefined> {
	if (row.status !== "review") return `TASK 상태가 review가 아님(${row.status})`;
	if (row.host !== null) return `원격 호스트(${row.host}) TASK`;
	if (!existsSync(row.worktree)) return `worktree 없음: ${row.worktree}`;
	const head = await git(["-C", row.worktree, "symbolic-ref", "-q", "HEAD"]);
	if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${row.branch}`) {
		return `worktree HEAD가 ${row.branch}가 아님(${head.stdout.trim() || "detached"})`;
	}
	const origin = await git(["-C", row.repo, "remote", "get-url", "origin"]);
	if (origin.code === 0 && maybeLiveCheckout(origin.stdout.trim())) {
		return `비베어 원격 가능성: origin ${origin.stdout.trim()}`;
	}
	const status = await git(["-C", row.worktree, "status", "--porcelain", "--untracked-files=all"]);
	if (status.code !== 0) return `git status 실패: ${failureLine(status)}`;
	const dirty = status.stdout.split("\n").filter((line) => line.trim() !== "");
	if (dirty.length > 0) return `worktree에 커밋 안 된 변경 ${dirty.length}건: ${shown(dirty.map((l) => l.trim()))}`;
	return undefined;
}

/** The base branch the task lands on: `origin/HEAD`'s branch when it exists locally, else `main`, else `master`. */
export async function baseBranchOf(git: GitRunner, repo: string): Promise<string | undefined> {
	const head = await git(["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	const candidates = [...(head.code === 0 ? [head.stdout.trim().replace(/^origin\//, "")] : []), "main", "master"];
	for (const candidate of candidates) {
		if ((await git(["-C", repo, "rev-parse", "--verify", "-q", `refs/heads/${candidate}^{commit}`])).code === 0) {
			return candidate;
		}
	}
	return undefined;
}

/** `git patch-id --stable` of the commits `git log -p <revs>` lists (merges and empty commits have none): commit → patch id. */
async function gitPatchIds(dir: string, revs: readonly string[]): Promise<Map<string, string>> {
	const env = dispatchEnv(process.env);
	const log = Bun.spawn(
		["git", "-C", dir, "log", "-p", "--no-merges", "--no-color", "--no-ext-diff", "--no-textconv", ...revs],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: PATCH_ID_TIMEOUT_MS },
	);
	const patchId = Bun.spawn(["git", "-C", dir, "patch-id", "--stable"], {
		stdin: log.stdout,
		stdout: "pipe",
		stderr: "pipe",
		env,
		timeout: PATCH_ID_TIMEOUT_MS,
	});
	const [out, logErr, logCode, idCode] = await Promise.all([
		new Response(patchId.stdout).text(),
		new Response(log.stderr).text(),
		log.exited,
		patchId.exited,
	]);
	if (logCode !== 0 || idCode !== 0) {
		throw new GitStepError(`git patch-id 실패(log ${logCode}, patch-id ${idCode}): ${logErr.trim().slice(0, 160)}`);
	}
	const ids = new Map<string, string>();
	for (const line of out.split("\n")) {
		const [id, commit] = line.trim().split(/\s+/);
		if (id !== undefined && commit !== undefined && id !== "") ids.set(commit, id);
	}
	return ids;
}

type Fit = { sha: string; rebase?: TaskLandRebase } | { handoff: string };

/**
 * The task branch made a fast-forward of the base branch (설계 3): as it is, or rebased in the task worktree with the
 * lost-change check and the evidence-hash refresh. Any miss after the rebase puts the worktree back at `OLD`.
 */
async function fitOnBase(git: GitRunner, row: TaskRow, baseBranch: string): Promise<Fit> {
	const { worktree, branch } = row;
	const baseRef = `refs/heads/${baseBranch}`;
	const branchRef = `refs/heads/${branch}`;
	if (await isAncestor(git, row.repo, baseRef, branchRef)) {
		return { sha: await must(git, ["-C", row.repo, "rev-parse", "--verify", `${branchRef}^{commit}`]) };
	}
	const oldSha = await must(git, ["-C", row.repo, "rev-parse", "--verify", `${branchRef}^{commit}`]);
	const oldBase = await must(git, ["-C", row.repo, "merge-base", baseRef, oldSha]);
	const rebased = await coreRebase(git, { worktree, branch, baseBranch });
	if (rebased.state === "missed") {
		const abort = rebased.abortFailed === undefined ? "" : ` — ${rebased.abortFailed}`;
		return { handoff: `rebase 실패(${rebased.why}): ${rebased.detail}${abort}` };
	}
	const back = async (reason: string): Promise<Fit> => {
		const reset = await git(["-C", worktree, "reset", "-q", "--hard", oldSha]);
		return { handoff: reset.code === 0 ? reason : `${reason} — OLD로 되돌리지 못함: ${failureLine(reset)}` };
	};
	try {
		const changed = async (from: string, to: string): Promise<Set<string>> => {
			const names = await must(git, ["-C", worktree, "diff", "--name-only", from, to, "--", ".", ":!docs/tasks"]);
			return new Set(names.split("\n").filter((name) => name !== ""));
		};
		const kept = await changed(baseRef, rebased.newSha);
		const lost = [...(await changed(oldBase, oldSha))].filter((name) => !kept.has(name));
		if (lost.length > 0) return await back(`rebase 뒤 변경 유실: ${shown(lost)}`);
		const refreshed = await refreshEvidence(git, row, baseRef, rebased.newSha);
		if ("unpaired" in refreshed) return await back(`해시 짝 없음: ${shown(refreshed.unpaired)}`);
		return { sha: refreshed.sha, rebase: { oldSha, newSha: refreshed.sha } };
	} catch (error) {
		return await back(`rebase 뒤 확인 실패: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Evidence hashes the rebase made stale (설계 3): tokens of outcome.md and PROGRESS.md that name a commit outside the
 * rebased branch are paired by stable patch id with a `base..NEW` commit and replaced by its sha cut to the same
 * length, then committed. Merges and empty commits have no patch id: they are neither pair candidates nor replaced.
 */
async function refreshEvidence(
	git: GitRunner,
	row: TaskRow,
	baseRef: string,
	newSha: string,
): Promise<{ sha: string } | { unpaired: string[] }> {
	const { worktree, taskId } = row;
	const dir = docsDirOf(worktree, taskId);
	const files = EVIDENCE_FILES.map((name) => {
		const path = `${dir}/${name}`;
		return { name, path, text: existsSync(path) ? readFileSync(path, "utf8") : undefined };
	});
	const stale = new Map<string, string>();
	const tokens = new Set(files.flatMap((file) => file.text?.match(HASH_TOKEN) ?? []));
	for (const token of tokens) {
		const commit = await git(["-C", worktree, "rev-parse", "--verify", "-q", `${token}^{commit}`]);
		if (commit.code !== 0) continue;
		const full = commit.stdout.trim();
		if (!(await isAncestor(git, worktree, full, newSha))) stale.set(token, full);
	}
	if (stale.size === 0) return { sha: newSha };
	const oldIds = await gitPatchIds(worktree, ["--no-walk", ...new Set(stale.values())]);
	const candidates = new Map<string, string>();
	for (const [commit, id] of await gitPatchIds(worktree, [`${baseRef}..${newSha}`])) {
		if (!candidates.has(id)) candidates.set(id, commit);
	}
	const replacements = new Map<string, string>();
	const unpaired: string[] = [];
	for (const [token, full] of stale) {
		const id = oldIds.get(full);
		if (id === undefined) continue;
		const pair = candidates.get(id);
		if (pair === undefined) unpaired.push(token);
		else replacements.set(token, pair.slice(0, token.length));
	}
	if (unpaired.length > 0) return { unpaired };
	const written: string[] = [];
	for (const file of files) {
		if (file.text === undefined) continue;
		const next = file.text.replace(HASH_TOKEN, (token) => replacements.get(token) ?? token);
		if (next === file.text) continue;
		writeFileSync(file.path, next);
		written.push(`docs/tasks/${taskId}/${file.name}`);
	}
	if (written.length === 0) return { sha: newSha };
	await must(git, ["-C", worktree, "add", "--", ...written]);
	await must(git, [
		"-C",
		worktree,
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"-m",
		`docs(task): ${taskId} rebase 뒤 증거 해시 갱신`,
	]);
	return { sha: await must(git, ["-C", worktree, "rev-parse", "--verify", "HEAD^{commit}"]) };
}

/** Why the fixed tip may not land after the re-judgement (설계 4); `undefined` = it may. */
async function rejudge(
	git: GitRunner,
	row: TaskRow,
	sha: string,
	judge: TaskLandDeps["judge"],
	mode: TaskLandDeps["mode"],
) {
	let evaluation: TaskEvaluation;
	try {
		evaluation = await judge(row);
	} catch (error) {
		evaluation = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!evaluation.ok) return `판정 오류: ${evaluation.error}`;
	const { problems, integrityWarnings } = evaluation.judgement;
	if (problems.length > 0) return `재판정 문제: ${problems[0]}`;
	// Risk L0 is only the lowest rung that exempts claim words: a button click exempts them at any risk.
	const holding = holdingIntegrityWarnings(mode === "button" ? "L0" : row.risk, integrityWarnings);
	if (holding.length > 0) return `무결성 경고: ${holding[0]}`;
	const tip = await git(["-C", row.repo, "rev-parse", "--verify", "-q", `refs/heads/${row.branch}^{commit}`]);
	if (tip.code !== 0 || tip.stdout.trim() !== sha) {
		return `검증 뒤 브랜치가 움직임(${sha.slice(0, 12)} → ${tip.stdout.trim().slice(0, 12) || "없음"})`;
	}
	return undefined;
}

/**
 * Lands one reached local task (설계 1–7). The caller serializes per task; the lander serializes per repository.
 * Never rejects: a git that cannot run is a `handoff`.
 */
export async function landTask(row: TaskRow, deps: TaskLandDeps): Promise<TaskLandResult> {
	const git = deps.git ?? defaultGit;
	let rebase: TaskLandRebase | undefined;
	try {
		const refused = await precondition(git, row);
		if (refused !== undefined) return handoff(refused);
		const baseBranch = await baseBranchOf(git, row.repo);
		if (baseBranch === undefined) return handoff("기준 브랜치(origin/HEAD·main·master)가 없음");
		// Once more after a `not-ff` landing: the base branch moved between the rebase and the merge.
		for (let attempt = 0; ; attempt++) {
			const fit = await fitOnBase(git, row, baseBranch);
			if ("handoff" in fit) return handoff(fit.handoff, rebase);
			if (fit.rebase !== undefined) rebase = { oldSha: rebase?.oldSha ?? fit.rebase.oldSha, newSha: fit.sha };
			const { sha } = fit;
			const judged = await rejudge(git, row, sha, deps.judge, deps.mode);
			if (judged !== undefined) return handoff(judged, rebase);
			const hold = deps.holdReason();
			if (hold !== undefined) return { state: "blocked", reason: clip(hold) };
			const landed = await deps.land({
				repo: row.repo,
				baseBranch,
				branch: row.branch,
				worktree: row.worktree,
				sha,
				push: true,
			});
			if (landed.state === "not-ff") {
				if (attempt === 0) continue;
				return handoff(`착지 중 다시 ff 불가: ${landed.reason}`, rebase);
			}
			if (landed.state === "blocked") return { state: "blocked", reason: clip(landed.reason) };
			const notes = landed.cleanup === undefined ? [] : [landed.cleanup];
			try {
				deps.ledger.transition(row.taskId, "done", "core-land", `코어 착지 ${baseBranch} ${sha.slice(0, 12)}`);
			} catch (error) {
				notes.push(clip(`원장 done 전이 실패: ${error instanceof Error ? error.message : String(error)}`));
			}
			notes.push(...(await deps.afterDone(row)));
			const done = { baseBranch, sha, ...(rebase === undefined ? {} : { rebase }), notes };
			return landed.state === "landed"
				? { state: "landed", ...done, ...(landed.pushed === undefined ? {} : { pushed: landed.pushed }) }
				: { state: "merged-not-pushed", ...done, reason: clip(landed.reason) };
		}
	} catch (error) {
		return handoff(`코어 착지 오류: ${error instanceof Error ? error.message : String(error)}`, rebase);
	}
}
