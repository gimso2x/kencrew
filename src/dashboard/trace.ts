import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../daemon/lock";
import type { LaneHistoryEntry, LaneMeta, LaneStatus } from "../lanes/status";
import { ompSessionDirFor } from "../omp/session-dir";
import { newestSessionFile } from "../omp/session-heal";
import { isRecord } from "../omp/type-guards";
import { redact } from "../redact";
import { oneLine, readTierConfidence } from "../tasks/docs";
import type { TaskStatus } from "../tasks/ledger";
import { agyModelOf } from "../tasks/worker-tier";
import { hostTimezone } from "../time";
import type { BoardCard } from "./board";
import { hasSecretsSegment, isAllowedJobCwd, type JobInfo, jobAllowedRoots, readJobFile } from "./snapshot";
import { readJsonlRecords, readTranscript, type Transcript } from "./trace-transcript";

/**
 * Trace of one turn for the dashboard's waterfall: every model call, tool call and sub-agent of the turn's omp
 * session as a span on the turn's clock. Read-only (one `readonly` database handle, the session files read whole).
 */

export type SpanKind = "agent" | "subagent" | "llm" | "tool";
export type SpanStatus = "running" | "done" | "failed";

export interface TraceSpan {
	id: string;
	name: string;
	kind: SpanKind;
	status: SpanStatus;
	/** Ms from the turn's dispatch; `end` is absent while the span runs. */
	start: number;
	end?: number;
	/** A few muted words after the name: the tool's intent, the tools a model call asked for, a sub-agent's model. */
	detail?: string;
	model?: string;
	/** The span's own numbers; agents add up their children on the page. */
	tokensIn?: number;
	tokensOut?: number;
	cost?: number;
	error?: string;
	children?: TraceSpan[];
	/** Set on a TASK's or lane's span (the workers the turn delegated to); absent on tools and in-turn sub-agents. */
	worker?: TraceWorker;
}

/** What the turn recorded about a worker's tier choice; each part is null when the row has none (or no such column). */
export interface TraceWorker {
	source: "task" | "lane";
	tier: string | null;
	tierReason: string | null;
	/** 0..1; a stored value that is not a number in that range reads null. */
	tierConfidence: number | null;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "replied";

/** An owner approval the turn's conversation asked for inside the turn window (summary masked, one line). */
export interface TraceApproval {
	id: string;
	summary: string;
	status: ApprovalStatus;
	createdAt: number;
	decidedAt: number | null;
}

export type TraceError =
	| "no_database"
	| "unknown_turn"
	| "not_dispatched"
	| "no_session"
	| "unsupported_card"
	| "unknown_job";

export type TurnTrace =
	| {
			ok: true;
			/** Absent on a worker card's trace, which has no inbound row. */
			inboundId?: number;
			startedAt: number;
			now: number;
			live: boolean;
			truncated: boolean;
			root: TraceSpan;
			/** Only a turn trace has it: the approvals of the turn's origin created inside the turn window, oldest first. */
			approvals?: TraceApproval[];
	  }
	| { ok: false; error: TraceError };

/**
 * The turn's root span over its transcript's spans and the workers it delegated to.
 */
function turnRoot(main: Transcript, live: boolean, failed: boolean, workers: TraceSpan[] = []): TraceSpan {
	// The session goes on past the turn (memory notes, the next request): a finished turn ends with its last span
	// (or its latest worker's end, when that runs longer).
	const lastEnd = Math.max(0, ...[...main.spans, ...workers].map((span) => span.end ?? span.start));
	return {
		id: "turn",
		name: "턴",
		kind: "agent",
		status: live ? "running" : failed ? "failed" : "done",
		start: 0,
		...(live ? {} : { end: lastEnd }),
		...(main.model === undefined ? {} : { model: main.model }),
		children: workers.length === 0 ? main.spans : [...main.spans, ...workers].sort((a, b) => a.start - b.start),
	};
}

/**
 * The trace of a worker's session file: its last turn, from the last `user` message to the end. A session with no
 * `user` message has no turn (`no_session`).
 */
export function readSessionTrace(file: string, now: number, live: boolean): TurnTrace {
	let startedAt: number | undefined;
	for (const entry of readJsonlRecords(file)) {
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		const at = Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "");
		if (message?.role === "user" && !Number.isNaN(at)) startedAt = at;
	}
	if (startedAt === undefined) return { ok: false, error: "no_session" };
	const main = readTranscript(file, { from: startedAt, to: Number.POSITIVE_INFINITY, live, origin: startedAt });
	return {
		ok: true,
		startedAt,
		now,
		live,
		truncated: main.truncated,
		root: turnRoot(main, live, main.ending === "failed"),
	};
}

