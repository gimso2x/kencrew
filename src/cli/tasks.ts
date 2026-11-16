import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, timezoneOfHome } from "../config";
import { escapeControl } from "../daemon/doctor";
import { callDaemon, IpcNoResponse } from "../daemon/ipc";
import { summarizeJudgement, taskChecksOf } from "../tasks/checker";
import { evaluateTask } from "../tasks/evaluate";
import { resolveTaskHost } from "../tasks/host";
import { openTaskLedger, type TaskLedger, type TaskRow, TaskTransitionError } from "../tasks/ledger";
import { CHECK_TIMEOUT_MS } from "../tasks/signals";

export const TASKS_USAGE = `  tasks list [--json]            [TASK] registry
  tasks show <id>                registry row, transition history and the current Outcome judgement
  tasks check <id>               judge now; the running daemon posts/reacts like its sweep does
  tasks close <id> --as done|cancelled   human-only completion (the bot can never do this); worktree and branch stay
  tasks pause <id>               owner pause: the sweep holds prompts, stale notice and auto-merge; the worker gets an Esc
  tasks resume <id>              lifts the pause (sweep hold only; the worker is not prompted)
`;

/** One `tasks list` line; ledger text is escaped so a title cannot start a forged line or move the cursor. */
function describe(row: TaskRow, paused: boolean): string {
	const where = escapeControl(`${row.host ?? "local"}:${row.worktree}`);
	return `${row.taskId}  ${row.status.padEnd(9)}  ${row.risk}  ${escapeControl(row.title)}  [${where} ${escapeControl(row.branch)}]  agent=${escapeControl(row.agent)}  AC=${row.acceptance.length}${paused ? " (멈춤)" : ""}`;
}

function dispatchHostsOf(homeDir: string): Record<string, { ssh: string }> | undefined {
	try {
		return loadConfig(homeDir).dispatchHosts;
	} catch (error) {
		// Without the config a remote TASK resolves as local and fails later with a misleading read error.
		process.stderr.write(`tasks: config unreadable, dispatch hosts unknown: ${String(error)}\n`);
		return undefined;
	}
}

/** The IPC wait of every request but `check`. */
const IPC_TIMEOUT_MS = 60_000;

/**
 * How long `tasks check` waits for the daemon: its check runs every `[check: …]` signal of the task one after another,
 * each bounded by `CHECK_TIMEOUT_MS`, plus the plain wait for the reads and posts around them.
 */
export function checkIpcTimeoutMs(row: TaskRow): number {
	return taskChecksOf(row.acceptance).length * CHECK_TIMEOUT_MS + IPC_TIMEOUT_MS;
}

/** Test seam of `tasksCommand`. */
export interface TasksCommandOptions {
	/** Overrides `checkIpcTimeoutMs` for `check`. */
	checkTimeoutMs?: number;
}

/**
 * Asks the running daemon to act on a task (post, react). `unreachable`: nothing listens, so nothing was done;
 * `no_response`: the request went out but no answer came in `timeoutMs`, so the daemon may still be acting on it.
 */
async function askDaemon(
	homeDir: string,
	request: Record<string, unknown>,
	timeoutMs = IPC_TIMEOUT_MS,
): Promise<Record<string, unknown> | "unreachable" | "no_response"> {
	try {
		const response = await callDaemon(join(homeDir, "ompbot.sock"), request, timeoutMs);
		return typeof response === "object" && response !== null ? (response as Record<string, unknown>) : "no_response";
	} catch (error) {
		return error instanceof IpcNoResponse ? "no_response" : "unreachable";
	}
}

