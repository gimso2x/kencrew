import type { CheckJobEnd, TaskCheckRunner } from "./check-runner";
import {
	checkTask,
	type TaskCheck,
	type TaskCheckRequest,
	type TaskChecksPending,
	type TaskChecksRun,
	type TaskJudgement,
	taskChecksOf,
} from "./checker";
import { docsDirOf } from "./docs";
import type { TaskHostOps } from "./host";
import type { TaskChecks, TaskLedger, TaskRow } from "./ledger";
import { CHECK_TIMEOUT_MS, runSignal, type SignalCheck } from "./signals";

export type TaskEvaluation = { ok: true; judgement: TaskJudgement } | { ok: false; error: string };

/**
 * Where a task's check results at one HEAD are kept between judgements: the same commit is checked once, a new HEAD
 * replaces the entry. The sweep uses the ledger (`ledgerTaskChecks`, so a restart does not run them again); the
 * merge-time re-judgement a throwaway memory one (`memoryTaskChecks`, so it always runs them afresh).
 */
export interface TaskCheckCache {
	read(taskId: string): TaskChecks | null;
	write(taskId: string, value: TaskChecks): void;
}

/** The sweep's cache: the task's `check_json`, read fresh at each judgement. */
export function ledgerTaskChecks(ledger: TaskLedger): TaskCheckCache {
	return {
		read: (taskId) => ledger.get(taskId)?.checks ?? null,
		write: (taskId, value) => ledger.recordChecks(taskId, value),
	};
}

/** A cache that starts empty and forgets with the object; nothing reaches the ledger. */
export function memoryTaskChecks(): TaskCheckCache {
	const entries = new Map<string, TaskChecks>();
	return { read: (taskId) => entries.get(taskId) ?? null, write: (taskId, value) => void entries.set(taskId, value) };
}

const CHECK_CHANGED_WORKTREE =
	"[check:] 명령이 worktree를 변경했습니다(커밋·파일 생성) — 검사는 worktree를 바꾸지 않아야 합니다. 변경을 정리(커밋하거나 지움)한 뒤 다시 알리세요";
const UNCOMMITTED = "미커밋 변경이 있어 check를 미룹니다";

/**
 * Runs the checks at `worktree`'s HEAD; uncommitted changes defer them. `resultsAt(head)` hands back the signal
 * results already known at that HEAD (filled in place as signals run, except inconclusive ones), so the same commit is
 * never checked twice — a timed-out signal is run again.
 * Shared by the task sweep and the work lanes; host failures throw. An aborted `signal` kills the running check and
 * throws before the next one (what ran is then no verdict).
 */
export async function runWorktreeChecks(
	ops: TaskHostOps,
	worktree: string,
	resultsAt: (head: string) => Map<string, SignalCheck>,
	requests: readonly TaskCheckRequest[],
	signal?: AbortSignal,
): Promise<TaskChecksRun> {
	const head = await ops.headOf(worktree);
	if (!head.clean) return { deferred: UNCOMMITTED };
	const known = resultsAt(head.sha);
	const io = {
		runCheck: (argv: string[]) =>
			ops.runCheck({ worktree, argv, timeoutMs: CHECK_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }),
		readBytes: async (path: string) => {
			const read = await ops.readBytes(`${worktree}/${path}`, worktree);
			if (!read.ok) throw new Error(`cannot read ${path}: ${read.error}`);
			return read.value;
		},
	};
	const results: TaskCheck[] = [];
	const ran: string[] = [];
	// One at a time: two test suites racing in one worktree would judge each other.
	for (const request of requests) {
		let result = known.get(request.signal);
		if (result === undefined) {
			signal?.throwIfAborted();
			result = await runSignal(request.signal, io);
			// A killed check is no verdict: it must not reach the known results.
			signal?.throwIfAborted();
			// A timed-out run proves nothing either way: the next judgement runs it again.
			if (!result.inconclusive) {
				known.set(request.signal, result);
				ran.push(request.signal);
			}
		}
		results.push({
			id: request.id,
			signal: request.signal,
			ok: result.ok,
			detail: result.detail,
			...(result.inconclusive ? { inconclusive: true as const } : {}),
		});
	}
	// A check that changed the worktree (a commit, a written file) judged a tree that is no longer the claim: its
	// results are not remembered, and the judgement says why instead of blaming the next, "uncommitted" tree.
	const after = ran.length === 0 ? head : await ops.headOf(worktree);
	if (after.sha !== head.sha || !after.clean) {
		for (const text of ran) known.delete(text);
		return { deferred: CHECK_CHANGED_WORKTREE };
	}
	return { head: head.sha, results };
}

/**
 * The task's checks through `cache`: the stored results count only at the HEAD they ran at, a new HEAD starts empty.
 * Once the run returns, that HEAD's results are stored in one write — replacing the entry even when none is left. An
 * aborted or failed run stores nothing; an uncommitted worktree never reaches the HEAD read, so keeps the entry.
 */
