import type { TaskChecksRun } from "./checker";

/**
 * The daemon's queue for the `[check: …]` of local [TASK]s (doc/plans/task-sweep-latency.md): the sweep never waits for a
 * check process. A judgement that needs checks without a cached result at the HEAD asks for a job here and moves on; the
 * job runs one at a time (the load the sweep used to put on itself), and when it ends the daemon is asked for a sweep.
 */

/** A job that ended without a verdict (timeout, deferral, an error) is not asked for again at the same HEAD this long. */
export const CHECK_RETRY_MS = 5 * 60_000;

/** How one job ended; `done` means its results are in the cache (`ok`: every check passed). */
export type CheckJobEnd =
	| { kind: "done"; head: string; ok: boolean }
	/** No verdict to cache: a check timed out or the worktree was dirty/changed. `run` is what the judgement reports. */
	| { kind: "unsettled"; head?: string; run: TaskChecksRun }
	/**
	 * HEAD moved while the checks ran: those results are for a commit that is no longer the task's, so the job runs
	 * again. `run` is what a second move in a row reports (a check that commits would otherwise loop).
	 */
	| { kind: "stale"; run: TaskChecksRun }
	/** The task is no longer one to check (closed, gone). */
	| { kind: "skipped" };

/** What `request` tells the judgement. */
export type CheckRequestState =
	| { state: "running" }
	| { state: "queued"; position: number }
	/** The last job at this HEAD ended without a verdict less than `CHECK_RETRY_MS` ago: its run, or the error it threw. */
	| { state: "settled"; run: TaskChecksRun }
	| { state: "failed"; error: string };

export interface TaskCheckRunnerDeps {
	/** Runs the task's checks (at the HEAD of the moment it starts); `signal` aborts the check process. */
	execute(taskId: string, signal: AbortSignal): Promise<CheckJobEnd>;
	/** A job finished with results in the cache: the daemon runs a TASK sweep now. */
	onDone(taskId: string): void;
	now(): number;
	log: {
		info(event: string, fields?: Record<string, unknown>): void;
		warn(event: string, fields?: Record<string, unknown>): void;
	};
}

interface Running {
	taskId: string;
	controller: AbortController;
	finished: Promise<void>;
}

interface Settled {
	head: string;
	at: number;
	outcome: { run: TaskChecksRun } | { error: string };
}

export class TaskCheckRunner {
	readonly #deps: TaskCheckRunnerDeps;
	/** Waiting tasks, oldest first: one entry per task, whatever HEAD it was asked at (the job reads HEAD when it starts). */
	readonly #queue: string[] = [];
	readonly #heads = new Map<string, string>();
	readonly #settled = new Map<string, Settled>();
	/** Tasks whose last job ended `stale`: a second one in a row settles instead of running again. */
	readonly #stale = new Set<string>();
	#running: Running | undefined;
	#stopped = false;

	constructor(deps: TaskCheckRunnerDeps) {
		this.#deps = deps;
	}