/** `ompbot tasks ...` against the ledger file directly; Slack side effects go through the running daemon. */
export async function tasksCommand(
	args: string[],
	homeDir: string,
	options: TasksCommandOptions = {},
): Promise<number> {
	const [sub, ...rest] = args;
	if (sub !== "list" && sub !== "show" && sub !== "check" && sub !== "close" && sub !== "pause" && sub !== "resume") {
		process.stderr.write(`usage: ompbot tasks <list|show|check|close|pause|resume>\n${TASKS_USAGE}`);
		return 2;
	}
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: { json: { type: "boolean" }, as: { type: "string" } },
	});
	const dbPath = join(homeDir, "ompbot.db");
	// A read must not create a ledger holding only `tasks`: `gates` and `status` would call it unreadable.
	const noLedger = (): number => {
		if (sub === "list") {
			process.stdout.write(values.json === true ? `${JSON.stringify({ tasks: [] })}\n` : "no tasks\n");
			return 0;
		}
		process.stderr.write(`tasks ${sub}: task not found: ${positionals[0] ?? "(id required)"}\n`);
		return 1;
	};
	if (!existsSync(dbPath)) return noLedger();
	let ledger: TaskLedger;
	try {
		ledger = openTaskLedger(dbPath, timezoneOfHome(homeDir), undefined, {
			readonly: sub === "list" || sub === "show",
		});
	} catch (error) {
		process.stderr.write(
			`tasks ${sub}: ledger ${dbPath} cannot be opened: ${escapeControl(String(error))} — check the file's permissions and that its directory is writable, or copy ompbot.db to a writable place\n`,
		);
		return 1;
	}
	try {
		const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
		if (sub === "list") {
			const rows = ledger.list();
			if (values.json === true) out({ tasks: rows.map((row) => ({ ...row, paused: ledger.isPaused(row) })) });
			else if (rows.length === 0) process.stdout.write("no tasks\n");
			else for (const row of rows) process.stdout.write(`${describe(row, ledger.isPaused(row))}\n`);
			return 0;
		}
		const taskId = positionals[0];
		const row = taskId === undefined ? undefined : ledger.get(taskId);
		if (row === undefined) {
			process.stderr.write(`tasks ${sub}: task not found: ${taskId ?? "(id required)"}\n`);
			return 1;
		}
		if (sub === "close") {
			if (values.as !== "done" && values.as !== "cancelled") {
				process.stderr.write("tasks close: --as done|cancelled required\n");
				return 2;
			}
			const closed = ledger.transition(row.taskId, values.as, "human", `close --as ${values.as}`);
			out({ closed: closed.taskId, status: closed.status, closedAt: closed.closedAt });
			const synced = await askDaemon(homeDir, { op: "tasks_sync", id: row.taskId });
			if (synced === "no_response")
				process.stderr.write("tasks close: no daemon answer — 응답 지연 — Slack reaction update unknown\n");
			else if (synced === "unreachable")
				process.stderr.write("tasks close: daemon not reachable — Slack reaction not updated\n");
			else if (synced.ok !== true)
				process.stderr.write(`tasks close: daemon refused: ${String(synced.error)} — Slack reaction not updated\n`);
			return 0;
		}
		if (sub === "pause" || sub === "resume") {
			const answered = await askDaemon(homeDir, {
				op: sub === "pause" ? "tasks_pause" : "tasks_resume",
				id: row.taskId,
			});
			if (typeof answered !== "string") {
				out(answered);
				return answered.ok === true ? 0 : 1;
			}
			if (answered === "no_response") {
				// The daemon has the request and may have applied it (even sent the Esc): marking here could contradict it.
				process.stderr.write(
					`tasks ${sub}: no daemon answer — 응답 지연 — ${sub} 적용 여부 모름 (not applied locally)\n`,
				);
				return 1;
			}
			// No daemon: the ledger mark alone holds the next sweep; the worker gets no Esc.
			const wasPaused = ledger.isPaused(row);
			const marked = sub === "pause" ? ledger.pauseTask(row.taskId) : ledger.unpauseTask(row.taskId);
			if (sub === "resume" && !wasPaused) {
				// Same wording as the daemon's answer: a TASK that was never paused was not resumed.
				out({
					ok: true,
					task: marked.taskId,
					paused: false,
					resumed: false,
					note: `${marked.taskId}는 멈춘 상태가 아닙니다.`,
				});
				return 0;
			}
			out({ ok: true, task: marked.taskId, paused: ledger.isPaused(marked) });
			if (sub === "pause")
				process.stderr.write("tasks pause: daemon not reachable — paused in the ledger, no Esc sent\n");
			return 0;
		}
		if (sub === "check" && (row.status === "working" || row.status === "blocked")) {
			const timeoutMs = options.checkTimeoutMs ?? checkIpcTimeoutMs(row);
			const checked = await askDaemon(homeDir, { op: "tasks_check", id: row.taskId }, timeoutMs);
			if (checked === "no_response") {
				// The daemon has the request and may still post: a local verdict here could contradict it.
				process.stderr.write(
					`tasks check: no daemon answer in ${Math.round(timeoutMs / 1000)}s — 응답 지연 — 게시 여부 모름 (posting unknown; not judged locally)\n`,
				);
				return 1;
			}
			if (checked !== "unreachable" && checked.ok === true) {
				out(checked);
				return 0;
			}
			process.stderr.write(
				checked === "unreachable"
					? "tasks check: daemon not reachable — judging only, nothing posted\n"
					: `tasks check: daemon refused: ${String(checked.error)} — judging only, nothing posted\n`,
			);
		}
		const evaluation = await evaluateTask(row, resolveTaskHost(row.host, dispatchHostsOf(homeDir)));
		if (!evaluation.ok) {
			process.stderr.write(`tasks ${sub}: read failed: ${evaluation.error}\n`);
			out(sub === "show" ? { task: row, history: ledger.history(row.taskId) } : { task: row });
			return 1;
		}
		out({
			task: row,
			judgement: evaluation.judgement,
			summary: summarizeJudgement(evaluation.judgement, row.status),
			...(sub === "show" ? { history: ledger.history(row.taskId) } : {}),
		});
		return 0;
	} catch (error) {
		// A read-only handle does not create the table a ledger without TASKs never had.
		if (error instanceof Error && /no such table: tasks/.test(error.message) && (sub === "list" || sub === "show"))
			return noLedger();
		if (!(error instanceof TaskTransitionError)) throw error;
		process.stderr.write(`tasks ${sub}: ${error.message}\n`);
		return 1;
	} finally {
		ledger.close();
	}
}
