import { constants, Database } from "bun:sqlite";
import { pathToFileURL } from "node:url";
import type { LaneModelTier } from "../config";
import type { LaneQa, LaneReview } from "../lanes/status";
import { localDay } from "../time";
import {
	type AcceptanceItem,
	agentNameOf,
	branchOf,
	formatTaskId,
	readTierConfidence,
	type TaskRisk,
	worktreePathOf,
} from "./docs";

export const TASK_STATUSES = ["working", "blocked", "review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** `core-land`: the core's own landing of a reached local task (`landTask`), which may only close a task in review. */
export type TaskActor = "bot" | "human" | "core-land";

/** Statuses only a human `close` (or, `review → done` alone, the core landing) can reach; a closed task never moves again. */
const HUMAN_ONLY: readonly TaskStatus[] = ["done", "cancelled"];
/** What the bot paths (tool, sweep) may do: working ⇄ blocked, working → review, review → working (resume). */
const BOT_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
	working: ["blocked", "review"],
	blocked: ["working"],
	review: ["working"],
	done: [],
	cancelled: [],
};

export class TaskTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskTransitionError";
	}
}

export interface TaskClock {
	now(): number;
}

export interface TaskRow {
	taskId: string;
	title: string;
	risk: TaskRisk;
	originKey: string;
	threadRef: string;
	/** `dispatchHosts` key; null = the bot's own machine. */
	host: string | null;
	repo: string;
	worktree: string;
	branch: string;
	agent: string;
	status: TaskStatus;
	/** Acceptance criteria exactly as registered. */
	acceptance: AcceptanceItem[];
	createdAt: number;
	updatedAt: number;
	/** PROGRESS.md `updated` as last seen by the sweep (epoch ms). */
	progressAt: number | null;
	remindedAt: number | null;
	/** Notices already posted: key → when. */
	notices: Record<string, number>;
	closedAt: number | null;
	/** The exact model the worker runs on (`lanes.models[tier]` at registration); null = omp's own default. */
	workerModel: string | null;
	/** The worker's model tier; null only for tasks registered before tiers existed. */
	tier: LaneModelTier | null;
	tierReason: string | null;
	/** The judge's confidence in `tier` (0..1); null = none recorded or an unreadable stored value. */
	tierConfidence: number | null;
	/** The independent review and run QA receipts of the task's tips (`recordGate`); null before the first. */
	gate: TaskGate | null;
}

/** The [TASK] gate's receipts, shaped like a lane's meta: each one is bound to the tip it judged (`sha`). */
export interface TaskGate {
	review?: LaneReview;
	qa?: LaneQa;
}

export interface NewTask {
	title: string;
	risk: TaskRisk;
	originKey: string;
	threadRef: string;
	host: string | null;
	repo: string;
	acceptance: AcceptanceItem[];
	/** The worker tier fixed for the task's life (resume and restart included); absent → all three stay null. */
	worker?: { tier: LaneModelTier; tierReason: string; model: string | null; tierConfidence?: number };
}