/** Trace of the newest omp session file in `cwd`'s session folder (its last turn). */
export function readCwdTrace(
	cwd: string | null | undefined,
	live: boolean,
	where: { userHome: string; sessionsRoot: string; now: number },
): TurnTrace {
	if (cwd === null || cwd === undefined || cwd === "") return { ok: false, error: "no_session" };
	const dir = ompSessionDirFor(cwd, where.userHome, where.sessionsRoot);
	const file = existsSync(dir) ? newestSessionFile(dir) : undefined;
	if (file === undefined) return { ok: false, error: "no_session" };
	return readSessionTrace(file, where.now, live);
}

/** A worker card's trace: its omp session folder (by cwd) newest file. Only local omp cards. */
export function readCardTrace(
	card: Pick<BoardCard, "local" | "agent" | "cwd" | "status">,
	where: { userHome: string; sessionsRoot: string; now: number },
): TurnTrace {
	if (!card.local || card.agent !== "omp") return { ok: false, error: "unsupported_card" };
	return readCwdTrace(card.cwd, card.status === "working", where);
}

/**
 * A background job's trace: its omp session folder (by `cwd`) newest file.
 * Dead and finished jobs are traced as non-live; when `homeDir` is given, `cwd` must sit inside allowed job roots
 * without any `secrets` component.
 */
export function readJobTrace(
	job: Pick<JobInfo, "state" | "health"> & { cwd?: string | null },
	where: { userHome: string; sessionsRoot: string; now: number; homeDir?: string },
): TurnTrace {
	const cwd = job.cwd;
	if (cwd === null || cwd === undefined || cwd === "" || hasSecretsSegment(cwd)) {
		return { ok: false, error: "no_session" };
	}
	if (where.homeDir !== undefined) {
		const roots = jobAllowedRoots(where.homeDir, where.userHome);
		if (!isAllowedJobCwd(cwd, roots)) return { ok: false, error: "no_session" };
	}
	const live = job.state === "running" && job.health !== "dead";
	return readCwdTrace(cwd, live, where);
}

/** Reads `<homeDir>/jobs/<name>.json` and returns its `cwd`-based omp trace, or `unknown_job` when absent. */
export function readJobTraceByName(
	homeDir: string,
	name: string,
	where: { userHome: string; sessionsRoot: string; now: number; isAlive?: (pid: number) => boolean; timezone?: string },
): TurnTrace {
	const found = readJobFile(homeDir, name, where.now, where.isAlive ?? pidAlive, where.timezone ?? hostTimezone());
	if (found === undefined) return { ok: false, error: "unknown_job" };
	return readJobTrace(
		{ state: found.job.state, health: found.job.health, cwd: found.rawCwd ?? found.job.cwd },
		{ ...where, homeDir },
	);
}

export interface TraceWhere {
	userHome: string;
	sessionsRoot: string;
}

/**
 * The dispatch times of the conversation's real turns, oldest first. Not every dispatched row starts a turn: a steer
 * (mailbox.ts `#steer`, `markDispatched` with the running turn's `opRef`) and a dialog answer (the same `opRef`) join
 * the turn already running, and an inline command (`!stop`, `!btw`, `!home`: mailbox.ts `markDispatched(…, entryCursor:
 * null)`) or a failed dispatch (`failed:` op_ref, `entryCursor: null`) never reaches omp. Only `#dispatch`'s
 * `markDispatched(row, { opRef, entryCursor })` (driver.prompt) leaves a cursor and a fresh `op_ref`.
 */
