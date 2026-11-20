import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChannelRegistry } from "../channel/registry";
import { dispatchEnv, HERDR_INTERRUPT_WAIT_MS, type HerdrAgentStatusResult, type ProcessRunner } from "../dispatch/omp";
import { confidentBand } from "../lanes/land";
import { type LastAnswer, questionOf } from "../omp/session-tail";
import type { FreezeState } from "../ops/freeze";
import type { TaskCheckRunner } from "./check-runner";
import type { TaskJudgement } from "./checker";
import { digest, summarizeJudgement } from "./checker";
import { ledgerTaskChecks, type TaskCheckCache, type TaskEvaluation } from "./evaluate";
import type { TaskGateEnd, TaskGateHooks } from "./gate";
import type { TaskLandOutcome } from "./land";
import { type TaskLedger, type TaskRow, type TaskTransitionRow, taskPausedAt } from "./ledger";
import {
	type AutoLandPolicy,
	agyLimitLine,
	autoLandBlockers,
	buildAgentQuestionCard,
	buildAgentWaitingCard,
	buildAgyLimitCard,
	buildAutoLandCard,
	buildBlockedCard,
	buildLostCard,
	buildNudgeLimitCard,
	buildReachedCard,
	buildReviewWaitingCard,
	editThreadCard,
	formatReadFailureNotice,
	formatSpecChangedNotice,
	formatStaleNotice,
	formatWorkingSilentNotice,
	NO_EVIDENCE_LINE,
	NUDGE_MAX,
	postCardToThread,
	postToThread,
	type ReachedAutoLandNote,
	setStatusReaction,
	type TaskCard,
	type TaskChatLog,
	taskLandNote,
	unmetLines,
} from "./notify";
import { restatedHash } from "./resume-check";
import { agyModelOf } from "./worker-tier";

/** Sweep cadence of the daemon. */
export const TASK_SWEEP_MS = 60_000;
/** A remote task is judged at most this often (its reads take seconds over ssh), unless a check run just ended. */
export const REMOTE_JUDGE_MS = 5 * 60_000;
/** PROGRESS.md untouched this long → the agent gets a reminder (once per interval). */
export const STALE_REMIND_MS = 30 * 60_000;
/** ... and this long → the task thread is told once. */
export const STALE_NOTICE_MS = 2 * 60 * 60_000;
/**
 * A herdr-working agent gets no reminder, so a hung or looping worker would stay silent until the 2-hour notice: this
 * long without a PROGRESS.md update while working, the thread is told once earlier with the screen tail (dori `STALLED`).
 */
export const WORKING_SILENT_NOTICE_MS = 45 * 60_000;
/** A task left in review this long is brought up to the owner again, once per interval. */
export const REVIEW_REALERT_MS = 24 * 60 * 60_000;
/** A task unreadable this long (since its first failed read) tells the thread once. */
export const READ_FAILURE_NOTICE_MS = 15 * 60_000;
const NUDGE_HEAD =
	"Outcome 판정이 아직 미도달입니다. 아래를 채우거나, 진행할 수 없으면 PROGRESS.md status를 blocked로 바꾸고 사유를 적으세요.";
/** The prompt a block gets once before it reaches the owner (the worker's `blocked_reason` follows as one line). */
export const BLOCK_RETRY_HEAD =
	"막힘으로 보고하기 전에 한 번 더: 지금까지와 다른 접근을 하나 이상 시도하라. 풀리면 `status: working`으로 돌려 이어 가라. 그래도 막히면 시도한 것 2가지와 결과를 `blocked_reason`에 적고 `updated`를 고친 뒤 멈춰라. 승인·자격증명·실계정·오너만 정할 범위 선택이 원인이면 시도하지 말고 `needs_owner: yes`를 쓰고 `updated`를 고쳐라.";
/** Sent once per block and HEAD when every `[check: …]` passes while PROGRESS still says blocked. */
export const BLOCKED_CHECKS_PASS_HEAD =
	"ompbot이 이 HEAD에서 수락기준 `[check: …]`를 다시 돌렸고 모두 통과했다. 막힌 원인이 검사 환경(명령을 못 찾음 등)이었다면 해소됐으니 PROGRESS.md를 `status: working`(끝났으면 완료 상태)으로 돌리고 `updated`를 고쳐 docs만 커밋하라. 다른 이유로 막혔다면 그대로 두라.";
/** Retry prompts per resume window (since the latest resume, else the registration); a block past it goes to the owner. */
export const BLOCK_RETRY_MAX = 3;
/** After a retry prompt a block still standing this long goes to the owner, whatever herdr says. */
export const BLOCK_RETRY_WAIT_MS = 30 * 60_000;

/** A task's own docs never count as a file overlap: every task writes its own `docs/tasks/<ID>/`. */
const TASK_DOCS_PREFIX = "docs/tasks/";
/** Shared paths an overlap notice names before it counts the rest. */
const OVERLAP_PATHS_SHOWN = 5;

/** `git -C <worktree> …` for the sweep's read-only questions: stdout, or `undefined` on a failure or timeout. */
const worktreeGit =
	(worktree: string, run: ProcessRunner) =>
	async (...args: string[]): Promise<string | undefined> => {
		const result = await run(["git", "-C", worktree, ...args], {
			timeoutMs: 10_000,
			stdoutCap: 1_000_000,
			env: dispatchEnv(process.env),
		});
		return result.code === 0 && !result.timedOut ? result.stdout : undefined;
	};

/**
 * Files a local task worktree changes against its base: the branch diff since the merge base plus uncommitted and
 * untracked files, `docs/tasks/**` left out, sorted. The base is `origin/HEAD`, else `main`, else `master`.
 */