export const TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
	task_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	risk TEXT NOT NULL,
	origin_key TEXT NOT NULL,
	thread_ref TEXT NOT NULL,
	host TEXT,
	repo TEXT NOT NULL,
	worktree TEXT NOT NULL,
	branch TEXT NOT NULL,
	agent TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('working','blocked','review','done','cancelled')),
	acceptance_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	progress_at INTEGER,
	reminded_at INTEGER,
	notices_json TEXT NOT NULL DEFAULT '{}',
	closed_at INTEGER,
	worker_model TEXT,
	tier TEXT,
	tier_reason TEXT,
	tier_confidence TEXT,
	gate_json TEXT
);
CREATE INDEX IF NOT EXISTS tasks_thread ON tasks(thread_ref);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS task_transitions (
	transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id TEXT NOT NULL REFERENCES tasks(task_id),
	from_status TEXT,
	to_status TEXT NOT NULL,
	actor TEXT NOT NULL CHECK (actor IN ('bot','human','core-land')),
	reason TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_transitions_task ON task_transitions(task_id, transition_id);
`;

/** One append-only line of a task's status history; the registration line has `fromStatus: null`. */
export interface TaskTransitionRow {
	transitionId: number;
	taskId: string;
	fromStatus: TaskStatus | null;
	toStatus: TaskStatus;
	actor: TaskActor;
	reason: string | null;
	at: number;
}

/** Columns added after the first `tasks` schema; rows that predate them read null. */
const LATER_TASK_COLUMNS = ["worker_model", "tier", "tier_reason", "tier_confidence", "gate_json"] as const;

/** Creates the tables in a database that may predate them and adds later columns (idempotent, never touches rows). */
export function migrateTaskSchema(db: Database): void {
	db.run(TASK_SCHEMA);
	const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
	for (const column of LATER_TASK_COLUMNS) {
		if (!columns.some((existing) => existing.name === column)) db.run(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
	}
	migrateTransitionActors(db);
}

/**
 * The `core-land` actor widens a CHECK constraint, which SQLite cannot ALTER: a task_transitions table without it is
 * rebuilt (rename, create, copy, drop) in one transaction. Existing rows keep their ids and data.
 */
function migrateTransitionActors(db: Database): void {
	const current = db
		.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_transitions'")
		.get() as {
		sql: string;
	} | null;
	if (current === null || current.sql.includes("'core-land'")) return;
	const ddl = TASK_SCHEMA.slice(TASK_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS task_transitions"));
	db.transaction(() => {
		db.run("DROP INDEX IF EXISTS task_transitions_task");
		db.run("ALTER TABLE task_transitions RENAME TO task_transitions_old");
		db.run(ddl);
		db.run(
			"INSERT INTO task_transitions (transition_id, task_id, from_status, to_status, actor, reason, at) SELECT transition_id, task_id, from_status, to_status, actor, reason, at FROM task_transitions_old",
		);
		db.run("DROP TABLE task_transitions_old");
	})();
}

export interface TaskSql {
	task_id: string;
	title: string;
	risk: TaskRisk;
	origin_key: string;
	thread_ref: string;
	host: string | null;
	repo: string;
	worktree: string;
	branch: string;
	agent: string;
	status: TaskStatus;
	acceptance_json: string;
	created_at: number;
	updated_at: number;
	progress_at: number | null;
	reminded_at: number | null;
	notices_json: string;
	closed_at: number | null;
	/** Absent on a read-only handle of a ledger the migration has not reached yet. */
	worker_model?: string | null;
	tier?: LaneModelTier | null;
	tier_reason?: string | null;
	tier_confidence?: string | null;
	gate_json?: string | null;
}

interface TransitionSql {
	transition_id: number;
	task_id: string;
	from_status: TaskStatus | null;
	to_status: TaskStatus;
	actor: TaskActor;
	reason: string | null;
	at: number;
}

/**
 * A row's JSON columns, each on its own: an `acceptance_json` that does not parse to an array reads as `[]`, a
 * `notices_json` that does not parse to a plain object as `{}`, and `broken` names the columns that did so. One
 * damaged row never breaks a read of the others.
 */
export function parseTaskJson(
	acceptanceJson: string,
	noticesJson: string,
): { acceptance: AcceptanceItem[]; notices: Record<string, number>; broken: string[] } {
	const parse = (text: string): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	};
	const broken: string[] = [];
	const acceptance = parse(acceptanceJson);
	if (!Array.isArray(acceptance)) broken.push("acceptance_json");
	const notices = parse(noticesJson);
	const plain = typeof notices === "object" && notices !== null && !Array.isArray(notices);
	if (!plain) broken.push("notices_json");
	return {
		acceptance: Array.isArray(acceptance) ? (acceptance as AcceptanceItem[]) : [],
		notices: plain ? (notices as Record<string, number>) : {},
		broken,
	};
}

/** A task row and the JSON columns that were damaged in the database (read as `[]`/`{}`). */
export interface ReadTask {
	row: TaskRow;
	broken: string[];
}

/** A `SELECT * FROM tasks` row as a `TaskRow`, with the JSON columns that were damaged. */
export function readTaskSql(r: TaskSql): ReadTask {
	const { acceptance, notices, broken } = parseTaskJson(r.acceptance_json, r.notices_json);
	const row: TaskRow = {
		taskId: r.task_id,
		title: r.title,
		risk: r.risk,
		originKey: r.origin_key,
		threadRef: r.thread_ref,
		host: r.host,
		repo: r.repo,
		worktree: r.worktree,
		branch: r.branch,
		agent: r.agent,
		status: r.status,
		acceptance,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		progressAt: r.progress_at,
		remindedAt: r.reminded_at,
		notices,
		closedAt: r.closed_at,
		workerModel: r.worker_model ?? null,
		tier: r.tier ?? null,
		tierReason: r.tier_reason ?? null,
		tierConfidence: readTierConfidence(r.tier_confidence),
		gate: parseGate(r.gate_json),
	};
	return { row, broken };
}

/** A `gate_json` value; null when absent or not a plain object (a damaged value counts as no receipt). */
function parseGate(json: string | null | undefined): TaskGate | null {
	if (json === null || json === undefined) return null;
	try {
		const value: unknown = JSON.parse(json);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as TaskGate) : null;
	} catch {
		return null;
	}
}

const toTask = (r: TaskSql): TaskRow => readTaskSql(r).row;

/** The latest `<kind>:<ms>` mark of a task's notices; `0` without one. */
function latestMark(row: TaskRow, kind: "pause" | "unpause"): number {
	const prefix = `${kind}:`;
	const marks = Object.keys(row.notices)
		.filter((key) => key.startsWith(prefix))
		.map((key) => Number(key.slice(prefix.length)))
		.filter((at) => Number.isFinite(at));
	return Math.max(0, ...marks);
}

/**
 * When the current owner pause began (its `pause:<ms>` mark), `undefined` for a task that is not paused. The key of
 * everything told once per pause.
 */
export function taskPausedAt(row: TaskRow): number | undefined {
	const paused = latestMark(row, "pause");
	return paused > latestMark(row, "unpause") ? paused : undefined;
}

/** `T-YYYYMMDD-` (11 characters), then the day's number as an integer: `-100` follows `-99`, not `-10`. */
const TASK_ORDER = "substr(task_id, 1, 11), CAST(substr(task_id, 12) AS INTEGER), task_id";

/** Durable registry of [TASK] work. Works on any database handle, so the CLI uses it without the full `Store`. */
export class TaskLedger {
	readonly #db: Database;
	readonly #clock: TaskClock;
	/** The bot's zone (`config.timezone`): a task id carries the date of this zone's calendar day. */
	readonly #timezone: string;

	constructor(db: Database, options: { clock: TaskClock; timezone: string; readonly?: boolean }) {
		this.#db = db;
		this.#clock = options.clock;
		this.#timezone = options.timezone;
		// A read-only handle cannot create tables, and a ledger it can open already has them.
		if (options.readonly !== true) migrateTaskSchema(db);
	}

	/** Allocates the next `T-YYYYMMDD-NN` of the bot zone's day and inserts the row as `working`, in one transaction. */
	register(input: NewTask): TaskRow {
		return this.#db.transaction(() => {
			const now = this.#clock.now();
			const day = localDay(now, this.#timezone);
			const prefix = `T-${day}-`;
			// Numeric max: as text, `-99` sorts after `-100`, and the 101st id would collide.
			const { last } = this.#db
				.query("SELECT MAX(CAST(substr(task_id, ?) AS INTEGER)) AS last FROM tasks WHERE task_id LIKE ?")
				.get(prefix.length + 1, `${prefix}%`) as { last: number | null };
			const taskId = formatTaskId(day, (last ?? 0) + 1);
			this.#db
				.query(
					`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
						acceptance_json, created_at, updated_at, worker_model, tier, tier_reason, tier_confidence)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					taskId,
					input.title,
					input.risk,
					input.originKey,
					input.threadRef,
					input.host,
					input.repo,
					worktreePathOf(input.repo, taskId),
					branchOf(taskId),
					agentNameOf(taskId),
					JSON.stringify(input.acceptance),
					now,
					now,
					input.worker?.model ?? null,
					input.worker?.tier ?? null,
					input.worker?.tierReason ?? null,
					input.worker?.tierConfidence === undefined ? null : String(input.worker.tierConfidence),
				);
			this.#recordTransition(taskId, null, "working", "bot", "registered", now);
			return this.require(taskId);
		})();
	}

	get(taskId: string): TaskRow | undefined {
		const row = this.#db.query("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskSql | null;
		return row === null ? undefined : toTask(row);
	}

	require(taskId: string): TaskRow {
		const row = this.get(taskId);
		if (row === undefined) throw new TaskTransitionError(`task not found: ${taskId}`);
		return row;
	}

	/** The task bound to a herdr agent on `host` (null = local), if any. */
	getByAgent(agent: string, host: string | null): TaskRow | undefined {
		const row = this.#db.query("SELECT * FROM tasks WHERE agent = ? AND host IS ?").get(agent, host) as TaskSql | null;
		return row === null ? undefined : toTask(row);
	}

	list(): TaskRow[] {
		return (this.#db.query(`SELECT * FROM tasks ORDER BY ${TASK_ORDER}`).all() as TaskSql[]).map(toTask);
	}

	/** Tasks the sweep watches. */
	listActive(): TaskRow[] {
		return (
			this.#db
				.query(`SELECT * FROM tasks WHERE status IN ('working','blocked') ORDER BY ${TASK_ORDER}`)
				.all() as TaskSql[]
		).map(toTask);
	}

	/** Tasks waiting on the owner's review: the sweep re-alerts the ones left there a day or more. */
	listInReview(): TaskRow[] {
		return (
			this.#db.query(`SELECT * FROM tasks WHERE status = 'review' ORDER BY ${TASK_ORDER}`).all() as TaskSql[]
		).map(toTask);
	}

	/** Tasks closed `done` at or after `since` (epoch ms), oldest first: the startup pass of the wiki result notes. */
	listDoneSince(since: number): TaskRow[] {
		return (
			this.#db
				.query(`SELECT * FROM tasks WHERE status = 'done' AND closed_at >= ? ORDER BY closed_at, task_id`)
				.all(since) as TaskSql[]
		).map(toTask);
	}

	/** Whether any task was registered from the conversation `originKey`. */
	hasOrigin(originKey: string): boolean {
		return this.#db.query("SELECT 1 FROM tasks WHERE origin_key = ? LIMIT 1").get(originKey) !== null;
	}

	/** Whether a thread root (`<channel>:<ts>`) carries a registered task. */
	isTaskRoot(threadRef: string): boolean {
		return this.#db.query("SELECT 1 FROM tasks WHERE thread_ref = ? LIMIT 1").get(threadRef) !== null;
	}

	/** Every task registered in a thread (`<channel>:<ts>`), in id order; a thread may carry more than one. */
	getByThread(threadRef: string): TaskRow[] {
		return (
			this.#db.query(`SELECT * FROM tasks WHERE thread_ref = ? ORDER BY ${TASK_ORDER}`).all(threadRef) as TaskSql[]
		).map(toTask);
	}

	/** Whether the owner paused the task: its latest `pause:` mark is later than its latest `unpause:` mark. */
	isPaused(row: TaskRow): boolean {
		return taskPausedAt(row) !== undefined;
	}

	/**
	 * Owner pause of a working or blocked task: a `pause:<ms>` notice mark, never a status move, so the sweep's
	 * judging and every transition stay as they are. Pausing a paused task keeps its first mark.
	 */
	pauseTask(taskId: string): TaskRow {
		return this.#db.transaction(() => {
			const row = this.require(taskId);
			if (row.status !== "working" && row.status !== "blocked") {
				throw new TaskTransitionError(`${taskId}: ${row.status} 작업은 멈출 수 없습니다(working·blocked만)`);
			}
			if (this.isPaused(row)) return row;
			return this.#writePauseMark(row, "pause", "unpause");
		})();
	}

	/** Lifts the owner pause (an `unpause:<ms>` mark); a task that is not paused is returned as it is. */
	unpauseTask(taskId: string): TaskRow {
		return this.#db.transaction(() => {
			const row = this.require(taskId);
			if (!this.isPaused(row)) return row;
			return this.#writePauseMark(row, "unpause", "pause");
		})();
	}

	/** One `<kind>:<ms>` mark, strictly later than every `<opposite>:` mark even within one clock millisecond. */
	#writePauseMark(row: TaskRow, kind: "pause" | "unpause", opposite: "pause" | "unpause"): TaskRow {
		const at = Math.max(this.#clock.now(), latestMark(row, opposite) + 1);
		const notices = { ...row.notices, [`${kind}:${at}`]: at };
		this.#db.query("UPDATE tasks SET notices_json = ? WHERE task_id = ?").run(JSON.stringify(notices), row.taskId);
		return this.require(row.taskId);
	}

	/**
	 * Moves a task. The bot (`actor: "bot"`) can never reach `done`/`cancelled`; only a human close does, from any
	 * open state, and the core landing (`actor: "core-land"`) from `review` to `done` alone. Closed tasks never move. Same-state moves are no-ops. Each real move appends one history line in the
	 * same transaction.
	 */
	transition(taskId: string, to: TaskStatus, actor: TaskActor, reason?: string): TaskRow {
		return this.#db.transaction(() => {
			const row = this.require(taskId);
			if (row.status === to) return row;
			if (actor === "bot" && HUMAN_ONLY.includes(to)) {
				throw new TaskTransitionError(`${taskId}: ${to}는 사람의 close로만 갈 수 있습니다`);
			}
			if (row.status === "done" || row.status === "cancelled") {
				throw new TaskTransitionError(`${taskId}: 이미 ${row.status}로 닫힌 작업입니다`);
			}
			if (actor === "core-land" && !(row.status === "review" && to === "done")) {
				throw new TaskTransitionError(`${taskId}: 코어 착지는 review → done만 옮깁니다(${row.status} → ${to})`);
			}
			if (actor === "human" && !HUMAN_ONLY.includes(to)) {
				throw new TaskTransitionError(`${taskId}: 사람은 done·cancelled로만 옮깁니다`);
			}
			if (actor === "bot" && !BOT_TRANSITIONS[row.status].includes(to)) {
				throw new TaskTransitionError(`${taskId}: ${row.status} → ${to} 전이는 허용되지 않습니다`);
			}
			const now = this.#clock.now();
			this.#db
				.query("UPDATE tasks SET status = ?, updated_at = ?, closed_at = ? WHERE task_id = ?")
				.run(to, now, HUMAN_ONLY.includes(to) ? now : null, taskId);
			this.#recordTransition(taskId, row.status, to, actor, reason ?? null, now);
			return this.require(taskId);
		})();
	}

	/** Merges gate receipts into the task's `gate_json`; a receipt of a kind replaces the one before it. */
	recordGate(taskId: string, patch: TaskGate): TaskRow {
		return this.#db.transaction(() => {
			const gate = { ...(this.require(taskId).gate ?? {}), ...patch };
			this.#db.query("UPDATE tasks SET gate_json = ? WHERE task_id = ?").run(JSON.stringify(gate), taskId);
			return this.require(taskId);
		})();
	}

	/**
	 * Marks a notice key as posted. True only for the call that set it, so the caller posts exactly when it wins —
	 * a repeated sweep over the same state stays silent.
	 */
	recordNotice(taskId: string, key: string): boolean {
		return this.#db.transaction(() => {
			const row = this.require(taskId);
			if (key in row.notices) return false;
			const notices = { ...row.notices, [key]: this.#clock.now() };
			this.#db.query("UPDATE tasks SET notices_json = ? WHERE task_id = ?").run(JSON.stringify(notices), taskId);
			return true;
		})();
	}

	setProgressAt(taskId: string, progressAt: number): void {
		this.#db.query("UPDATE tasks SET progress_at = ? WHERE task_id = ?").run(progressAt, taskId);
	}

	markReminded(taskId: string, at: number): void {
		this.#db.query("UPDATE tasks SET reminded_at = ? WHERE task_id = ?").run(at, taskId);
	}

	/** The task's status history in `transition_id` order (empty for tasks registered before the history existed). */
	history(taskId: string): TaskTransitionRow[] {
		let rows: TransitionSql[];
		try {
			rows = this.#db
				.query("SELECT * FROM task_transitions WHERE task_id = ? ORDER BY transition_id")
				.all(taskId) as TransitionSql[];
		} catch (error) {
			// A read-only handle does not migrate: a ledger from before the history existed has no such table.
			if (error instanceof Error && /no such table: task_transitions/.test(error.message)) return [];
			throw error;
		}
		return rows.map((r) => ({
			transitionId: r.transition_id,
			taskId: r.task_id,
			fromStatus: r.from_status,
			toStatus: r.to_status,
			actor: r.actor,
			reason: r.reason,
			at: r.at,
		}));
	}

	#recordTransition(
		taskId: string,
		from: TaskStatus | null,
		to: TaskStatus,
		actor: TaskActor,
		reason: string | null,
		at: number,
	): void {
		this.#db
			.query(
				"INSERT INTO task_transitions (task_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(taskId, from, to, actor, reason, at);
	}

	/**
	 * Deletes the row of a registration that failed before the agent started (never a started task), with its history
	 * lines first (foreign keys). The only path that removes history lines.
	 */
	discard(taskId: string): void {
		this.#db.transaction(() => {
			if (this.#db.query("SELECT 1 FROM tasks WHERE task_id = ? AND status = 'working'").get(taskId) === null) return;
			this.#db.query("DELETE FROM task_transitions WHERE task_id = ?").run(taskId);
			this.#db.query("DELETE FROM tasks WHERE task_id = ?").run(taskId);
		})();
	}

	close(): void {
		this.#db.close();
	}
}

/**
 * A read-only handle. A WAL ledger on a read-only medium cannot create its -shm/-wal files, so the plain read-only
 * open fails (`SQLITE_READONLY_DIRECTORY`); then the file is read as `immutable` (no locks, no -wal: a medium that
 * cannot be written cannot have a writer either).
 */
function openReadonly(path: string): Database {
	const db = new Database(path, { readonly: true, strict: true });
	try {
		db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
		return db;
	} catch (error) {
		db.close();
		if ((error as { code?: unknown }).code !== "SQLITE_READONLY_DIRECTORY") throw error;
	}
	const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;
	return new Database(`${pathToFileURL(path).href}?immutable=1`, flags);
}

/**
 * Standalone connection for the CLI. `readonly` (the read commands) opens the file without write access: no WAL
 * switch, no table creation, so a read-only medium or a 0444 ledger still lists and shows.
 */
export function openTaskLedger(
	path: string,
	timezone: string,
	clock: TaskClock = { now: () => Date.now() },
	options: { readonly?: boolean } = {},
): TaskLedger {
	if (options.readonly === true) {
		return new TaskLedger(openReadonly(path), { clock, timezone, readonly: true });
	}
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA busy_timeout = 5000");
	return new TaskLedger(db, { clock, timezone });
}