	/** Asks for the task's checks at `head`: starts a job unless one is waiting or running, or just ended without a verdict. */
	request(taskId: string, head: string): CheckRequestState {
		const settled = this.#settled.get(taskId);
		if (settled !== undefined) {
			if (settled.head === head && this.#deps.now() - settled.at < CHECK_RETRY_MS) {
				return "error" in settled.outcome
					? { state: "failed", error: settled.outcome.error }
					: { state: "settled", run: settled.outcome.run };
			}
			this.#settled.delete(taskId);
		}
		if (this.#running?.taskId !== taskId && !this.#queue.includes(taskId) && !this.#stopped) {
			this.#queue.push(taskId);
			this.#heads.set(taskId, head);
			this.#deps.log.info("task_checks_queued", { task: taskId, head: head.slice(0, 12) });
			this.#pump();
		}
		if (this.#running?.taskId === taskId) return { state: "running" };
		return { state: "queued", position: this.#queue.indexOf(taskId) + 1 };
	}

	/** Drops the task's waiting job and aborts its running one; resolves once the check process is gone. */
	async cancel(taskId: string): Promise<void> {
		this.#drop(taskId);
		const running = this.#running;
		if (running?.taskId !== taskId) return;
		running.controller.abort();
		await running.finished;
	}

	/** Cancels every job whose task is not in `keep` (a task that left working/blocked/review); does not wait. */
	retain(keep: ReadonlySet<string>): void {
		for (const taskId of [...this.#queue]) if (!keep.has(taskId)) this.#drop(taskId);
		for (const taskId of [...this.#settled.keys()]) if (!keep.has(taskId)) this.#drop(taskId);
		if (this.#running !== undefined && !keep.has(this.#running.taskId)) this.#running.controller.abort();
	}

	/** Daemon stop: the queue is dropped and the running job killed; no result of it reaches the cache. */
	async stop(): Promise<void> {
		this.#stopped = true;
		this.#queue.length = 0;
		this.#heads.clear();
		const running = this.#running;
		running?.controller.abort();
		await running?.finished;
	}

	#drop(taskId: string): void {
		const index = this.#queue.indexOf(taskId);
		if (index >= 0) this.#queue.splice(index, 1);
		this.#heads.delete(taskId);
		this.#settled.delete(taskId);
		this.#stale.delete(taskId);
	}

	#pump(): void {
		if (this.#running !== undefined || this.#stopped) return;
		const taskId = this.#queue.shift();
		if (taskId === undefined) return;
		const requestedHead = this.#heads.get(taskId) ?? "";
		this.#heads.delete(taskId);
		const controller = new AbortController();
		const startedAt = this.#deps.now();
		const finished = this.#job(taskId, requestedHead, controller, startedAt).finally(() => {
			this.#running = undefined;
			this.#pump();
		});
		this.#running = { taskId, controller, finished };
	}

	async #job(taskId: string, requestedHead: string, controller: AbortController, startedAt: number): Promise<void> {
		const { log } = this.#deps;
		let end: CheckJobEnd | undefined;
		let error: string | undefined;
		try {
			end = await this.#deps.execute(taskId, controller.signal);
		} catch (thrown) {
			error = thrown instanceof Error ? thrown.message : String(thrown);
		}
		// A killed job (cancel, stop, task left) is no verdict and tells nobody.
		if (controller.signal.aborted || this.#stopped) return;
		const ms = this.#deps.now() - startedAt;
		const at = this.#deps.now();
		if (end === undefined) {
			log.warn("task_checks_done", { task: taskId, head: requestedHead.slice(0, 12), ms, error });
			this.#settled.set(taskId, { head: requestedHead, at, outcome: { error: error ?? "check 실행 실패" } });
			return;
		}
		switch (end.kind) {
			case "done":
				this.#stale.delete(taskId);
				log.info("task_checks_done", { task: taskId, head: end.head.slice(0, 12), ms, ok: end.ok });
				this.#deps.onDone(taskId);
				return;
			case "unsettled": {
				this.#stale.delete(taskId);
				const deferred = "deferred" in end.run ? end.run.deferred : undefined;
				log.info("task_checks_done", {
					task: taskId,
					head: (end.head ?? requestedHead).slice(0, 12),
					ms,
					ok: false,
					...(deferred === undefined ? {} : { deferred }),
				});
				// No sweep is asked for: the same HEAD is tried again only from the regular cycle after `CHECK_RETRY_MS`.
				this.#settled.set(taskId, { head: end.head ?? requestedHead, at, outcome: { run: end.run } });
				return;
			}
			case "stale":
				log.info("task_checks_stale", { task: taskId, ms });
				if (this.#stale.delete(taskId)) {
					this.#settled.set(taskId, { head: requestedHead, at, outcome: { run: end.run } });
					return;
				}
				this.#stale.add(taskId);
				this.#queue.push(taskId);
				this.#heads.set(taskId, requestedHead);
				return;
			case "skipped":
				return;
		}
	}
}