export async function taskChangedPaths(
	worktree: string,
	run: ProcessRunner,
): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
	const git = worktreeGit(worktree, run);
	let base = (await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD"))?.trim();
	for (const candidate of ["main", "master"]) {
		if (base !== undefined) break;
		if ((await git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`)) !== undefined) base = candidate;
	}
	if (base === undefined) return { ok: false, reason: "no_base_branch" };
	const mergeBase = (await git("merge-base", base, "HEAD"))?.trim();
	if (mergeBase === undefined) return { ok: false, reason: "merge_base_failed" };
	const diff = await git("diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", mergeBase);
	if (diff === undefined) return { ok: false, reason: "diff_failed" };
	const status = await git("status", "--porcelain", "-z", "--untracked-files=all");
	if (status === undefined) return { ok: false, reason: "status_failed" };
	const paths = new Set(diff.split("\0").filter((path) => path !== ""));
	// `XY path` records; a rename or copy is followed by its source path as its own record.
	const records = status.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record === "") continue;
		paths.add(record.slice(3));
		if (record[0] === "R" || record[0] === "C") {
			i += 1;
			const source = records[i];
			if (source) paths.add(source);
		}
	}
	return { ok: true, paths: [...paths].filter((path) => !path.startsWith(TASK_DOCS_PREFIX)).sort() };
}

/** The task's own PROGRESS.md: its content counts as evidence, but only the part other than the `updated` line. */
const progressPathOf = (taskId: string): string => `docs/tasks/${taskId}/PROGRESS.md`;

/** PROGRESS.md text without its `updated` line: a worker that only rewrote the clock moved nothing else. */
export function progressWithoutUpdated(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^\s*updated:/.test(line))
		.join("\n");
}

/**
 * A local task's progress evidence: one hash over what moved in its worktree since the last sweep - `HEAD`, the
 * uncommitted diff, the untracked files' paths·sizes·mtimes, and PROGRESS.md without its `updated` line. A worker
 * that rewrites only `updated` leaves the key unchanged, so the stale clock is not pushed back by it
 * (doc/plans/task-progress-evidence.md). `ok: false` when the worktree cannot be read (remote task, no worktree, a
 * git failure): the caller then keeps the old time-based behavior.
 */
export async function taskProgressEvidence(
	worktree: string,
	taskId: string,
	run: ProcessRunner,
): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
	const progressPath = progressPathOf(taskId);
	const git = worktreeGit(worktree, run);
	const head = (await git("rev-parse", "HEAD"))?.trim();
	if (head === undefined) return { ok: false, reason: "no_head" };
	// The whole diff, so that a change to a file's content alone moves the key even with the path unchanged.
	const diff = await git("diff", "HEAD", "--no-ext-diff", "--no-textconv", "--", ".", `:(exclude)${progressPath}`);
	if (diff === undefined) return { ok: false, reason: "diff_failed" };
	const untracked = await git("ls-files", "--others", "--exclude-standard", "-z");
	if (untracked === undefined) return { ok: false, reason: "untracked_failed" };
	// PROGRESS.md is left out here (its mtime moves with every write), counted through its content below instead.
	const files = untracked
		.split("\0")
		.filter((path) => path !== "" && path !== progressPath)
		.sort()
		.map((path) => {
			try {
				const stat = statSync(join(worktree, path));
				return `${path}\t${stat.size}\t${Math.floor(stat.mtimeMs)}`;
			} catch {
				return path;
			}
		});
	let body: string;
	try {
		body = progressWithoutUpdated(readFileSync(join(worktree, progressPath), "utf8"));
	} catch {
		// No PROGRESS.md yet: HEAD, the diff and the untracked files are all the evidence there is.
		body = "";
	}
	const key = createHash("sha256")
		.update([head, diff, files.join("\n"), body].join("\0"))
		.digest("hex");
	return { ok: true, key };
}

/** Where the nudge count starts: the latest `resume:<ms>` mark of `resumeTask`, else the registration. */
function nudgeBase(row: TaskRow): number {
	const resumes = Object.keys(row.notices)
		.filter((key) => key.startsWith("resume:"))
		.map((key) => Number(key.slice("resume:".length)))
		.filter((at) => Number.isFinite(at));
	return Math.max(row.createdAt, ...resumes);
}

/**
 * When the task was last resumed: the latest `resume:<ms>` mark of `resumeTask`, or a `resume dispatch` transition of
 * the ledger (resumes marked before the marks existed); `undefined` for a task never resumed.
 */
function lastResumeAt(row: TaskRow, history: readonly TaskTransitionRow[]): number | undefined {
	const resumes = [
		...Object.keys(row.notices)
			.filter((key) => key.startsWith("resume:"))
			.map((key) => Number(key.slice("resume:".length)))
			.filter((at) => Number.isFinite(at)),
		...history.filter((entry) => entry.reason === "resume dispatch").map((entry) => entry.at),
	];
	return resumes.length === 0 ? undefined : Math.max(...resumes);
}

/** An agy limit block since `nudgeBase` (the latest resume, else the registration): no prompt goes to the worker. */
function agyLimitHeld(row: TaskRow): boolean {
	const since = nudgeBase(row);
	return Object.entries(row.notices).some(([key, at]) => key.startsWith("agylimit:") && at >= since);
}

/** Unmet-condition nudges recorded since `nudgeBase`. */
function nudgesSince(row: TaskRow): number {
	const since = nudgeBase(row);
	return Object.entries(row.notices).filter(([key, at]) => key.startsWith("unmet:") && at >= since).length;
}

/** The `<ms>` of every `blockretry:<ms>` mark (one per retry prompt, sent or not). */
function blockRetryMarks(row: TaskRow): number[] {
	return Object.keys(row.notices)
		.filter((key) => key.startsWith("blockretry:"))
		.map((key) => Number(key.slice("blockretry:".length)))
		.filter((at) => Number.isFinite(at));
}

/** Retry prompts since `nudgeBase` (the latest resume, else the registration). */
function blockRetriesSince(row: TaskRow): number {
	const since = nudgeBase(row);
	return blockRetryMarks(row).filter((at) => at >= since).length;
}

/**
 * The retry prompt the current block is waiting on: the latest `blockretry:<ms>` without its `blockcleared:<ms>` and
 * with no working → blocked move since (the card went up); `undefined` when there is none.
 */
function pendingBlockRetry(row: TaskRow, history: readonly TaskTransitionRow[]): number | undefined {
	const marks = blockRetryMarks(row);
	if (marks.length === 0) return undefined;
	const latest = Math.max(...marks);
	if (`blockcleared:${latest}` in row.notices) return undefined;
	const carded = history.some(
		(entry) => entry.fromStatus === "working" && entry.toStatus === "blocked" && entry.at >= latest,
	);
	return carded ? undefined : latest;
}

export interface TaskSweepDeps {
	ledger: TaskLedger;
	/** Judges a task; `checks` is the sweeper's check-result cache, to hand to `evaluateTask` so checks run. */
	evaluate(row: TaskRow, checks: TaskCheckCache): Promise<TaskEvaluation>;
	/** Freeze switch (`<home>/FROZEN`): while it returns a state no reminder is sent to the agent. */
	frozen?: () => FreezeState | undefined;
	/**
	 * Sends a prompt to the task's herdr agent. `unconfirmed`: herdr took the prompt but saw no start (it may have
	 * landed), so the sweep counts it as sent rather than repeating it next sweep.
	 */
	remind(row: TaskRow, text: string): Promise<{ ok: boolean; error?: string; unconfirmed?: boolean }>;
	/** What herdr says the task's agent is doing: working/blocked defer the reminder, gone posts the LOST notice. */
	agentStatus(row: TaskRow): Promise<HerdrAgentStatusResult>;
	/** The agent's screen tail (`herdr agent read`), read only for a wait notice that is about to be posted. */
	readAgent(row: TaskRow): Promise<{ ok: boolean; output?: string; error?: string }>;
	/**
	 * The last assistant answer in the agent's omp session file (herdr's `sessionPath`), asked only while herdr says
	 * idle or done, once per task per sweep: `undefined` when none is within the byte cap; throws when the file cannot
	 * be read. Absent = no question check.
	 */
	lastAnswer?(row: TaskRow, sessionPath: string): Promise<LastAnswer | undefined>;
	channels: ChannelRegistry;
	/** The daemon's check queue: told each sweep which tasks still count, so a closed task's checks are cancelled. */
	checkRunner?: Pick<TaskCheckRunner, "retain">;
	/** The task's herdr board card link for the reached/blocked/stale notices; absent → no board footer. */
	boardLink?(row: TaskRow): Promise<string | undefined>;
	/** The dashboard's diff view of the task for the reached card; absent or undefined → no `변경 보기:` line. */
	diffLink?(row: TaskRow): string | undefined;
	/** Live `taskAutoLand` (maxRisk defaulted); `undefined` (or absent) → every reached task gets the 머지 question. */
	autoLandPolicy?(): AutoLandPolicy | undefined;
	/** Whether a local task's repository shares its git common directory with one of `repos`. Never asked for a remote task. */
	repoMatches?(row: TaskRow, repos: readonly string[]): Promise<boolean>;
	/**
	 * Files a local task changes (`taskChangedPaths`), for the overlap check between active tasks of one repository;
	 * `undefined` leaves the task out of this sweep's check. Never asked for a remote task. Absent = no overlap check.
	 */
	changedPaths?(row: TaskRow): Promise<string[] | undefined>;
	/**
	 * The task worktree's progress evidence (`taskProgressEvidence`), compared between `updated` values so that a
	 * rewrite of the clock alone does not count as progress. `undefined` = no evidence readable (remote task, no
	 * worktree, a git failure): the `updated` then counts as before. Absent = time-based behavior for every task.
	 */
	progressEvidence?(row: TaskRow): Promise<string | undefined>;
	/**
	 * Lands the task through the core, or hands it to the thread as "머지해" (`Daemon.autoLand`); what it came to. A task
	 * in the confident band gets `gate`: the review·QA gate runs first and reports through it (`gating`, `held`).
	 */
	autoLand?(row: TaskRow, gate?: TaskGateHooks): Promise<TaskLandOutcome>;
	/** Whether a review task's gate was cut off (a restart) before its receipts: the sweep starts it again. */
	gatePending?(row: TaskRow): Promise<boolean>;
	/** Why auto-merge is held after an apply code rollback (`<home>/autoland.hold`); undefined = not held. */
	autoLandHold?(): string | undefined;
	/** `false` while the daemon cannot land (draining, unstarted): a reach then waits for the next sweep, without a card. */
	autoLandReady?(): boolean;
	ownerUserId: string;
	now(): number;
	log: TaskChatLog & { info(event: string, fields?: Record<string, unknown>): void };
}

/** What one check did, for the CLI (`tasks check`). */
export interface TaskCheckResult {
	taskId: string;
	status: TaskRow["status"];
	read: boolean;
	summary: string;
	judgement?: TaskJudgement;
	/** Human-readable list of the side effects this check had (posts, reaction swaps, reminders). */
	actions: string[];
	error?: string;
}

/**
 * The [TASK] sweep: files and git only, never an LLM. Each notice kind is posted at most once per key (the ledger
 * records the key before the post, so a repeated sweep over the same state stays silent), the single status
 * reaction on the thread root follows the registry status, and the bot can only move working ⇄ blocked/review.
 */
export class TaskSweeper {
	readonly #deps: TaskSweepDeps;
	/** When each remote task was last judged (in memory: a restart judges once at once). */
	readonly #remoteJudgedAt = new Map<string, number>();
	/** Consecutive read failures per task (in memory: a restart only delays the alert). */
	readonly #failures = new Map<string, { count: number; since: number }>();
	/** Last `updated` value read from each task's PROGRESS.md (in memory: a restart re-reads it once). */
	readonly #seenUpdated = new Map<string, number>();
	/** Progress evidence hash last seen for each task (in memory: a restart only takes a new baseline). */
	readonly #seenEvidence = new Map<string, string>();
	/**
	 * The `updated` value whose new reading came with no new evidence: a reminder or notice for that time says so.
	 * Holds one value per task (the latest ignored one): a later `updated` with evidence clears it.
	 */
	readonly #noEvidenceUpdated = new Map<string, number>();
	/** Tasks whose evidence read threw in this run (in memory): one `task_progress_evidence_failed` per task. */
	readonly #evidenceFailing = new Set<string>();
	/** Tasks whose held reminder was already logged during the current freeze (one `task_remind_frozen` per freeze). */
	readonly #remindHeld = new Set<string>();
	/** `<task>:<pausedAt>` of the owner pauses already logged as holding a prompt (one `task_remind_paused` per pause). */
	readonly #pauseLogged = new Set<string>();
	/** `[check: …]` results per task HEAD, kept in the ledger (a restart does not run them again). */
	readonly #checks: TaskCheckCache;
	/**
	 * When each task's agent was first seen herdr-`blocked` in its current wait (in memory: a restart may tell the
	 * owner once more about a wait that is still going on). The wait notice is keyed by it.
	 */
	readonly #waitingSince = new Map<string, number>();
	/** Tasks whose agent was sent a prompt in the current sweep: at most one prompt per agent per sweep. */
	readonly #prompted = new Set<string>();
	/** herdr status read for each task in the current sweep, shared by the reminder and the overlap prompt. */
	readonly #sweepAgents = new Map<string, HerdrAgentStatusResult>();
	/** The prose question each task's idle/done agent stopped on in the current sweep (no entry: none, or unknown). */
	readonly #sweepQuestions = new Map<string, string>();
	/** Tasks whose last session read failed (in memory): one `task_question_read_failed` per run of failures. */
	readonly #questionReadFailing = new Set<string>();

	constructor(deps: TaskSweepDeps) {
		this.#deps = deps;
		this.#checks = ledgerTaskChecks(deps.ledger);
	}

	/**
	 * One pass over every working or blocked task, then over the tasks left in review (a reminder to the owner only).
	 * A task that throws never stops the others.
	 */
	async sweep(due: ReadonlySet<string> = new Set()): Promise<TaskCheckResult[]> {
		const results: TaskCheckResult[] = [];
		const judged = new Set<string>();
		const startedAt = this.#deps.now();
		let skippedRemote = 0;
		this.#prompted.clear();
		this.#sweepAgents.clear();
		this.#sweepQuestions.clear();
		const active = this.#deps.ledger.listActive();
		this.#deps.checkRunner?.retain(new Set([...active, ...this.#deps.ledger.listInReview()].map((row) => row.taskId)));
		for (const row of active) {
			judged.add(row.taskId);
			const lastRemote = this.#remoteJudgedAt.get(row.taskId);
			if (
				row.host !== null &&
				!due.has(row.taskId) &&
				lastRemote !== undefined &&
				startedAt - lastRemote < REMOTE_JUDGE_MS
			) {
				skippedRemote += 1;
				continue;
			}
			if (row.host !== null) this.#remoteJudgedAt.set(row.taskId, startedAt);
			try {
				results.push(await this.check(row));
			} catch (error) {
				this.#deps.log.warn("task_sweep_failed", { task: row.taskId, error: String(error) });
			}
		}
		try {
			await this.#overlaps();
		} catch (error) {
			this.#deps.log.warn("task_overlap_failed", { error: String(error) });
		}
		for (const row of this.#deps.ledger.listInReview()) {
			if (judged.has(row.taskId)) continue; // reached in this very pass
			try {
				results.push(await this.#reviewWaiting(row));
			} catch (error) {
				this.#deps.log.warn("task_sweep_failed", { task: row.taskId, error: String(error) });
			}
		}
		this.#deps.log.info("task_sweep_done", {
			ms: this.#deps.now() - startedAt,
			judged: results.length,
			skippedRemote,
		});
		return results;
	}

	/**
	 * A review task is not judged again (no evaluate, no herdr): it only tells the owner once per full day it has waited
	 * since its last move to review. Not held by a freeze — the notice is for the owner.
	 */
	async #reviewWaiting(row: TaskRow): Promise<TaskCheckResult> {
		const { ledger } = this.#deps;
		await this.#resumeGate(row);
		const entry = ledger.history(row.taskId).findLast((item) => item.toStatus === "review");
		const since = entry?.at ?? row.updatedAt;
		const waited = this.#deps.now() - since;
		const hours = Math.max(0, Math.floor(waited / 3_600_000));
		const days = Math.floor(waited / REVIEW_REALERT_MS);
		const actions: string[] = [];
		if (days >= 1 && ledger.recordNotice(row.taskId, `review:${entry?.transitionId ?? 0}:${days}`)) {
			await this.#post(row, buildReviewWaitingCard(row, hours, this.#deps.ownerUserId, await this.#boardLink(row)));
			actions.push("review re-alert");
		}
		return { taskId: row.taskId, status: row.status, read: true, summary: `리뷰 대기 ${hours}시간`, actions };
	}

	/** Re-applies the single status reaction of a task (after a human `close`). */
	async syncReaction(taskId: string): Promise<boolean> {
		const row = this.#deps.ledger.get(taskId);
		if (row === undefined) return false;
		await setStatusReaction(this.#deps.channels, this.#deps.log, row.threadRef, row.status);
		return true;
	}

	/** Judges one task and applies the sweep's rules to it. */
	async check(row: TaskRow): Promise<TaskCheckResult> {
		const { ledger, log } = this.#deps;
		const now = this.#deps.now();
		const actions: string[] = [];
		let evaluation: TaskEvaluation;
		try {
			evaluation = await this.#deps.evaluate(row, this.#checks);
		} catch (error) {
			evaluation = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}

		if (!evaluation.ok) {
			const streak = this.#failures.get(row.taskId) ?? { count: 0, since: now };
			streak.count += 1;
			this.#failures.set(row.taskId, streak);
			log.warn("task_read_failed", { task: row.taskId, count: streak.count, error: evaluation.error });
			if (now - streak.since >= READ_FAILURE_NOTICE_MS && ledger.recordNotice(row.taskId, `readfail:${streak.since}`)) {
				await this.#post(row, formatReadFailureNotice(row, streak.count, evaluation.error));
				actions.push("read-failure notice");
			}
			return {
				taskId: row.taskId,
				status: row.status,
				read: false,
				summary: `판정 읽기 실패: ${evaluation.error}`,
				actions,
				error: evaluation.error,
			};
		}
		this.#failures.delete(row.taskId);
		const judgement = evaluation.judgement;

		const written = judgement.updatedAtMs;
		if (written !== undefined && written !== this.#seenUpdated.get(row.taskId)) {
			// Each written `updated` counts once, when first seen. A time later than the real one counts as now —
			// otherwise it would push the stale reminder back by the difference, then again once the clock passes it.
			this.#seenUpdated.set(row.taskId, written);
			let progressAt = written;
			if (written > now) {
				log.warn("task_updated_future", { task: row.taskId, updatedAtMs: written, now });
				progressAt = now;
			}
			// A new `updated` counts as progress only when the worktree moved with it: rewriting PROGRESS.md's clock
			// alone used to buy a fresh 30 minutes (doc/plans/task-progress-evidence.md). An unreadable worktree
			// (remote task, no git) keeps the old time-based rule, and so does the first `updated` of a run.
			const evidence = await this.#progressEvidence(row);
			const seen = evidence === undefined ? undefined : this.#seenEvidence.get(row.taskId);
			if (evidence !== undefined) this.#seenEvidence.set(row.taskId, evidence);
			if (evidence !== undefined && seen !== undefined && seen === evidence) {
				this.#noEvidenceUpdated.set(row.taskId, written);
				log.info("task_progress_no_evidence", { task: row.taskId, updatedAtMs: written });
			} else {
				this.#noEvidenceUpdated.delete(row.taskId);
				if (progressAt > (row.progressAt ?? 0)) ledger.setProgressAt(row.taskId, progressAt);
			}
		}
		await this.#restated(row, judgement, actions);
		if (judgement.specChanged && ledger.recordNotice(row.taskId, `spec:${judgement.specKey}`)) {
			await this.#post(row, formatSpecChangedNotice(row));
			actions.push("spec-change warning");
		}

		let status = row.status;
		const retry = pendingBlockRetry(ledger.require(row.taskId), ledger.history(row.taskId));
		if (!judgement.blocked && retry !== undefined) {
			// The agent got past the block on its own after the retry prompt: that block ends here, without a card.
			ledger.recordNotice(row.taskId, `blockcleared:${retry}`);
			actions.push("block cleared after retry");
		}
		if (judgement.blocked) {
			const step = await this.#blockRetryStep(row, judgement, status, retry, now, actions);
			if (step === "hold") return this.#result(row, status, judgement, actions);
			if (status === "working") {
				ledger.transition(row.taskId, "blocked", "bot", judgement.blockedReason || "PROGRESS status: blocked");
				status = "blocked";
				await setStatusReaction(this.#deps.channels, log, row.threadRef, "blocked");
				actions.push("working → blocked, 🚧");
			}
			// Keyed by the block itself (its working → blocked transition): a resume and a new block report again,
			// even for the same reason; repeated sweeps over one block stay silent.
			const since = ledger.history(row.taskId).findLast((entry) => entry.toStatus === "blocked")?.transitionId ?? 0;
			if (ledger.recordNotice(row.taskId, `blocked:${since}:${judgement.blockedReason}`)) {
				await this.#post(
					row,
					buildBlockedCard(row, judgement, this.#deps.ownerUserId, await this.#boardLink(row), step === "retried"),
				);
				actions.push("blocked notice");
			}
			const passHead = judgement.blockedChecksPassHead;
			// A frozen bot or an owner-paused task sends the agent nothing and marks nothing: the prompt goes out once,
			// on the first sweep after the unfreeze or the unpause.
			const held =
				this.#deps.frozen?.() !== undefined
					? "frozen"
					: ledger.isPaused(ledger.require(row.taskId))
						? "paused"
						: undefined;
			if (passHead !== undefined && held !== undefined) {
				actions.push(`checks pass while blocked, held (${held})`);
				return this.#result(row, status, judgement, actions);
			}
			// Marked before it goes out, like the retry prompt: a failed send is not repeated for this block and HEAD.
			if (passHead !== undefined && ledger.recordNotice(row.taskId, `blockedcheckspass:${since}:${passHead}`)) {
				const sent = await this.#remind(row, BLOCKED_CHECKS_PASS_HEAD);
				actions.push(sent ? "checks pass while blocked, told agent" : "checks-pass prompt failed");
			}
			return this.#result(row, status, judgement, actions);
		}
		// An agy limit block holds until a resume: PROGRESS still says working, so it must not undo the block.
		if (status === "blocked" && !judgement.reached && agyLimitHeld(ledger.require(row.taskId))) {
			actions.push("agy limit held");
			return this.#result(row, status, judgement, actions);
		}
		if (status === "blocked") {
			ledger.transition(row.taskId, "working", "bot", "PROGRESS status: working");
			status = "working";
			await setStatusReaction(this.#deps.channels, log, row.threadRef, "working");
			actions.push("blocked → working, ⏳");
		}

		if (judgement.reached) {
			// A daemon that cannot land now (a restart's drain) leaves the reach to the next sweep: nothing to ask the owner.
			if (this.#deps.autoLandPolicy?.() !== undefined && this.#deps.autoLandReady?.() === false) {
				log.info("task_reach_deferred", { task: row.taskId, reason: "not_ready" });
				return this.#result(row, status, judgement, actions);
			}
			// The reviewed row, not the swept one: the core landing behind `autoLand` refuses a task not in review.
			const reviewed = ledger.transition(
				row.taskId,
				"review",
				"bot",
				`outcome reached AC ${judgement.acChecked}/${judgement.acTotal}`,
			);
			status = "review";
			await setStatusReaction(this.#deps.channels, log, row.threadRef, "review");
			actions.push("working → review, 🔍");
			if (ledger.recordNotice(row.taskId, `reached:${judgement.reachKey}`)) {
				await this.#reachedNotice(reviewed, judgement, actions);
			}
			return this.#result(row, status, judgement, actions);
		}

		// An agy worker is asked about first, once: a limit on its screen stops every prompt below.
		const agyAgent = agyModelOf(row.workerModel) === undefined ? undefined : await this.#agentStatus(row);
		if (agyAgent !== undefined && (await this.#agyLimit(row, agyAgent, actions)))
			return this.#result(row, "blocked", judgement, actions);
		await this.#staleness(row, now, actions, judgement, agyAgent);
		return this.#result(row, status, judgement, actions);
	}

	/**
	 * An agy worker's limit (doc/plans/agy-task-worker.md 6): when herdr says it stopped (idle, done, unknown) or cannot
	 * say (a reminder could go out next), its screen tail is read. A limit line there blocks the task with one owner card
	 * per line per resume window and stops the prompts (true). An unreadable screen leaves the flow as it is (logged).
	 */
	async #agyLimit(row: TaskRow, agent: HerdrAgentStatusResult, actions: string[]): Promise<boolean> {
		const { ledger, log } = this.#deps;
		const status = agent.ok ? agent.status : undefined;
		if (status === "working" || status === "blocked" || status === "gone") return false;
		const screen = await this.#readAgent(row);
		if (!screen.ok) {
			log.info("task_agy_screen_read_failed", { task: row.taskId, error: screen.error ?? "unknown" });
			return false;
		}
		const line = agyLimitLine(screen.output ?? "");
		if (line === undefined) return false;
		const fresh = ledger.require(row.taskId);
		if (fresh.status === "working") {
			ledger.transition(row.taskId, "blocked", "bot", "agy 한도");
			await setStatusReaction(this.#deps.channels, log, row.threadRef, "blocked");
			actions.push("working → blocked (agy 한도), 🚧");
		}
		if (ledger.recordNotice(row.taskId, `agylimit:${digest([String(nudgeBase(fresh)), line])}`)) {
			await this.#post(row, buildAgyLimitCard(row, line, this.#deps.ownerUserId, await this.#boardLink(row)));
			actions.push("agy limit notice");
		}
		return true;
	}

	/**
	 * The agent's `restated` line (task / first next / done condition, written first on a resume) goes to the thread
	 * once per value. Unlike the other notices it is recorded only after the post went out, so a failed post is tried
	 * again on the next sweep. A resume after which PROGRESS.md moved on with `restated` empty or as it was before the
	 * resume (`restated-before:<resume ms>:<hash>`, kept by `resumeTask`) is told once.
	 */
	async #restated(row: TaskRow, judgement: TaskJudgement, actions: string[]): Promise<void> {
		const { ledger, log } = this.#deps;
		const { restated } = judgement;
		const posted = `restated:${restatedHash(restated)}`;
		if (restated !== "" && !(posted in ledger.require(row.taskId).notices)) {
			if (await this.#post(row, `🔁 재개 이해: ${restated}`)) {
				ledger.recordNotice(row.taskId, posted);
				actions.push("restated posted");
			} else {
				log.warn("task_restated_post_failed", { task: row.taskId, error: "post failed (see task_post_failed)" });
			}
		}
		const fresh = ledger.require(row.taskId);
		const resumedAt = lastResumeAt(fresh, ledger.history(row.taskId));
		if (resumedAt === undefined || judgement.updatedAtMs === undefined || judgement.updatedAtMs <= resumedAt) return;
		const beforePrefix = `restated-before:${resumedAt}:`;
		const before = Object.keys(fresh.notices)
			.find((key) => key.startsWith(beforePrefix))
			?.slice(beforePrefix.length);
		const unchanged = restated === "" || before === restatedHash(restated);
		if (unchanged && ledger.recordNotice(row.taskId, `restated-missing:${resumedAt}`)) {
			await this.#post(row, "⚠️ 재개 뒤 PROGRESS는 갱신됐지만 재개 이해(restated)가 없습니다");
			actions.push("restated missing notice");
		}
	}

	/**
	 * The one card of a reach (its `reached:<reachKey>` notice key is already recorded, so a repeat sweep never gets
	 * here). With `taskAutoLand` on and nothing in the way, the landing runs first (`autoLand`: the core's landing, or
	 * "머지해" for the model turn on a handoff) and the card reports what it came to; a skipped, blocked or failed
	 * auto-merge leaves today's 머지 question with one line saying why.
	 */
	async #reachedNotice(row: TaskRow, judgement: TaskJudgement, actions: string[]): Promise<void> {
		const { log, ownerUserId } = this.#deps;
		const policy = this.#deps.autoLandPolicy?.();
		const link = await this.#boardLink(row);
		if (policy === undefined || this.#deps.autoLand === undefined) {
			await this.#post(row, this.#reached(row, judgement, ownerUserId, link));
			actions.push("Outcome notice");
			return;
		}
		// A remote task's repo path means nothing to the local git, so it is never looked up.
		const repoMatched = row.host === null && (await this.#repoMatches(row, policy.repos));
		// After an apply reverted the code, the commit that broke the daemon must not be merged again unasked.
		const hold = this.#deps.autoLandHold?.();
		if (hold !== undefined) log.info("task_autoland_held", { task: row.taskId, reason: hold });
		// A freeze stops every autonomous action, and merging unasked is one: the owner is asked instead. So does an
		// owner pause of this one task.
		const held = [
			...(hold === undefined ? [] : [`autoland.hold: ${hold}`]),
			...(this.#deps.frozen?.() === undefined ? [] : ["동결 중"]),
			// Re-read: the owner may have paused it while this sweep judged (the checks can take minutes).
			...(this.#deps.ledger.isPaused(this.#deps.ledger.require(row.taskId)) ? ["멈춤 중"] : []),
		];
		// A task in the confident band is judged without the gate's receipts first: only one the gate alone holds back
		// reaches `autoLand`, whose gate then runs review → QA → landing (doc/plans/task-review-qa-gate.md 설계 4).
		const band = confidentBand(row.risk, policy);
		const ungated =
			band === undefined
				? policy
				: {
						repos: policy.repos,
						maxRisk: band.maxRisk,
					};
		if ([...held, ...autoLandBlockers(row, judgement, ungated, repoMatched)].length > 0) {
			const blockers = [...held, ...autoLandBlockers(row, judgement, policy, repoMatched)];
			log.info("task_autoland_skipped", { task: row.taskId, reasons: blockers.join(" · ") });
			await this.#post(row, this.#reached(row, judgement, ownerUserId, link, { kind: "skipped", reasons: blockers }));
			actions.push("Outcome notice (auto-merge skipped)");
			return;
		}
		let outcome: TaskLandOutcome = { state: "not_accepted" };
		const gate = band === undefined ? undefined : this.#gateHooks(row, judgement, link, true);
		try {
			outcome = await this.#deps.autoLand(row, gate);
			if (outcome.state === "not_accepted")
				log.warn("task_autoland_failed", { task: row.taskId, error: "not_accepted" });
		} catch (error) {
			log.warn("task_autoland_failed", { task: row.taskId, error: String(error) });
		}
		// One card per reach, by what the landing came to.
		if (outcome.state === "not_accepted") {
			await this.#post(row, this.#reached(row, judgement, ownerUserId, link, { kind: "failed" }));
			actions.push("Outcome notice (auto-merge failed)");
			return;
		}
		if (outcome.state === "gating") {
			actions.push("Outcome notice (gate running)");
			return;
		}
		if (outcome.state === "held") {
			log.info("task_autoland_skipped", { task: row.taskId, reasons: outcome.reasons.join(" · ") });
			const card = {
				kind: "skipped" as const,
				reasons: outcome.reasons,
				gate: this.#deps.ledger.require(row.taskId).gate,
			};
			await this.#post(row, this.#reached(row, judgement, ownerUserId, link, card));
			actions.push("Outcome notice (gate held)");
			return;
		}
		if (outcome.state === "blocked") {
			const reasons = [taskLandNote(outcome)];
			await this.#post(row, this.#reached(row, judgement, ownerUserId, link, { kind: "skipped", reasons }));
			actions.push("Outcome notice (auto-merge blocked)");
			return;
		}
		await this.#post(row, buildAutoLandCard(row, judgement, outcome, link));
		actions.push(`auto-merge ${outcome.state}`);
	}

	/**
	 * The gate's card hooks: the running card (only on the reach; a restarted gate posts none), and its end — a landing
	 * redraws the running card as the auto-merge card (or posts it), a hold redraws it with the receipts and posts one
	 * reached card naming the reasons with the owner mention.
	 */
	#gateHooks(row: TaskRow, judgement: TaskJudgement, link: string | undefined, onReach: boolean): TaskGateHooks {
		const { channels, log, ownerUserId } = this.#deps;
		return {
			judgement,
			gating: () =>
				onReach
					? postCardToThread(
							channels,
							log,
							row.threadRef,
							this.#reached(row, judgement, ownerUserId, link, { kind: "gating" }),
						)
					: Promise.resolve(undefined),
			ended: async (end: TaskGateEnd, card) => {
				const landed = end.landed;
				if (
					end.blockers.length === 0 &&
					landed !== undefined &&
					(landed.state === "landed" ||
						landed.state === "merged-not-pushed" ||
						landed.state === "handoff" ||
						landed.state === "in_flight")
				) {
					const done = buildAutoLandCard(row, judgement, landed, link, end.gate);
					if (card === undefined || !(await editThreadCard(channels, log, card, { ...done, buttons: [] }))) {
						await this.#post(row, done);
					}
					return;
				}
				const reasons = end.blockers.length > 0 ? end.blockers : landed === undefined ? [] : [taskLandNote(landed)];
				log.info("task_autoland_skipped", { task: row.taskId, reasons: reasons.join(" · ") });
				if (card !== undefined) {
					const gated = this.#reached(row, judgement, ownerUserId, link, { kind: "gated", gate: end.gate });
					await editThreadCard(channels, log, card, gated);
				}
				await this.#post(
					row,
					this.#reached(row, judgement, ownerUserId, link, { kind: "skipped", reasons, gate: end.gate }),
				);
			},
		};
	}

	/**
	 * A review task whose gate a restart cut off before its receipts (`gatePending`) is judged again — the checks run
	 * again for its subject — and its gate restarted, unless something else holds it now. No running card: the end
	 * posts its own.
	 */
	async #resumeGate(row: TaskRow): Promise<void> {
		const { autoLand, gatePending, ledger, log } = this.#deps;
		const policy = this.#deps.autoLandPolicy?.();
		if (policy === undefined || autoLand === undefined || gatePending === undefined || row.host !== null) return;
		const band = confidentBand(row.risk, policy);
		if (band === undefined || this.#deps.autoLandHold?.() !== undefined || this.#deps.frozen?.() !== undefined) return;
		if (ledger.isPaused(row) || !(await gatePending(row))) return;
		const evaluation = await this.#deps.evaluate(row, this.#checks);
		if (!evaluation.ok || !(await this.#repoMatches(row, policy.repos))) return;
		const { judgement } = evaluation;
		const ungated = {
			repos: policy.repos,
			maxRisk: band.maxRisk,
		};
		if (autoLandBlockers(row, judgement, ungated, true).length > 0) return;
		const link = await this.#boardLink(row);
		const outcome = await autoLand(row, this.#gateHooks(row, judgement, link, false));
		log.info("task_gate_resumed", { task: row.taskId, state: outcome.state });
		if (outcome.state === "held" && outcome.reasons.length > 0) {
			const card = { kind: "skipped" as const, reasons: outcome.reasons, gate: ledger.require(row.taskId).gate };
			await this.#post(row, this.#reached(row, judgement, this.#deps.ownerUserId, link, card));
		}
	}

	/**
	 * What a PROGRESS block does this sweep before it may reach the owner. Without a retry pending: a block the owner
	 * must decide (`needs_owner`), a frozen or paused task, an already reported block or a used-up resume window goes to
	 * the card at once (`card`); otherwise the agent is sent the retry prompt once (marked before it goes out, so a
	 * failed send is not repeated) and the block is held (`hold`) — a failed send goes to the card at once. With a retry
	 * pending the block is held until the agent wrote PROGRESS since and herdr says it is not working, herdr says it
	 * stopped, `BLOCK_RETRY_WAIT_MS` passed, or `needs_owner` was set; then `retried`.
	 */
	async #blockRetryStep(
		row: TaskRow,
		judgement: TaskJudgement,
		status: TaskRow["status"],
		retry: number | undefined,
		now: number,
		actions: string[],
	): Promise<"hold" | "card" | "retried"> {
		const { ledger } = this.#deps;
		if (retry === undefined) {
			const fresh = ledger.require(row.taskId);
			const direct =
				judgement.needsOwner ||
				status !== "working" ||
				this.#deps.frozen?.() !== undefined ||
				ledger.isPaused(fresh) ||
				blockRetriesSince(fresh) >= BLOCK_RETRY_MAX;
			if (direct) return "card";
			ledger.recordNotice(row.taskId, `blockretry:${now}`);
			const reason = judgement.blockedReason === "" ? [] : unmetLines([`blocked_reason: ${judgement.blockedReason}`]);
			if (await this.#remind(row, [BLOCK_RETRY_HEAD, ...reason].join("\n"))) {
				actions.push("block retry to agent");
				return "hold";
			}
			actions.push("block retry failed");
			return "card";
		}
		if (judgement.needsOwner) return "retried";
		const agent = this.#sweepAgents.get(row.taskId) ?? (await this.#agentStatus(row));
		this.#sweepAgents.set(row.taskId, agent);
		const herdr = agent.ok ? agent.status : undefined;
		const wrote = agent.ok && herdr !== "working" && (judgement.updatedAtMs ?? 0) > retry;
		const stopped = herdr === "idle" || herdr === "done" || herdr === "blocked" || herdr === "gone";
		const waited = now - retry >= BLOCK_RETRY_WAIT_MS;
		if (wrote || stopped || waited) return "retried";
		actions.push("block retry pending");
		return "hold";
	}

	/** A failed or throwing comparison is a mismatch: the owner is asked as before. */
	async #repoMatches(row: TaskRow, repos: readonly string[]): Promise<boolean> {
		if (this.#deps.repoMatches === undefined) return false;
		try {
			return await this.#deps.repoMatches(row, repos);
		} catch (error) {
			this.#deps.log.warn("task_repo_match_failed", { task: row.taskId, error: String(error) });
			return false;
		}
	}

	/**
	 * The worktree's progress key for this task (`taskProgressEvidence`, wired by the daemon), or `undefined` when it
	 * cannot be read: a throw is logged once per task per run, and the caller keeps the time-based behavior.
	 */
	async #progressEvidence(row: TaskRow): Promise<string | undefined> {
		const read = this.#deps.progressEvidence;
		if (read === undefined) return undefined;
		let key: string | undefined;
		try {
			key = await read(row);
		} catch (error) {
			if (!this.#evidenceFailing.has(row.taskId)) {
				this.#evidenceFailing.add(row.taskId);
				this.#deps.log.warn("task_progress_evidence_failed", { task: row.taskId, error: String(error) });
			}
			return undefined;
		}
		if (key === undefined) return undefined;
		this.#evidenceFailing.delete(row.taskId);
		return key;
	}

	async #staleness(
		row: TaskRow,
		now: number,
		actions: string[],
		judgement: TaskJudgement,
		known?: HerdrAgentStatusResult,
	): Promise<void> {
		const { ledger } = this.#deps;
		const fresh = ledger.require(row.taskId);
		const base = Math.max(fresh.progressAt ?? 0, fresh.createdAt);
		const age = now - base;
		// A frozen bot sends the agent nothing and does not mark the task reminded: the reminder follows the unfreeze.
		const frozen = this.#deps.frozen?.() !== undefined;
		// An owner pause of this task holds the same prompts plus the stale notice, until the unpause.
		const pausedAt = taskPausedAt(fresh);
		// One herdr question per working task per sweep, shared by the LOST check and the reminder below.
		const agent = known ?? (await this.#agentStatus(row));
		this.#sweepAgents.set(row.taskId, agent);
		const status = agent.ok ? agent.status : undefined;
		// The latest `updated` moved nothing else: the reminder and notices below say so instead of implying progress.
		const noEvidence =
			judgement.updatedAtMs !== undefined && this.#noEvidenceUpdated.get(row.taskId) === judgement.updatedAtMs;
		// The LOST notice is for the owner, not the agent, so a freeze does not hold it. A resume moves the base.
		if (status === "gone" && ledger.recordNotice(row.taskId, `lost:${base}`)) {
			await this.#post(row, buildLostCard(row, this.#deps.ownerUserId, await this.#boardLink(row)));
			actions.push("LOST notice");
		}
		// A waiting agent refuses new prompts, so only the owner can unblock it: told once per wait, frozen or not
		// (like LOST). An unanswered lookup says nothing about the wait, so it neither starts nor ends one.
		if (status === "blocked") {
			const since = this.#waitingSince.get(row.taskId) ?? now;
			this.#waitingSince.set(row.taskId, since);
			if (ledger.recordNotice(row.taskId, `agentwait:${since}`)) {
				const screen = await this.#readAgent(row);
				await this.#post(row, buildAgentWaitingCard(row, screen, this.#deps.ownerUserId, await this.#boardLink(row)));
				actions.push("agent waiting notice");
			}
		} else if (agent.ok) {
			this.#waitingSince.delete(row.taskId);
		}
		// The worker of a paused task is herdr-working: the Esc did not hold (or it started again). Told once per pause,
		// and not while the pause's own Esc may still be waiting for the agent to stop.
		if (
			pausedAt !== undefined &&
			now - pausedAt > HERDR_INTERRUPT_WAIT_MS &&
			status === "working" &&
			ledger.recordNotice(row.taskId, `pausework:${pausedAt}`)
		) {
			await this.#post(
				row,
				`⚠️ 멈춘 TASK ${row.taskId}의 워커가 작업 중입니다(herdr working) — Esc가 듣지 않았을 수 있습니다. 스레드에 \`멈춰\`라고 다시 쓰거나 \`ompbot tasks pause ${row.taskId}\`로 Esc를 다시 보내세요.`,
			);
			actions.push("working-while-paused notice");
		}
		// A worker that ended its turn on a question in prose waits for the owner, not for a prompt: the owner hears it
		// once per question (frozen or paused alike), recorded only after the card went out.
		const question = status === "idle" || status === "done" ? await this.#question(row, agent) : undefined;
		if (question !== undefined) {
			this.#sweepQuestions.set(row.taskId, question);
			const key = `question:${digest(question)}`;
			if (!(key in ledger.require(row.taskId).notices)) {
				const card = buildAgentQuestionCard(row, question, this.#deps.ownerUserId, await this.#boardLink(row));
				if (await this.#post(row, card)) {
					ledger.recordNotice(row.taskId, key);
					actions.push("question notice");
				} else {
					this.#deps.log.warn("task_question_post_failed", {
						task: row.taskId,
						error: "post failed (see task_post_failed)",
					});
				}
			}
		}
		const stale = age >= STALE_REMIND_MS && (fresh.remindedAt === null || now - fresh.remindedAt >= STALE_REMIND_MS);
		if (!frozen) this.#remindHeld.delete(row.taskId);
		else if (stale && status !== "gone" && !this.#remindHeld.has(row.taskId)) {
			this.#remindHeld.add(row.taskId);
			this.#deps.log.info("task_remind_frozen", { task: row.taskId });
		}
		if (pausedAt !== undefined && !this.#pauseLogged.has(`${row.taskId}:${pausedAt}`)) {
			this.#pauseLogged.add(`${row.taskId}:${pausedAt}`);
			this.#deps.log.info("task_remind_paused", { task: row.taskId, pausedAt });
		}
		// An agent that ended its turn short of the outcome hears why at once, once per distinct set of unmet conditions.
		// It takes the place of the 30-minute reminder in that sweep: at most one prompt per sweep reaches the agent.
		const unmetKey = `unmet:${digest(judgement.problems)}`;
		const unmetPending =
			(status === "idle" || status === "done") && judgement.problems.length > 0 && !(unmetKey in fresh.notices);
		// A question holds the nudge back (not counted either): the owner's answer comes first.
		const wantsNudge = unmetPending && question === undefined;
		// At most NUDGE_MAX nudges since the last resume (or registration); past that the owner hears it once, even frozen.
		const capped = wantsNudge && nudgesSince(fresh) >= NUDGE_MAX;
		if (capped && ledger.recordNotice(row.taskId, `nudgecap:${nudgeBase(fresh)}`)) {
			await this.#post(
				row,
				buildNudgeLimitCard(row, judgement.problems, this.#deps.ownerUserId, await this.#boardLink(row)),
			);
			actions.push("nudge limit notice");
		}
		// Read again after the awaits above (herdr, board link, posts): an owner pause or freeze that came in meanwhile
		// holds the prompt below, and nothing is marked reminded.
		const held = this.#deps.frozen?.() !== undefined || taskPausedAt(ledger.require(row.taskId)) !== undefined;
		const due = !held && stale;
		const nudge = !held && wantsNudge && !capped;
		if (nudge) {
			if (await this.#remind(row, [NUDGE_HEAD, ...unmetLines(judgement.problems)].join("\n"))) {
				ledger.recordNotice(row.taskId, unmetKey);
				ledger.markReminded(row.taskId, now);
				actions.push("unmet nudge to agent");
			}
		} else if (question !== undefined && (due || (unmetPending && !held))) {
			this.#deps.log.info("task_remind_deferred", { task: row.taskId, agentStatus: "question" });
			actions.push("reminder deferred (question)");
		} else if (due && (status === "working" || status === "blocked")) {
			// A busy or waiting agent is not interrupted; the next sweep judges again, so the reminder follows idle.
			this.#deps.log.info("task_remind_deferred", { task: row.taskId, agentStatus: status });
			actions.push(`reminder deferred (${status})`);
		} else if (due && status !== "gone") {
			const minutes = Math.floor(age / 60_000);
			const text = [
				`PROGRESS.md가 ${minutes}분 넘게 갱신되지 않았습니다. 지금 단계와 다음 행동을 PROGRESS.md의 updated·current·next에 반영하세요. 한 단계가 30분을 넘으면 30분마다 중간 갱신합니다.`,
				"`updated`만 바꾸면 진행으로 치지 않으니 current·next에 실제 진척을 적으세요.",
				...unmetLines(judgement.problems),
				...(noEvidence ? [NO_EVIDENCE_LINE] : []),
			].join("\n");
			if (await this.#remind(row, text)) {
				ledger.markReminded(row.taskId, now);
				actions.push("stale reminder to agent");
			}
		}
		if (
			pausedAt === undefined &&
			status === "working" &&
			age >= WORKING_SILENT_NOTICE_MS &&
			age < STALE_NOTICE_MS &&
			ledger.recordNotice(row.taskId, `silent45:${base}`)
		) {
			const screen = await this.#readAgent(row);
			await this.#post(
				row,
				formatWorkingSilentNotice(row, Math.floor(age / 60_000), screen, await this.#boardLink(row), noEvidence),
			);
			actions.push("working silent notice");
		}
		if (pausedAt === undefined && age >= STALE_NOTICE_MS && ledger.recordNotice(row.taskId, `stale2h:${base}`)) {
			// A question left unanswered must not sink with the stale notice: the owner is mentioned then.
			const asked = question === undefined ? undefined : this.#deps.ownerUserId;
			await this.#post(
				row,
				formatStaleNotice(row, Math.floor(age / 60_000), await this.#boardLink(row), asked, noEvidence),
			);
			actions.push("stale notice");
		}
	}

	/**
	 * File overlap between the active local tasks of one repository (same path or git common dir). Each pair sharing a
	 * file outside `docs/tasks/**` tells both task threads once per set of shared paths (frozen or not: it is for the
	 * owner) and both agents once, recorded only after the prompt went out.
	 */
	async #overlaps(): Promise<void> {
		const { changedPaths, ledger, log } = this.#deps;
		if (changedPaths === undefined) return;
		// A remote task's worktree is on another machine: never read here.
		const local = ledger.listActive().filter((row) => row.host === null);
		const pairs: Array<[TaskRow, TaskRow]> = [];
		for (const [i, a] of local.entries()) {
			for (const b of local.slice(i + 1)) {
				if (a.repo === b.repo || (await this.#repoMatches(a, [b.repo]))) pairs.push([a, b]);
			}
		}
		const paths = new Map<string, ReadonlySet<string> | undefined>();
		const pathsOf = async (row: TaskRow): Promise<ReadonlySet<string> | undefined> => {
			if (!paths.has(row.taskId)) {
				let read: string[] | undefined;
				try {
					read = await changedPaths(row);
				} catch (error) {
					log.warn("task_changed_paths_failed", { task: row.taskId, error: String(error) });
				}
				paths.set(row.taskId, read === undefined ? undefined : new Set(read));
			}
			return paths.get(row.taskId);
		};
		for (const [a, b] of pairs) {
			const ofA = await pathsOf(a);
			const ofB = await pathsOf(b);
			if (ofA === undefined || ofB === undefined) continue;
			const shared = [...ofA].filter((path) => ofB.has(path) && !path.startsWith(TASK_DOCS_PREFIX)).sort();
			if (shared.length > 0) await this.#overlapNotice(a, b, shared);
		}
	}

	async #overlapNotice(a: TaskRow, b: TaskRow, shared: string[]): Promise<void> {
		const { ledger, log } = this.#deps;
		const hash = createHash("sha1").update(shared.join("\n")).digest("hex").slice(0, 8);
		const rest = shared.length - OVERLAP_PATHS_SHOWN;
		const shown = `${shared.slice(0, OVERLAP_PATHS_SHOWN).join(", ")}${rest > 0 ? ` 외 ${rest}개` : ""}`;
		const pair: Array<[TaskRow, TaskRow]> = [
			[a, b],
			[b, a],
		];
		for (const [own, other] of pair) {
			if (!ledger.recordNotice(own.taskId, `overlap:${other.taskId}:${hash}`)) continue;
			log.info("task_overlap", { task: own.taskId, other: other.taskId, paths: shared.length });
			await this.#post(
				own,
				`⚠️ 파일 겹침: ${a.taskId}와 ${b.taskId}가 ${shown}를 함께 고칩니다. 먼저 끝나는 쪽을 랜딩한 뒤 다른 쪽을 rebase하세요.`,
			);
		}
		for (const [own, other] of pair) {
			const key = `overlapworker:${other.taskId}:${hash}`;
			if (key in ledger.require(own.taskId).notices) continue;
			const deferred = await this.#overlapPrompt(
				own,
				`다른 TASK ${other.taskId}가 같은 파일(${shown})을 고치고 있습니다. 그 파일 변경은 범위 안에서 최소로 하고, 겹치는 함수·절을 PROGRESS.md 메모에 적으세요.`,
			);
			if (deferred === undefined) ledger.recordNotice(own.taskId, key);
			else log.info("task_overlap_remind_deferred", { task: own.taskId, other: other.taskId, reason: deferred });
		}
	}

	/**
	 * Sends the overlap prompt unless the bot is frozen, the owner paused the task, the agent already got a prompt this
	 * sweep, or herdr says it is busy, waiting or gone; returns why it did not go out (`undefined` = sent).
	 */
	async #overlapPrompt(row: TaskRow, text: string): Promise<string | undefined> {
		if (this.#deps.frozen?.() !== undefined) return "frozen";
		const fresh = this.#deps.ledger.require(row.taskId);
		if (this.#deps.ledger.isPaused(fresh)) return "paused";
		if (agyLimitHeld(fresh)) return "agy_limit";
		if (this.#prompted.has(row.taskId)) return "prompted";
		if (this.#sweepQuestions.has(row.taskId)) return "question";
		const agent = this.#sweepAgents.get(row.taskId) ?? (await this.#agentStatus(row));
		this.#sweepAgents.set(row.taskId, agent);
		const status = agent.ok ? agent.status : undefined;
		if (status === "working" || status === "blocked" || status === "gone") return status;
		return (await this.#remind(row, text)) ? undefined : "send_failed";
	}

	/**
	 * One prompt to the agent; true when it counts as sent. An unconfirmed delivery (herdr saw no start, the text may
	 * have landed) counts too, so the agent is not sent the same prompt again on the next sweep.
	 */
	async #remind(row: TaskRow, text: string): Promise<boolean> {
		const sent = await this.#deps.remind(row, text);
		if (sent.ok) {
			this.#prompted.add(row.taskId);
			return true;
		}
		if (sent.unconfirmed === true) {
			this.#deps.log.warn("task_remind_unconfirmed", { task: row.taskId, error: sent.error ?? "unknown" });
			this.#prompted.add(row.taskId);
			return true;
		}
		this.#deps.log.warn("task_remind_failed", { task: row.taskId, error: sent.error ?? "unknown" });
		return false;
	}

	/** The screen for a wait notice; a failed or throwing read becomes the notice's "could not read" line. */
	async #readAgent(row: TaskRow): Promise<{ ok: boolean; output?: string; error?: string }> {
		try {
			return await this.#deps.readAgent(row);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * The prose question the agent stopped on (see `questionOf`), from its session file. An unknown answer — no
	 * reader, no session path, nothing within the byte cap, a failed read — is no question, and the flow stays as it
	 * was; a failed read is logged once per run of failures.
	 */
	async #question(row: TaskRow, agent: HerdrAgentStatusResult): Promise<string | undefined> {
		const read = this.#deps.lastAnswer;
		if (read === undefined || !agent.ok || agent.sessionPath === undefined) return undefined;
		let answer: LastAnswer | undefined;
		try {
			answer = await read(row, agent.sessionPath);
		} catch (error) {
			if (!this.#questionReadFailing.has(row.taskId)) {
				this.#questionReadFailing.add(row.taskId);
				this.#deps.log.warn("task_question_read_failed", {
					task: row.taskId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return undefined;
		}
		this.#questionReadFailing.delete(row.taskId);
		return answer === undefined ? undefined : questionOf(answer);
	}

	/** herdr's view of the task's agent; a failed or throwing lookup is logged and leaves the reminder as before. */
	async #agentStatus(row: TaskRow): Promise<HerdrAgentStatusResult> {
		let result: HerdrAgentStatusResult;
		try {
			result = await this.#deps.agentStatus(row);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!result.ok) this.#deps.log.warn("task_agent_status_failed", { task: row.taskId, error: result.error });
		return result;
	}

	/** The reached card with the diff view line when the board is configured. */
	#reached(
		row: TaskRow,
		judgement: TaskJudgement,
		ownerUserId: string,
		link: string | undefined,
		note?: ReachedAutoLandNote,
	): TaskCard {
		return buildReachedCard(row, judgement, ownerUserId, link, note, this.#deps.diffLink?.(row));
	}

	async #boardLink(row: TaskRow): Promise<string | undefined> {
		if (this.#deps.boardLink === undefined) return undefined;
		try {
			return await this.#deps.boardLink(row);
		} catch (error) {
			this.#deps.log.warn("task_board_link_failed", { task: row.taskId, error: String(error) });
			return undefined;
		}
	}

	#post(row: TaskRow, card: TaskCard | string): Promise<boolean> {
		return postToThread(this.#deps.channels, this.#deps.log, row.threadRef, card);
	}

	#result(row: TaskRow, status: TaskRow["status"], judgement: TaskJudgement, actions: string[]): TaskCheckResult {
		return {
			taskId: row.taskId,
			status,
			read: true,
			summary: summarizeJudgement(judgement, status),
			judgement,
			actions,
		};
	}
}