function turnStarts(db: Database, originKey: string): number[] {
	return db
		.query<{ at: number }, [string]>(
			`SELECT i.dispatched_at AS at FROM inbound i
			 WHERE i.origin_key = ? AND i.dispatched_at IS NOT NULL AND i.entry_cursor IS NOT NULL
			   AND NOT EXISTS (SELECT 1 FROM inbound e WHERE e.origin_key = i.origin_key AND e.op_ref = i.op_ref AND e.inbound_id < i.inbound_id)
			 ORDER BY i.dispatched_at`,
		)
		.all(originKey)
		.map((row) => row.at);
}

/** What a worker's status shows: only `working` runs; `review` waits for a verdict, the worker itself is finished. */
const TASK_SPAN_STATUS: Record<TaskStatus, SpanStatus> = {
	working: "running",
	review: "done",
	done: "done",
	blocked: "failed",
	cancelled: "failed",
};
const LANE_SPAN_STATUS: Record<LaneStatus, SpanStatus> = {
	working: "running",
	"done-claimed": "done",
	closed: "done",
	"not-done": "failed",
	paused: "failed",
};

/** One worker found for the turn, before its span is built. */
interface Worker {
	id: string;
	status: SpanStatus;
	/** The worker's own start (before the clamp to the turn's dispatch) and its window end. */
	start: number;
	windowEnd: number;
	model: string | null;
	/** The newest omp session file; absent for agy, remote and session-less workers (a bar only). */
	file: string | undefined;
	/** The bar's end when there is no session to read: absent while it runs. */
	barEnd: number | undefined;
	info: TraceWorker;
}

interface TaskRow {
	task_id: string;
	agent: string;
	host: string | null;
	status: TaskStatus;
	worktree: string;
	created_at: number;
	updated_at: number;
	closed_at: number | null;
	worker_model: string | null;
	tier: string | null;
	tier_reason: string | null;
	tier_confidence: string | null;
}

/** The columns of `table` (a read-only handle cannot migrate, so an older database may lack newer ones). */
function columnsOf(db: Database, table: string): Set<string> {
	return new Set(
		db
			.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
			.all()
			.map((column) => column.name),
	);
}

const sessionOf = (dir: string): string | undefined => (existsSync(dir) ? newestSessionFile(dir) : undefined);

/**
 * The TASKs of the turn's origin that the turn made or called, and the lanes it started, inside the turn window
 * `[from, to)`. A TASK is the turn's when it was registered in the window, or when `herdr_prompts` has a start/followup
 * of the same origin and agent in it (a resume or a later instruction). That table keeps only the newest 20 rows per
 * agent and 30 days (store/db.ts `HERDR_PROMPT_ROWS_KEPT`): a follow-up turn older than that no longer finds its
 * worker, and a registration inside the window always does. Lanes only count with a recorded `meta.parentOrigin`
 * (lanes started before it was recorded are not linked).
 */
