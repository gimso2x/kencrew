import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordChannel } from "../src/discord/channel";
import { CHECK_RETRY_MS, type CheckJobEnd, TaskCheckRunner } from "../src/tasks/check-runner";
import { acceptanceItems, docsDirOf, renderProgress, renderSpec } from "../src/tasks/docs";
import { evaluateTask, ledgerTaskChecks, runCheckJob } from "../src/tasks/evaluate";
import type { TaskHostOps } from "../src/tasks/host";
import { landTask } from "../src/tasks/land";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import { TaskSweeper } from "../src/tasks/sweeper";
import { OWNER } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const T0 = Date.parse("2026-11-20T01:00:00Z");
const HEAD = "a".repeat(40);
const SIGNAL = 'command ["bun","test"] stdout~" 0 fail"';
const BUN_TEST = `[check: command ["bun","test"] stdout~" 0 fail"]`;

const log = { info() {}, warn() {} };

/** A promise settled from outside, so a test decides when a check process ends. */
function gate<T = void>(): { promise: Promise<T>; open(value: T): void } {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, open: resolve };
}

interface Fixture {
	ledger: TaskLedger;
	clock: { ms: number };
	files: Record<string, string>;
}

/** A ledger plus `count` tasks whose documents are complete and each of whose criteria carries one `[check:]`. */
function fixture(count: number): Fixture & { rows: TaskRow[] } {
	const clock = { ms: T0 };
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
		timezone: "Asia/Seoul",
		clock: { now: () => clock.ms },
	});
	const files: Record<string, string> = {};
	const rows: TaskRow[] = [];
	for (let i = 0; i < count; i++) {
		const row = ledger.register({
			title: `check ${i}`,
			risk: "L2",
			originKey: "discord/ch/111111111111111111/t/222222222222222222",
			threadRef: `111111111111111111:22222222222222222${i}`,
			host: null,
			repo: "/r/repo",
			acceptance: acceptanceItems([`통과한다 ${BUN_TEST}`]),
		});
		const meta = {
			taskId: row.taskId,
			hostLabel: "local",
			repo: row.repo,
			worktree: row.worktree,
			branch: row.branch,
			agent: row.agent,
			threadLink: "x",
			registeredAt: T0,
			timezone: "Asia/Seoul",
		};
		const dir = docsDirOf(row.worktree, row.taskId);
		files[`${dir}/spec.md`] = renderSpec(
			meta,
			{ title: "t", risk: "L2", goal: "g", scope: [], exclusions: [], acceptance: [], repo: row.repo },
			row.acceptance,
		).replaceAll("- [ ] AC-", "- [x] AC-");
		files[`${dir}/PROGRESS.md`] = renderProgress(row.taskId, T0, "Asia/Seoul");
		files[`${dir}/outcome.md`] = [
			`# ${row.taskId} Outcome 증거`,
			"## 요약",
			"바뀌었습니다.",
			"## AC-1",
			"- test: bun test → 5 pass 0 fail",
			"",
		].join("\n");
		rows.push(row);
	}
	return { ledger, clock, files, rows };
}

/** Host ops whose check process runs `run(worktree, signal)`; HEAD is fixed unless `head` says otherwise. */
function hostOps(
	files: Record<string, string>,
	run: (
		worktree: string,
		signal: AbortSignal | undefined,
	) => Promise<{ code: number | null; output: string; timedOut?: boolean }>,
	head: () => string = () => HEAD,
): TaskHostOps {
	const unused = () => {
		throw new Error("not used");
	};
	return {
		pathExists: unused,
		createWorktree: unused,
		removeWorktree: unused,
		writeFile: unused,
		commitDocs: unused,
		commitOnTaskBranch: async () => "ok",
		readFile: async (path) => ({ ok: true, value: files[path] }),
		readBytes: unused,
		runCheck: async ({ worktree, signal }) => ({ timedOut: false, ...(await run(worktree, signal)) }),
		headOf: async () => ({ sha: head(), clean: true }),
		branchDiff: async () => ({ ok: true, value: "" }),
	};
}