async function runTaskChecks(
	row: TaskRow,
	ops: TaskHostOps,
	cache: TaskCheckCache,
	requests: readonly TaskCheckRequest[],
	signal?: AbortSignal,
): Promise<TaskChecksRun> {
	const stored = cache.read(row.taskId);
	let at: { head: string; known: Map<string, SignalCheck> } | undefined;
	const run = await runWorktreeChecks(
		ops,
		row.worktree,
		(head) => {
			const known = new Map<string, SignalCheck>();
			if (stored?.head === head) for (const result of stored.results) known.set(result.signal, result);
			at = { head, known };
			return known;
		},
		requests,
		signal,
	);
	if (at !== undefined) cache.write(row.taskId, { head: at.head, results: [...at.known.values()] });
	return run;
}

/**
 * The runner's job for one task (`TaskCheckRunner.execute`): its checks at the HEAD of the moment, stored in `cache`.
 * Ends `stale` when HEAD moved while they ran, `unsettled` when no verdict can be cached (a check timed out, the
 * worktree was dirty or changed by a check).
 */
export async function runCheckJob(
	row: TaskRow,
	ops: TaskHostOps,
	cache: TaskCheckCache,
	signal: AbortSignal,
): Promise<CheckJobEnd> {
	const before = await ops.headOf(row.worktree);
	const run = await runTaskChecks(row, ops, cache, taskChecksOf(row.acceptance), signal);
	// Whatever the run came to, a HEAD that is not the one it started at (a worker commit) makes it no verdict.
	if ((await ops.headOf(row.worktree)).sha !== before.sha) return { kind: "stale", run };
	if ("deferred" in run || run.results.some((result) => result.inconclusive)) {
		return { kind: "unsettled", ...("head" in run ? { head: run.head } : {}), run };
	}
	return { kind: "done", head: run.head, ok: run.results.every((result) => result.ok) };
}

/**
 * Checks for a local task through the runner: results already cached at the HEAD answer at once, otherwise a job is
 * asked for and the judgement is `pending` — it never waits for a check process. A job that ended without a verdict
 * answers with its run (or throws its error) until it may run again.
 */
async function queuedTaskChecks(
	row: TaskRow,
	ops: TaskHostOps,
	cache: TaskCheckCache,
	requests: readonly TaskCheckRequest[],
	runner: TaskCheckRunner,
): Promise<TaskChecksRun | TaskChecksPending> {
	const head = await ops.headOf(row.worktree);
	if (!head.clean) return { deferred: UNCOMMITTED };
	const stored = cache.read(row.taskId);
	const cached = stored?.head === head.sha ? stored.results : [];
	if (requests.every((request) => cached.some((result) => result.signal === request.signal))) {
		return runTaskChecks(row, ops, cache, requests);
	}
	const state = runner.request(row.taskId, head.sha);
	if (state.state === "settled") return state.run;
	if (state.state === "failed") throw new Error(state.error);
	return { pending: state.state === "running" ? "check 실행 중" : `check 대기 ${state.position}번째` };
}

/** The task branch's diff for the integrity classifier; a failed read defers the classification, never passes it. */
async function readBranchDiff(row: TaskRow, ops: TaskHostOps): Promise<{ diff: string } | { error: string }> {
	const read = await ops.branchDiff({ worktree: row.worktree, branch: row.branch, taskId: row.taskId });
	return read.ok ? { diff: read.value } : { error: read.error };
}

/**
 * Reads spec.md, PROGRESS.md and outcome.md from the task's host and judges them. Any read that cannot be answered
 * (host down, timeout) is a failed evaluation — never a verdict; a file that is simply absent is judged as absent.
 * `checks` (the sweep's cache) turns on the `[check: …]` runs and the branch-diff integrity read; other readers (CLI,
 * dashboard) judge the documents only. With a `runner`, a local task's missing check results are queued there and the
 * judgement is pending instead of waiting; a remote task still runs them in place.
 */
export async function evaluateTask(
	row: TaskRow,
	ops: TaskHostOps,
	checks?: TaskCheckCache,
	runner?: TaskCheckRunner,
): Promise<TaskEvaluation> {
	const dir = docsDirOf(row.worktree, row.taskId);
	try {
		const [spec, progress, outcome] = await Promise.all(
			["spec.md", "PROGRESS.md", "outcome.md"].map((name) => ops.readFile(`${dir}/${name}`)),
		);
		for (const read of [spec, progress, outcome]) {
			if (read === undefined || !read.ok) return { ok: false, error: read?.ok === false ? read.error : "read failed" };
		}
		const text = (read: typeof spec): string | undefined => (read?.ok ? read.value : undefined);
		const judgement = await checkTask({
			snapshot: row.acceptance,
			spec: text(spec),
			progress: text(progress),
			outcome: text(outcome),
			commitCheck: (hash) =>
				ops.commitOnTaskBranch({ worktree: row.worktree, branch: row.branch, taskId: row.taskId, hash }),
			...(checks === undefined
				? {}
				: {
						runChecks: (requests) =>
							runner !== undefined && row.host === null
								? queuedTaskChecks(row, ops, checks, requests, runner)
								: runTaskChecks(row, ops, checks, requests),
						integrity: () => readBranchDiff(row, ops),
					}),
		});
		return { ok: true, judgement };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