function findWorkers(
	db: Database,
	originKey: string,
	window: { from: number; to: number },
	starts: number[],
	now: number,
	where: TraceWhere,
): Worker[] {
	const { from, to } = window;
	const workers: Worker[] = [];
	const prompts = db.query<{ at: number }, [string, string, number]>(
		"SELECT at FROM herdr_prompts WHERE origin_key = ? AND agent = ? AND kind IN ('start','followup') AND at >= ? ORDER BY at",
	);
	const taskColumns = columnsOf(db, "tasks");
	const optional = (column: string): string => (taskColumns.has(column) ? column : `NULL AS ${column}`);
	const tasks = db
		.query<TaskRow, [string]>(
			`SELECT task_id, agent, host, status, worktree, created_at, updated_at, closed_at, worker_model, ${optional("tier")}, ${optional("tier_reason")}, ${optional("tier_confidence")} FROM tasks WHERE origin_key = ?`,
		)
		.all(originKey);
	for (const task of tasks) {
		const calls = prompts.all(originKey, task.agent, from).map((row) => row.at);
		const inWindow = calls.find((at) => at < to);
		const registered = task.created_at >= from && task.created_at < to;
		if (!registered && inWindow === undefined) continue;
		// The next turn that called this worker again ends the window (the turn that dispatched before that call).
		const again = calls.find((at) => at >= to);
		const nextCall = again === undefined ? undefined : starts.findLast((at) => at <= again);
		const status = TASK_SPAN_STATUS[task.status];
		const agy = agyModelOf(task.worker_model) !== undefined;
		const local = task.host === null || task.host === "";
		const file =
			!agy && local ? sessionOf(ompSessionDirFor(task.worktree, where.userHome, where.sessionsRoot)) : undefined;
		const finished = task.status === "review" ? task.updated_at : (task.closed_at ?? task.updated_at);
		workers.push({
			id: task.task_id,
			status,
			start: registered ? task.created_at : (inWindow ?? from),
			windowEnd: nextCall ?? task.closed_at ?? now,
			model: task.worker_model,
			file,
			barEnd: status === "running" ? undefined : finished,
			info: {
				source: "task",
				tier: task.tier,
				tierReason: task.tier_reason,
				tierConfidence: readTierConfidence(task.tier_confidence),
			},
		});
	}
	const lanes = db
		.query<
			{ name: string; status: LaneStatus; history: string; meta: string; session_dir: string; created_at: number },
			[number, number]
		>("SELECT name, status, history, meta, session_dir, created_at FROM lanes WHERE created_at >= ? AND created_at < ?")
		.all(from, to);
	for (const lane of lanes) {
		const meta = JSON.parse(lane.meta) as LaneMeta;
		if (meta.parentOrigin !== originKey) continue;
		const history = JSON.parse(lane.history) as LaneHistoryEntry[];
		const closed = lane.status === "working" ? undefined : history.findLast((entry) => entry.event === "closed")?.at;
		const status = LANE_SPAN_STATUS[lane.status];
		workers.push({
			id: meta.laneId ?? lane.name,
			status,
			start: lane.created_at,
			windowEnd: closed ?? now,
			model: meta.workerModel ?? null,
			file: sessionOf(lane.session_dir),
			barEnd: status === "running" ? undefined : (closed ?? now),
			info: {
				source: "lane",
				tier: meta.tier ?? null,
				tierReason: meta.tierReason ?? null,
				tierConfidence: readTierConfidence(meta.tierConfidence),
			},
		});
	}
	return workers;
}

/** A worker's spans start and end on the turn's clock, never before its dispatch (the model call that began earlier). */
function clampSpan(span: TraceSpan): TraceSpan {
	const start = Math.max(0, span.start);
	return {
		...span,
		start,
		...(span.end === undefined ? {} : { end: Math.max(start, span.end) }),
		...(span.children === undefined ? {} : { children: span.children.map(clampSpan) }),
	};
}

/**
 * A worker as a child span of the turn. An omp worker holds its session's spans inside its window (ids prefixed with
 * the worker's id); an agy, remote or session-less one is a bar with its model and status only: agy's own conversation
 * store is not read.
 */
function workerSpan(worker: Worker, turnStart: number): { span: TraceSpan; truncated: boolean } {
	const start = Math.max(worker.start, turnStart);
	const running = worker.status === "running";
	const model = (worker.model ?? undefined) as string | undefined;
	if (worker.file === undefined) {
		const end = worker.barEnd === undefined ? undefined : Math.max(start, worker.barEnd) - turnStart;
		return {
			truncated: false,
			span: {
				id: worker.id,
				name: worker.id,
				kind: "subagent",
				status: worker.status,
				start: start - turnStart,
				...(end === undefined ? {} : { end }),
				detail: `${model ?? "모델 미상"} · 단계 기록 없음`,
				...(model === undefined ? {} : { model }),
				worker: worker.info,
			},
		};
	}
	const transcript = readTranscript(
		worker.file,
		{ from: start, to: worker.windowEnd, live: running, origin: turnStart },
		{ depth: 0, prefix: `${worker.id}/` },
	);
	const children = transcript.spans.map(clampSpan);
	const shown = model ?? transcript.model;
	const last = Math.max(0, ...children.map((child) => child.end ?? child.start));
	const end = running
		? undefined
		: Math.max(
				start - turnStart,
				transcript.lastIn === undefined ? (worker.barEnd ?? start) - turnStart : transcript.lastIn - turnStart,
				last,
			);
	return {
		truncated: transcript.truncated,
		span: {
			id: worker.id,
			name: worker.id,
			kind: "subagent",
			status: worker.status,
			start: start - turnStart,
			...(end === undefined ? {} : { end }),
			...(shown === undefined ? {} : { detail: shown, model: shown }),
			children,
			worker: worker.info,
		},
	};
}