/** Rejects when the signal aborts, like the real host killing the process. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	signal?.addEventListener("abort", () => reject(new Error("aborted")));
	return promise;
}

interface Rig {
	sweeper: TaskSweeper;
	runner: TaskCheckRunner;
	fix: Fixture & { rows: TaskRow[] };
	reminders: string[];
	done: string[];
	/** Resolves once `count` jobs have ended with results in the cache (and asked for a sweep). */
	jobsDone(count: number): Promise<void>;
	/** Resolves once the check process was started `count` times. */
	started(count: number): Promise<void>;
	/** Resolves once `count` jobs have ended, with or without a verdict (`task_checks_done`). */
	ended(count: number): Promise<void>;
}

/** A sweeper and runner over the real `evaluateTask`; `onDone` only records, the test runs the sweep itself. */
function rig(count: number, run: Parameters<typeof hostOps>[1], head?: () => string): Rig {
	const fix = fixture(count);
	const done: string[] = [];
	const waiters: Array<{ count: number; resolve(): void }> = [];
	const starts = { count: 0, waiters: [] as Array<{ count: number; resolve(): void }> };
	const wake = (list: typeof waiters, size: number) => {
		for (const waiter of list.filter((entry) => entry.count <= size)) waiter.resolve();
	};
	const finished = { count: 0, waiters: [] as Array<{ count: number; resolve(): void }> };
	const runnerLog = {
		info(event: string) {
			if (event !== "task_checks_done") return;
			finished.count += 1;
			wake(finished.waiters, finished.count);
		},
		warn() {},
	};
	const cache = ledgerTaskChecks(fix.ledger);
	const counted: typeof run = (worktree, signal) => {
		starts.count += 1;
		wake(starts.waiters, starts.count);
		return run(worktree, signal);
	};
	const ops = hostOps(fix.files, counted, head);
	const runner = new TaskCheckRunner({
		execute: async (taskId, signal) => {
			const row = fix.ledger.get(taskId);
			if (row === undefined) return { kind: "skipped" };
			return runCheckJob(row, ops, cache, signal);
		},
		onDone: (taskId) => {
			done.push(taskId);
			wake(waiters, done.length);
		},
		now: () => fix.clock.ms,
		log: runnerLog,
	});
	const reminders: string[] = [];
	const sweeper = new TaskSweeper({
		ledger: fix.ledger,
		checkRunner: runner,
		evaluate: (row, checks) => evaluateTask(row, ops, checks, runner),
		remind: async (_row, text) => {
			reminders.push(text);
			return { ok: true };
		},
		agentStatus: async () => ({ ok: true, status: "idle" }),
		readAgent: async () => ({ ok: true, output: "" }),
		channels: registryOf(new DiscordChannel(new FakeDiscordTransport(), { ownerUserId: OWNER })),
		ownerUserId: OWNER,
		now: () => fix.clock.ms,
		log,
	});
	const until = (list: typeof waiters, size: () => number, count: number): Promise<void> => {
		if (size() >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		list.push({ count, resolve });
		return promise;
	};
	return {
		sweeper,
		runner,
		fix,
		reminders,
		done,
		jobsDone: (count) => until(waiters, () => done.length, count),
		started: (count) => until(starts.waiters, () => starts.count, count),
		ended: (count) => until(finished.waiters, () => finished.count, count),
	};
}

describe("TaskCheckRunner: the sweep never waits for a check process", () => {
	test("AC-1: a check held in its process does not hold the sweep; the task with cached results reaches review", async () => {
		const held = gate<{ code: number; output: string }>();
		const r = rig(2, () => held.promise);
		const [stuck, cached] = r.fix.rows as [TaskRow, TaskRow];
		r.fix.ledger.recordChecks(cached.taskId, {
			head: HEAD,
			results: [{ signal: SIGNAL, ok: true, detail: "5 pass" }],
		});

		const results = await r.sweeper.sweep();

		expect(results).toHaveLength(2);
		expect(r.fix.ledger.require(cached.taskId).status).toBe("review");
		expect(r.fix.ledger.require(stuck.taskId).status).toBe("working");
		const stuckResult = results.find((result) => result.taskId === stuck.taskId);
		expect(stuckResult?.judgement).toMatchObject({ reached: false, problems: [], pendingChecks: "check 실행 중" });
		held.open({ code: 0, output: "5 pass\n 0 fail\n" });
		await r.jobsDone(1);
	});

	test("AC-2: a passing job reaches review on the next sweep without any clock advance; the task is queued once", async () => {
		const held = gate<{ code: number; output: string }>();
		let runs = 0;
		const r = rig(1, () => {
			runs += 1;
			return held.promise;
		});
		const row = r.fix.rows[0] as TaskRow;

		await r.sweeper.sweep();
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(runs).toBe(1);
		expect(r.fix.ledger.require(row.taskId).status).toBe("working");

		held.open({ code: 0, output: "5 pass\n 0 fail\n" });
		await r.jobsDone(1);
		expect(r.done).toEqual([row.taskId]);
		await r.sweeper.sweep();
		expect(r.fix.ledger.require(row.taskId).status).toBe("review");
		expect(runs).toBe(1);
	});

	test("AC-2: a failing job leaves the `check … 실패` problem as before", async () => {
		const r = rig(1, async () => ({ code: 1, output: "3 pass\n 2 fail\n" }));
		const row = r.fix.rows[0] as TaskRow;

		await r.sweeper.sweep();
		await r.jobsDone(1);
		const [result] = await r.sweeper.sweep();

		expect(r.fix.ledger.require(row.taskId).status).toBe("working");
		expect(result?.judgement?.problems).toEqual([expect.stringMatching(/^check AC-1 실패: /)]);
	});

	test("queued tasks run one at a time and report their place", async () => {
		const first = gate<{ code: number; output: string }>();
		const running: string[] = [];
		let concurrent = 0;
		let peak = 0;
		const r = rig(3, async (worktree) => {
			running.push(worktree);
			concurrent += 1;
			peak = Math.max(peak, concurrent);
			const result = running.length === 1 ? await first.promise : { code: 0, output: "0 fail" };
			concurrent -= 1;
			return result;
		});
		const results = await r.sweeper.sweep();
		expect(results.map((result) => result.judgement?.pendingChecks)).toEqual([
			"check 실행 중",
			"check 대기 1번째",
			"check 대기 2번째",
		]);
		first.open({ code: 0, output: "0 fail" });
		await r.jobsDone(3);
		expect(peak).toBe(1);
	});

	test("AC-4: a finished worker is not nudged while its checks are pending", async () => {
		const held = gate<{ code: number; output: string }>();
		const r = rig(1, () => held.promise);
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);
		expect(r.fix.ledger.require((r.fix.rows[0] as TaskRow).taskId).notices).toEqual({});
		held.open({ code: 0, output: "0 fail" });
		await r.jobsDone(1);
	});

	test("AC-4: a check that ended without a verdict is not run again at the same HEAD until the retry window passes", async () => {
		let runs = 0;
		const r = rig(1, async () => {
			runs += 1;
			return { code: null, output: "", timedOut: true };
		});
		const row = r.fix.rows[0] as TaskRow;
		await r.sweeper.sweep();
		await r.ended(1);
		expect(runs).toBe(1);

		// The job is over and asked for no sweep; sweeps in the retry window report its result and start nothing.
		const settled = await r.sweeper.sweep();
		r.fix.clock.ms += CHECK_RETRY_MS - 1;
		await r.sweeper.sweep();
		expect(runs).toBe(1);
		expect(r.done).toEqual([]);
		expect(settled[0]?.judgement?.problems).toEqual([expect.stringMatching(/^check AC-1 실패: /)]);

		r.fix.clock.ms += 1;
		await r.sweeper.sweep();
		await r.ended(2);
		expect(runs).toBe(2);
		expect(r.fix.ledger.require(row.taskId).status).toBe("working");
	});

	test("a job whose HEAD moved while it ran is run again at the new HEAD", async () => {
		let head = HEAD;
		const first = gate<{ code: number; output: string }>();
		let runs = 0;
		const r = rig(
			1,
			async () => {
				runs += 1;
				if (runs === 1) {
					const result = await first.promise;
					head = "b".repeat(40);
					return result;
				}
				return { code: 0, output: "0 fail" };
			},
			() => head,
		);
		await r.sweeper.sweep();
		first.open({ code: 0, output: "0 fail" });
		await r.jobsDone(1);
		expect(runs).toBe(2);
		expect(r.fix.ledger.get((r.fix.rows[0] as TaskRow).taskId)?.checks?.head).toBe("b".repeat(40));
	});

	test("cancel drops a waiting job and kills the running one, resolving once it is gone", async () => {
		const events: string[] = [];
		const r = rig(2, async (worktree, signal) => {
			events.push(`start ${worktree}`);
			try {
				return await untilAborted(signal);
			} finally {
				events.push("stopped");
			}
		});
		const [running, waiting] = r.fix.rows as [TaskRow, TaskRow];
		await r.sweeper.sweep();
		await r.started(1);

		await r.runner.cancel(waiting.taskId);
		expect(events).toEqual([`start ${running.worktree}`]);
		await r.runner.cancel(running.taskId);
		expect(events).toEqual([`start ${running.worktree}`, "stopped"]);
		expect(r.done).toEqual([]);
		// Nothing started for the dropped one, and a killed run left no result in the cache.
		expect(r.fix.ledger.get(running.taskId)?.checks).toBeNull();
		expect(r.fix.ledger.get(waiting.taskId)?.checks).toBeNull();
	});

	test("retain cancels jobs of tasks that are no longer active", async () => {
		const stopped = gate();
		const r = rig(1, async (_worktree, signal) => {
			try {
				return await untilAborted(signal);
			} finally {
				stopped.open();
			}
		});
		const row = r.fix.rows[0] as TaskRow;
		await r.sweeper.sweep();
		await r.started(1);
		r.fix.ledger.transition(row.taskId, "cancelled", "human", "close");
		await r.sweeper.sweep();
		await stopped.promise;
		expect(r.done).toEqual([]);
	});

	test("stop kills the running job and drops the queue", async () => {
		const events: string[] = [];
		const r = rig(2, async (_worktree, signal) => {
			events.push("start");
			try {
				return await untilAborted(signal);
			} finally {
				events.push("stopped");
			}
		});
		await r.sweeper.sweep();
		await r.started(1);
		await r.runner.stop();
		expect(events).toEqual(["start", "stopped"]);
		expect(r.done).toEqual([]);
	});

	test("AC-4: landing stops the task's checks first and rebases only after they are gone", async () => {
		const order: string[] = [];
		const ended = gate();
		const runner = new TaskCheckRunner({
			execute: async (_taskId, signal): Promise<CheckJobEnd> => {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve());
				await aborted.promise;
				await ended.promise;
				order.push("check stopped");
				return { kind: "skipped" };
			},
			onDone: () => {},
			now: () => T0,
			log,
		});
		runner.request("T-1", HEAD);
		const git = async (args: string[]) => {
			order.push(`git ${args[2]}`);
			return { code: 1, stdout: "", stderr: "stop here" };
		};
		const worktree = mkdtempSync(join(tmpdir(), "check-runner-land-"));
		const row = { taskId: "T-1", status: "review", host: null, worktree, branch: "b", repo: "/r" } as TaskRow;
		const landing = landTask(row, {
			git,
			mode: "auto",
			land: async () => {
				throw new Error("not reached");
			},
			stopChecks: (taskId) => runner.cancel(taskId),
			judge: async () => ({ ok: false, error: "unused" }),
			holdReason: () => undefined,
			ledger: { transition: () => row },
			afterDone: async () => [],
		});
		ended.open();
		await landing;
		rmSync(worktree, { recursive: true, force: true });
		expect(order[0]).toBe("check stopped");
		expect(order.slice(1).length).toBeGreaterThan(0);
	});
});