const APPROVAL_SUMMARY_CHARS = 120;

/**
 * The approvals of `originKey` created in `[from, to)`, oldest first. A pending one past its expiry reads `expired`
 * (the same rule as the snapshot's `waitingOnOwner`). A database without the table or its origin/expiry columns has none.
 */
function readApprovals(
	db: Database,
	originKey: string,
	window: { from: number; to: number },
	now: number,
): TraceApproval[] {
	const columns = columnsOf(db, "approvals");
	if (!columns.has("origin_key") || !columns.has("expires_at")) return [];
	return db
		.query<
			{
				approval_id: string;
				summary: string;
				status: ApprovalStatus;
				created_at: number;
				expires_at: number;
				decided_at: number | null;
			},
			[string, number, number]
		>(
			"SELECT approval_id, summary, status, created_at, expires_at, decided_at FROM approvals WHERE origin_key = ? AND created_at >= ? AND created_at < ? ORDER BY created_at, rowid",
		)
		.all(originKey, window.from, window.to)
		.map((row) => ({
			id: row.approval_id,
			summary: redact(oneLine(row.summary)).slice(0, APPROVAL_SUMMARY_CHARS),
			status: row.status === "pending" && row.expires_at <= now ? "expired" : row.status,
			createdAt: row.created_at,
			decidedAt: row.decided_at,
		}));
}

/**
 * The trace of inbound row `inboundId`: its origin's current session file, from the row's dispatch to the next real
 * turn's dispatch of the same conversation (or now), with the TASKs and lanes that turn delegated to as child spans.
 * A pending row has no trace yet.
 */
export function readTurnTrace(homeDir: string, inboundId: number, now: number, where: TraceWhere): TurnTrace {
	const dbPath = join(homeDir, "ompbot.db");
	if (!existsSync(dbPath)) return { ok: false, error: "no_database" };
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		const turn = db
			.query<{ origin_key: string; state: string; dispatched_at: number | null }, [number]>(
				"SELECT origin_key, state, dispatched_at FROM inbound WHERE inbound_id = ?",
			)
			.get(inboundId);
		if (turn === null) return { ok: false, error: "unknown_turn" };
		if (turn.dispatched_at === null) return { ok: false, error: "not_dispatched" };
		const startedAt = turn.dispatched_at;
		const starts = turnStarts(db, turn.origin_key);
		const to = starts.find((at) => at > startedAt) ?? Number.POSITIVE_INFINITY;
		const origin = db
			.query<{ session_dir: string; session_file: string | null }, [string]>(
				"SELECT session_dir, session_file FROM origins WHERE origin_key = ?",
			)
			.get(turn.origin_key);
		const file = origin === null ? undefined : (origin.session_file ?? sessionOf(origin.session_dir));
		if (file === undefined || !existsSync(file)) return { ok: false, error: "no_session" };
		const turnLive = turn.state === "dispatched";
		const main = readTranscript(file, { from: startedAt, to, live: turnLive, origin: startedAt });
		const built = findWorkers(db, turn.origin_key, { from: startedAt, to }, starts, now, where).map((worker) =>
			workerSpan(worker, startedAt),
		);
		const workers = built.map((entry) => entry.span);
		const live = turnLive || workers.some((span) => span.status === "running");
		return {
			ok: true,
			inboundId,
			startedAt,
			now,
			live,
			truncated: main.truncated || built.some((entry) => entry.truncated),
			root: turnRoot(main, live, turn.state === "failed_notified", workers),
			approvals: readApprovals(db, turn.origin_key, { from: startedAt, to }, now),
		};
	} finally {
		db.close();
	}
}
