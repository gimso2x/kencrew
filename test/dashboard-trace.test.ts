import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardSource } from "../src/dashboard/board";
import { renderDashboardPage } from "../src/dashboard/html";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { readTurnTrace, type TraceError, type TraceSpan, type TurnTrace } from "../src/dashboard/trace";
import { flowDoing, renderFlow, renderTrace, type TraceViewState } from "../src/dashboard/trace-view";
import { ompSessionDirFor } from "../src/omp/session-dir";
import { openStore } from "../src/store/db";

const T0 = Date.parse("2026-11-05T10:00:00Z");
const NOW = T0 + 60_000;
let home: string;
let sessionFile: string;
/** The omp session root the trace reader finds a TASK worker's folder under. */
const where = () => ({ userHome: join(home, "user"), sessionsRoot: join(home, "omp-sessions") });

const iso = (offset: number): string => new Date(T0 + offset).toISOString();
const put = (file: string, entry: unknown): void => appendFileSync(file, `${JSON.stringify(entry)}\n`);
const assistant = (id: string, start: number, end: number, extra: Record<string, unknown>) => ({
	type: "message",
	id,
	timestamp: iso(end),
	message: { role: "assistant", model: "opus", timestamp: T0 + start, completedAt: T0 + end, ...extra },
});
const call = (id: string, name: string, intent: string) => ({ type: "toolCall", id, name, arguments: { i: intent } });
const result = (callId: string, at: number, isError = false, text = "ok") => ({
	type: "message",
	id: `r-${callId}`,
	timestamp: iso(at),
	message: { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text }] },
});

/** One conversation with turn 1 dispatched at T0 (in `state`) and, when given, turn 2 dispatched at `nextAt`. */
function seed(state: string, nextAt?: number): void {
	const dbPath = join(home, "ompbot.db");
	openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const sessionDir = join(home, "sessions", "o", "e1");
	mkdirSync(sessionDir, { recursive: true });
	sessionFile = join(sessionDir, "s.jsonl");
	const db = new Database(dbPath, { strict: true });
	db.run(
		"INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES ('discord/dm/200000000000000001', 1, ?, ?)",
		[sessionDir, T0],
	);
	// A real turn leaves an omp cursor and its own op_ref (mailbox `#dispatch`); a steer shares the turn's op_ref.
	const add = (id: string, rowState: string, at: number | null) =>
		db.run(
			`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, op_ref, entry_cursor)
			 VALUES (?, 'discord/dm/200000000000000001', 1, 'x', ?, ?, ?, ?, ?)`,
			[id, rowState, T0 - 1000, at, at === null ? null : `op-${id}`, at === null ? null : `cursor-${id}`],
		);
	add("m1", state, T0);
	add("m2", "pending", null);
	if (nextAt !== undefined) add("m3", "dispatched", T0 + nextAt);
	db.close();
	put(sessionFile, { type: "session", timestamp: iso(-60_000) });
	put(sessionFile, { type: "model_change", timestamp: iso(-60_000), model: "anthropic/opus" });
	// The turn before: never part of this trace.
	put(sessionFile, assistant("old", -50_000, -40_000, { stopReason: "stop", content: [] }));
	put(sessionFile, { type: "message", id: "u1", timestamp: iso(200), message: { role: "user", content: [] } });
}

const shape = (span: TraceSpan) => [span.id, span.kind, span.status, span.start, span.end];
const traceOf = (now = NOW): Extract<TurnTrace, { ok: true }> => {
	const trace = readTurnTrace(home, 1, now, where());
	if (!trace.ok) throw new Error(trace.error);
	return trace;
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-trace-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("turn trace reader", () => {
	test("a live turn: model calls with tokens and cost, tool waits, a failed tool's masked error, the call being generated now", () => {
		seed("dispatched");
		put(
			sessionFile,
			assistant("a1", 1000, 3000, {
				stopReason: "toolUse",
				usage: { input: 2, cacheRead: 900, cacheWrite: 100, output: 50, cost: { total: 0.25 } },
				content: [call("t1", "read", "Reading the log"), call("t2", "bash", "Using sk-TESTKEY123 to probe")],
			}),
		);
		put(sessionFile, result("t1", 3500));
		put(sessionFile, result("t2", 8000, true, "exit 1 with xoxb-TEST-0\nmore"));
		const trace = traceOf();
		const [model, read, bash, pending] = trace.root.children ?? [];
		expect([trace.live, trace.root.status, trace.root.end]).toEqual([true, "running", undefined]);
		expect((trace.root.children ?? []).map(shape)).toEqual([
			["a1", "llm", "done", 1000, 3000],
			["t1", "tool", "done", 3000, 3500],
			["t2", "tool", "failed", 3000, 8000],
			["pending-model", "llm", "running", 8000, undefined],
		]);
		expect(model).toMatchObject({ tokensIn: 1002, tokensOut: 50, cost: 0.25, detail: "→ read · bash" });
		expect(read?.detail).toBe("Reading the log");
		expect([bash?.detail, bash?.error]).toEqual(["Using [REDACTED] to probe", "exit 1 with [REDACTED] more"]);
		expect(pending?.detail).toBe("응답 생성 중");
	});

	test("a finished turn stops at the next dispatch, fails a tool call never answered and ends with its last span", () => {
		seed("answered", 20_000);
		put(sessionFile, assistant("a1", 1000, 2000, { stopReason: "toolUse", content: [call("t1", "bash", "x")] }));
		put(sessionFile, { type: "custom", timestamp: iso(9000) });
		put(sessionFile, assistant("a2", 21_000, 25_000, { stopReason: "stop", content: [] }));
		const trace = traceOf();
		expect((trace.root.children ?? []).map(shape)).toEqual([
			["a1", "llm", "done", 1000, 2000],
			["t1", "tool", "failed", 2000, 2000],
		]);
		expect([trace.live, trace.root.status, trace.root.end]).toEqual([false, "done", 2000]);
	});

	test("sub-agents beside the session are children with ids of their own; a stopped one ends at its last message", () => {
		seed("dispatched");
		put(sessionFile, assistant("a1", 1000, 2000, { stopReason: "toolUse", content: [call("t1", "task", "Spawning")] }));
		put(sessionFile, result("t1", 2100));
		mkdirSync(sessionFile.replace(/\.jsonl$/, ""));
		const sub = join(sessionFile.replace(/\.jsonl$/, ""), "Scout.jsonl");
		put(sub, { type: "session", timestamp: iso(2050) });
		put(sub, { type: "model_change", timestamp: iso(2050), model: "anthropic/sonnet" });
		put(
			sub,
			assistant("a1", 2100, 5000, { stopReason: "stop", usage: { output: 9, cost: { total: 0.5 } }, content: [] }),
		);
		put(sub, { type: "custom", timestamp: iso(40_000) });
		const scout = (traceOf().root.children ?? []).find((span) => span.kind === "subagent");
		expect(scout && shape(scout)).toEqual(["agent:Scout", "subagent", "done", 2050, 5000]);
		expect(scout?.detail).toBe("anthropic/sonnet");
		expect((scout?.children ?? []).map(shape)).toEqual([["agent:Scout/a1", "llm", "done", 2100, 5000]]);
	});

	test.each<[number, TraceError]>([
		[2, "not_dispatched"],
		[99, "unknown_turn"],
	])("inbound %i has no trace: %s", (id, error) => {
		seed("dispatched");
		expect(readTurnTrace(home, id, NOW, where())).toEqual({ ok: false, error });
	});
});

/** Rows the delegated workers leave: TASKs, their prompts, lanes, and the omp session files they wrote. */
const ORIGIN = "discord/dm/200000000000000001";
const withDb = (fn: (db: Database) => void): void => {
	const db = new Database(join(home, "ompbot.db"), { strict: true });
	try {
		fn(db);
	} finally {
		db.close();
	}
};
function addTask(
	id: string,
	at: number,
	extra: {
		origin?: string;
		status?: string;
		model?: string | null;
		closed?: number | null;
		updated?: number;
		host?: string | null;
		agent?: string;
	} = {},
): string {
	const worktree = join(home, "wt", id);
	withDb((db) =>
		db.run(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
			   acceptance_json, created_at, updated_at, closed_at, worker_model)
			 VALUES (?, 't', 'L2', ?, 'D1:1', ?, '/r', ?, 'b', ?, ?, '[]', ?, ?, ?, ?)`,
			[
				id,
				extra.origin ?? ORIGIN,
				extra.host ?? null,
				worktree,
				extra.agent ?? `agent-${id}`,
				extra.status ?? "done",
				T0 + at,
				T0 + (extra.updated ?? at),
				extra.closed === undefined || extra.closed === null ? null : T0 + extra.closed,
				extra.model === undefined ? "zai/glm-5.3" : extra.model,
			],
		),
	);
	return ompSessionDirFor(worktree, where().userHome, where().sessionsRoot);
}
const addPrompt = (agent: string, kind: string, at: number): void =>
	withDb((db) =>
		db.run("INSERT INTO herdr_prompts (host, agent, kind, preview, origin_key, at) VALUES ('', ?, ?, 'p', ?, ?)", [
			agent,
			kind,
			ORIGIN,
			T0 + at,
		]),
	);
function addLane(
	name: string,
	at: number,
	extra: { parent?: string; status?: string; closed?: number; model?: string } = {},
): string {
	const sessionDir = join(home, "lane-sessions", name);
	const meta = {
		startedAt: T0 + at,
		lastProgressAt: T0 + at,
		steerSeq: 0,
		laneId: `L-${name}`,
		workerModel: extra.model ?? "zai/glm-5.3",
		...(extra.parent === undefined ? {} : { parentOrigin: extra.parent }),
	};
	const history = [
		{ at: T0 + at, event: "created" },
		...(extra.closed === undefined ? [] : [{ at: T0 + extra.closed, event: "closed" }]),
	];
	withDb((db) =>
		db.run(
			`INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, status, history, meta, created_at, updated_at)
			 VALUES (?, 't', ?, ?, '/r', ?, ?, ?, ?, ?, ?)`,
			[
				name,
				`D1:${name}`,
				`ompbot/work/${name}`,
				sessionDir,
				extra.status ?? "closed",
				JSON.stringify(history),
				JSON.stringify(meta),
				T0 + at,
				T0 + at,
			],
		),
	);
	return sessionDir;
}
/** A worker session with one model call (`start`..`end`) and an optional model_change; written into `dir`. */
function writeWorker(dir: string, model: string, calls: Array<[number, number]>): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "w.jsonl");
	put(file, { type: "session", timestamp: iso(-90_000) });
	put(file, { type: "model_change", timestamp: iso(-90_000), model });
	for (const [start, end] of calls) {
		put(
			file,
			assistant(`w${start}`, start, end, {
				stopReason: "stop",
				model,
				usage: { output: 5, cost: { total: 0.1 } },
				content: [],
			}),
		);
	}
	return file;
}
const byId = (trace: Extract<TurnTrace, { ok: true }>, id: string) =>
	trace.root.children?.find((span) => span.id === id);
const ids = (span: TraceSpan): string[] => [span.id, ...(span.children ?? []).flatMap(ids)];

describe("delegated workers in the turn trace", () => {
	test("a TASK (omp and agy) made in the turn window and a lane it started hang under the turn root; agy is a bar", () => {
		seed("answered", 20_000);
		writeWorker(addTask("T-OMP", 2000, { closed: 9000 }), "zai/glm-5.3", [[3000, 5000]]);
		addTask("T-AGY", 3000, { status: "working", model: "agy:gemini-3.8-flash" });
		writeWorker(addLane("lane-a", 4000, { parent: ORIGIN, closed: 12_000 }), "anthropic/sonnet", [[5000, 8000]]);
		const trace = traceOf();
		const workers = (trace.root.children ?? []).filter((span) => span.kind === "subagent");
		expect(workers.map((span) => span.id)).toEqual(["T-OMP", "T-AGY", "L-lane-a"]);
		const omp = byId(trace, "T-OMP");
		expect([omp?.status, omp?.detail, omp?.model]).toEqual(["done", "zai/glm-5.3", "zai/glm-5.3"]);
		expect(omp?.children?.map((child) => [child.id, child.kind, child.model, child.start, child.end])).toEqual([
			["T-OMP/w3000", "llm", "zai/glm-5.3", 3000, 5000],
		]);
		const lane = byId(trace, "L-lane-a");
		expect([lane && shape(lane), lane?.children?.[0]?.id]).toEqual([
			["L-lane-a", "subagent", "done", 4000, 8000],
			"L-lane-a/w5000",
		]);
		expect(lane?.children?.[0]?.model).toBe("anthropic/sonnet");
		const agy = byId(trace, "T-AGY");
		expect([agy && shape(agy), agy?.model, agy?.children, agy?.detail]).toEqual([
			["T-AGY", "subagent", "running", 3000, undefined],
			"agy:gemini-3.8-flash",
			undefined,
			"agy:gemini-3.8-flash · 단계 기록 없음",
		]);
		expect(trace.root.children?.map((span) => span.start)).toEqual(
			[...(trace.root.children ?? []).map((span) => span.start)].sort((a, b) => a - b),
		);
	});

	test("only this turn's workers: another window, another origin, a lane without or with another parentOrigin stay out; a followup-only TASK joins with starts at or after 0", () => {
		seed("answered", 20_000);
		addTask("T-BEFORE", -5000, { closed: -1000 });
		addTask("T-LATER", 25_000);
		addTask("T-OTHER", 1000, { origin: "discord/dm/200000000000000002" });
		writeWorker(addLane("lane-none", 3000), "zai/glm-5.3", [[3500, 4000]]);
		writeWorker(addLane("lane-other", 3000, { parent: "discord/dm/200000000000000002" }), "zai/glm-5.3", [
			[3500, 4000],
		]);
		const dir = addTask("T-FU", -100_000, { closed: 15_000, agent: "fu" });
		// One call began before the followup and ended inside the window; one ended before the window.
		writeWorker(dir, "zai/glm-5.3", [
			[-60_000, -50_000],
			[-3000, 7000],
			[8000, 9000],
		]);
		addPrompt("fu", "start", -100_000);
		addPrompt("fu", "followup", 6000);
		const trace = traceOf();
		expect((trace.root.children ?? []).map((span) => span.id)).toEqual(["T-FU"]);
		const fu = byId(trace, "T-FU");
		expect(fu?.start).toBe(6000);
		const all = [fu, ...(fu?.children ?? [])];
		expect(all.every((span) => (span?.start ?? -1) >= 0)).toBe(true);
		expect((fu?.children ?? []).map((child) => child.id)).toEqual(["T-FU/w-3000", "T-FU/w8000"]);
	});

	test("a worker the turn's window never reached is not linked by a prompt of another agent or a mere remind", () => {
		seed("answered", 20_000);
		addTask("T-NOPROMPT", -100_000, { closed: 15_000, agent: "np" });
		addPrompt("someone-else", "followup", 6000);
		addPrompt("np", "remind", 6000);
		expect((traceOf().root.children ?? []).map((span) => span.id)).toEqual([]);
	});

	test("an answered turn is live while a worker works (no root end), ends with the latest worker once all are done, and a review worker is not running", () => {
		seed("answered", 20_000);
		addTask("T-W", 3000, { status: "working", model: "agy:g" });
		const live = traceOf();
		expect([live.live, live.root.status, live.root.end]).toEqual([true, "running", undefined]);
		withDb((db) =>
			db.run("UPDATE tasks SET status = 'done', closed_at = ?, updated_at = ? WHERE task_id = 'T-W'", [
				T0 + 14_000,
				T0 + 14_000,
			]),
		);
		const done = traceOf();
		expect([done.live, done.root.status, done.root.end, byId(done, "T-W")?.end]).toEqual([
			false,
			"done",
			14_000,
			14_000,
		]);
		withDb((db) =>
			db.run("UPDATE tasks SET status = 'review', closed_at = NULL, updated_at = ? WHERE task_id = 'T-W'", [
				T0 + 11_000,
			]),
		);
		const review = traceOf();
		expect([review.live, byId(review, "T-W")?.status, byId(review, "T-W")?.end, review.root.end]).toEqual([
			false,
			"done",
			11_000,
			11_000,
		]);
	});

	test("span ids stay unique across the turn and its workers, a pending model call included", () => {
		seed("dispatched");
		const dir = addTask("T-RUN", 1000, { status: "working" });
		const file = writeWorker(dir, "zai/glm-5.3", []);
		put(file, { type: "message", id: "wu", timestamp: iso(3000), message: { role: "user", content: [] } });
		const trace = traceOf();
		const all = ids(trace.root);
		expect(all.filter((id) => id.endsWith("pending-model")).sort()).toEqual(["T-RUN/pending-model", "pending-model"]);
		expect(new Set(all).size).toBe(all.length);
		expect(byId(trace, "T-RUN")?.end).toBeUndefined();
	});

	test("a steer row of the same op_ref does not cut the turn; the next real turn does", () => {
		seed("answered", 20_000);
		withDb((db) =>
			db.run(
				`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, op_ref, entry_cursor)
				 VALUES ('steer', ?, 1, 'x', 'answered', ?, ?, 'op-m1', 'cursor-steer')`,
				[ORIGIN, T0 + 4000, T0 + 4000],
			),
		);
		put(sessionFile, assistant("a1", 1000, 2000, { stopReason: "stop", content: [] }));
		put(sessionFile, assistant("after-steer", 6000, 7000, { stopReason: "stop", content: [] }));
		put(sessionFile, assistant("next-turn", 21_000, 22_000, { stopReason: "stop", content: [] }));
		expect((traceOf().root.children ?? []).map((span) => span.id)).toEqual(["a1", "after-steer"]);
	});
});

describe("worker tier info and approvals in the turn trace", () => {
	const TOKEN = "xoxb-TEST-0";
	const setTask = (id: string, tier: string | null, reason: string | null, conf: string | null): void =>
		withDb((db) =>
			db.run("UPDATE tasks SET tier = ?, tier_reason = ?, tier_confidence = ? WHERE task_id = ?", [
				tier,
				reason,
				conf,
				id,
			]),
		);
	const addApproval = (id: string, at: number, expires: number, status = "pending", origin = ORIGIN): void =>
		withDb((db) =>
			db.run(
				`INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_key)
				 VALUES (?, 'C1', ?, ?, ?, ?, ?, ?)`,
				[id, `1.${id}`, `승인 요청 ${TOKEN}\n두 번째 줄`, status, T0 + at, T0 + expires, origin],
			),
		);

	function fixture(): void {
		seed("answered", 20_000);
		addTask("T-CONF", 2000, { status: "working", model: "zai/glm-5.3" });
		addTask("T-NONE", 3000, { status: "working", model: "agy:gemini-3.8-flash" });
		addLane("lane-a", 4000, { parent: ORIGIN, status: "working" });
		setTask("T-CONF", "middle", "일반 구현", "0.88");
		withDb((db) => {
			const row = db.query<{ meta: string }, []>("SELECT meta FROM lanes WHERE name = 'lane-a'").get();
			const meta = { ...JSON.parse(row?.meta ?? "{}"), tier: "low", tierReason: "기계적", tierConfidence: 0.7 };
			db.run("UPDATE lanes SET meta = ? WHERE name = 'lane-a'", [JSON.stringify(meta)]);
		});
		addApproval("A-PEND", 5000, 600_000);
		addApproval("A-EXPIRED", 6000, 30_000);
		addApproval("A-OUTSIDE", 25_000, 600_000);
		addApproval("A-OTHER", 7000, 600_000, "pending", "discord/dm/200000000000000002");
	}

	test("workers carry tier, reason and confidence; approvals inside the window come masked, with a lapsed pending one expired", () => {
		fixture();
		const trace = traceOf();
		expect(byId(trace, "T-CONF")?.worker).toEqual({
			source: "task",
			tier: "middle",
			tierReason: "일반 구현",
			tierConfidence: 0.88,
		});
		expect(byId(trace, "T-NONE")?.worker).toEqual({
			source: "task",
			tier: null,
			tierReason: null,
			tierConfidence: null,
		});
		expect(byId(trace, "L-lane-a")?.worker).toEqual({
			source: "lane",
			tier: "low",
			tierReason: "기계적",
			tierConfidence: 0.7,
		});
		expect((trace.approvals ?? []).map((a) => [a.id, a.status])).toEqual([
			["A-PEND", "pending"],
			["A-EXPIRED", "expired"],
		]);
		expect(trace.approvals?.every((a) => !a.summary.includes(TOKEN) && !a.summary.includes("\n"))).toBe(true);
		expect(trace.root.children?.filter((span) => span.worker === undefined)).toEqual([]);
	});

	test("an unreadable stored confidence reads null", () => {
		fixture();
		for (const bad of ["", " ", "abc", "1.5", "-0.2", "Infinity"]) {
			setTask("T-CONF", "middle", "r", bad);
			expect(byId(traceOf(), "T-CONF")?.worker?.tierConfidence).toBeNull();
		}
	});

	test("a database without the tier_confidence column or the approvals table still reads ok", () => {
		fixture();
		withDb((db) => {
			db.run("ALTER TABLE tasks DROP COLUMN tier_confidence");
			db.run("DROP TABLE approvals");
		});
		const trace = traceOf();
		expect(trace.approvals).toEqual([]);
		expect(byId(trace, "T-CONF")?.worker).toEqual({
			source: "task",
			tier: "middle",
			tierReason: "일반 구현",
			tierConfidence: null,
		});
		withDb((db) => db.run("ALTER TABLE tasks DROP COLUMN tier_reason"));
		expect(byId(traceOf(), "T-CONF")?.worker).toMatchObject({ tier: "middle", tierReason: null });
	});
});

describe("api/turn/<id>/trace", () => {
	test("answers the reader under a prefix, 404 for a turn without a trace and trace_disabled without a reader", async () => {
		seed("dispatched");
		const snapshot = async (): Promise<DashboardSnapshot> => {
			throw new Error("not asked");
		};
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot,
			trace: (id) => readTurnTrace(home, id, NOW, where()),
		});
		const bare = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot });
		try {
			const ok = await fetch(`http://127.0.0.1:${server.port}/x/api/turn/1/trace`);
			expect(ok.status).toBe(200);
			expect(await ok.json()).toMatchObject({ ok: true, inboundId: 1, live: true });
			const pending = await fetch(`http://127.0.0.1:${server.port}/api/turn/2/trace`);
			expect([pending.status, await pending.json()]).toEqual([404, { ok: false, error: "not_dispatched" }]);
			const off = await fetch(`http://127.0.0.1:${bare.port}/api/turn/1/trace`);
			expect([off.status, await off.json()]).toEqual([404, { error: "trace_disabled" }]);
		} finally {
			server.stop(true);
			bare.stop(true);
		}
	});
});

describe("dashboard request log", () => {
	test("hears the page with its view and each detail read once; polls and streams are not heard", async () => {
		seed("dispatched");
		const heard: string[] = [];
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot: async () => {
				throw new Error("not built");
			},
			onError: () => {},
			onRequest: (kind, detail) => heard.push(detail === undefined ? kind : `${kind}:${detail}`),
			trace: (id) => readTurnTrace(home, id, NOW, where()),
			conversation: () => ({ ok: false, error: "unknown_origin" }),
			monitorDetail: () => ({ ok: false, error: "unknown_monitor" }),
			live: async () => null,
			board: { source: new BoardSource({ origin: "http://127.0.0.1:9" }), tasks: () => [] },
		});
		const base = `http://127.0.0.1:${server.port}`;
		try {
			for (const path of [
				"/?view=turns&origin=discord/dm/200000000000000003&card=c1",
				"/x/",
				"/api/turn/1/trace",
				"/api/thread/conversation?origin=discord/dm/200000000000000003",
				"/api/monitor/detail?id=m1",
				"/api/pane/plan?card=c1",
				"/healthz",
				"/api/snapshot",
				"/api/board",
				"/api/thread/live?origin=discord/dm/200000000000000003",
			]) {
				await (await fetch(`${base}${path}`)).arrayBuffer();
			}
			for (const path of ["/api/board/events", "/api/thread/live/events?origin=discord/dm/200000000000000003"]) {
				await fetch(`${base}${path}`, { method: "HEAD" });
			}
			expect(heard).toEqual(["page:turns", "page", "trace", "conversation", "monitor_detail", "board_pane"]);
		} finally {
			server.stop(true);
		}
	});

	test("a request log that throws leaves the answer as it was", async () => {
		seed("dispatched");
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot: async () => {
				throw new Error("not asked");
			},
			onRequest: () => {
				throw new Error("log unwritable");
			},
			trace: (id) => readTurnTrace(home, id, NOW, where()),
		});
		try {
			const ok = await fetch(`http://127.0.0.1:${server.port}/api/turn/1/trace`);
			expect(ok.status).toBe(200);
			expect(await ok.json()).toMatchObject({ ok: true, inboundId: 1 });
		} finally {
			server.stop(true);
		}
	});
});

describe("waterfall renderer", () => {
	const span = (
		id: string,
		kind: TraceSpan["kind"],
		start: number,
		end: number | undefined,
		extra: Partial<TraceSpan> = {},
	) =>
		({
			id,
			name: id,
			kind,
			status: end === undefined ? "running" : "done",
			start,
			...(end === undefined ? {} : { end }),
			...extra,
		}) satisfies TraceSpan;
	const answer = (children: TraceSpan[]): TurnTrace => ({
		ok: true,
		inboundId: 1,
		startedAt: T0,
		now: NOW,
		live: true,
		truncated: false,
		root: { id: "turn", name: "턴", kind: "agent", status: "running", start: 0, children },
	});
	const base = [
		span("m1", "llm", 0, 4000, { cost: 0.5 }),
		span("t1", "tool", 4000, 9000),
		span("agent:S", "subagent", 5000, 8000, { children: [span("agent:S/m1", "llm", 5000, 8000, { cost: 1.25 })] }),
	];
	const view = (state: Partial<TraceViewState> = {}): TraceViewState => ({
		now: NOW,
		fold: {},
		focus: null,
		open: null,
		title: "요청",
		...state,
	});
	const rows = (html: string): string[] => [...html.matchAll(/data-span="([^"]+)"/g)].map((match) => match[1] ?? "");
	const sig = (html: string): string | undefined => /data-sig="([^"]+)"/.exec(html)?.[1];

	test("a finished sub-agent starts folded with its cost rolled into the root, and the slowest finished call is tagged", () => {
		const html = renderTrace(answer(base), view());
		expect(rows(html)).toEqual(["turn", "m1", "t1", "agent:S"]);
		expect(html).toMatch(/data-span="turn"[^>]*aria-label="턴, 턴, 실행 중, 1분, \$1\.75"/);
		expect(html).toMatch(/data-span="t1"(?:(?!data-span=).)*class="tw-tag"/);
		expect(rows(renderTrace(answer(base), view({ fold: { "agent:S": false } })))).toContain("agent:S/m1");
	});

	test("data-sig holds while only the clock moves and changes when a span arrives or a fold opens", () => {
		const first = renderTrace(answer(base), view());
		const later = renderTrace(answer(base), view({ now: NOW + 3000 }));
		expect(later).not.toBe(first);
		expect(sig(later)).toBe(sig(first));
		expect(sig(renderTrace(answer([...base, span("t2", "tool", 9000, undefined)]), view()))).not.toBe(sig(first));
		expect(sig(renderTrace(answer(base), view({ fold: { "agent:S": false } })))).not.toBe(sig(first));
	});
});

const off = { ok: false as const, error: "not in this test" };
const SNAP = {
	generatedAt: "2026-11-12T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		ompVersion: "1",
		origins: 1,
		busy: 0,
		ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0, uncertain: 0 },
		monitors: { count: 0, next: null },
		openGates: [],
	},
	turns: off,
	tasks: { ok: true, items: [] },
	lanes: off,
	herdr: { ok: true, hosts: [] },
	approvals: off,
	monitors: off,
	alerts: off,
	gates: off,
	backup: off,
	jobs: off,
} as unknown as DashboardSnapshot;

describe("flow view", () => {
	const worker = (
		source: "task" | "lane",
		tier: string | null,
		tierReason: string | null,
		tierConfidence: number | null,
	) => ({ source, tier, tierReason, tierConfidence });
	const span = (
		id: string,
		kind: TraceSpan["kind"],
		start: number,
		status: TraceSpan["status"],
		extra: Partial<TraceSpan> = {},
	) =>
		({
			id,
			name: id,
			kind,
			status,
			start,
			...(status === "running" ? {} : { end: start + 1000 }),
			...extra,
		}) satisfies TraceSpan;
	const tool = (id: string, start: number, detail: string, status: TraceSpan["status"] = "done") =>
		span(id, "tool", start, status, { detail });

	describe("flowDoing", () => {
		test("no recorded steps wins over any status, and nothing is made up", () => {
			for (const status of ["running", "done", "failed"] as const) {
				expect(flowDoing(span("W", "subagent", 0, status, { detail: "agy:m · 단계 기록 없음", error: "x" }))).toBe(
					"단계 기록 없음",
				);
			}
			expect(flowDoing(span("W", "subagent", 0, "running", { detail: "agy:m · 단계 기록 없음", children: [] }))).toBe(
				"단계 기록 없음",
			);
		});

		test("running: newest tool's detail, else newest span, else waiting", () => {
			const llm = span("l", "llm", 9000, "done", { detail: "모델이 호출을 요청" });
			expect(
				flowDoing(
					span("W", "subagent", 0, "running", {
						children: [tool("a", 1000, "첫 도구"), tool("b", 5000, "나중 도구"), llm],
					}),
				),
			).toBe("나중 도구");
			expect(flowDoing(span("W", "subagent", 0, "running", { children: [llm, span("n", "llm", 2000, "done")] }))).toBe(
				"모델이 호출을 요청",
			);
			expect(flowDoing(span("W", "subagent", 0, "running", { children: [span("n", "llm", 2000, "done")] }))).toBe("n");
			expect(flowDoing(span("W", "subagent", 0, "running"))).toBe("기다리는 중");
			expect(flowDoing(span("W", "subagent", 0, "running", { children: [] }))).toBe("기다리는 중");
		});

		test("done and failed add the last step or the error; a long line is cut at 70", () => {
			expect(flowDoing(span("W", "subagent", 0, "done", { children: [tool("a", 1000, "마지막 도구")] }))).toBe(
				"끝남 · 마지막 도구",
			);
			expect(flowDoing(span("W", "subagent", 0, "done"))).toBe("끝남");
			expect(
				flowDoing(span("W", "subagent", 0, "failed", { error: "exit 1", children: [tool("a", 1000, "도구")] })),
			).toBe("실패 · exit 1");
			expect(flowDoing(span("W", "subagent", 0, "failed", { children: [tool("a", 1000, "도구")] }))).toBe(
				"실패 · 도구",
			);
			expect(flowDoing(span("W", "subagent", 0, "failed"))).toBe("실패");
			const long = flowDoing(span("W", "subagent", 0, "running", { children: [tool("a", 1000, "가".repeat(100))] }));
			expect(long).toHaveLength(70);
		});

		test("on the root, a delegated worker's tools and the worker itself are not picked", () => {
			const delegated = span("T-1", "subagent", 9000, "running", {
				worker: worker("task", "low", null, null),
				children: [tool("T-1/x", 9500, "워커 도구", "running")],
			});
			const root = span("turn", "agent", 0, "running", { children: [tool("t", 1000, "송박 도구"), delegated] });
			expect(flowDoing(root)).toBe("송박 도구");
			expect(flowDoing(span("turn", "agent", 0, "running", { children: [delegated] }))).toBe("기다리는 중");
		});
	});

	describe("renderFlow", () => {
		const approval = (
			id: string,
			status: "pending" | "approved" | "denied" | "expired" | "replied",
			at = 0,
			decided: number | null = null,
		) => ({
			id,
			summary: `요약 ${id}`,
			status,
			createdAt: T0 + at,
			decidedAt: decided === null ? null : T0 + decided,
		});
		const flowAnswer = (): TurnTrace => ({
			ok: true,
			inboundId: 1,
			startedAt: T0,
			now: NOW,
			live: true,
			truncated: false,
			root: {
				id: "turn",
				name: "턴",
				kind: "agent",
				status: "running",
				start: 0,
				model: "opus",
				children: [
					tool("t1", 500, "송박 도구"),
					span("scout", "subagent", 800, "done", { model: "scout-model" }),
					span("T-A", "subagent", 1000, "running", {
						model: "sonnet",
						cost: 0.5,
						worker: worker("task", "middle", "일반 구현 <b>", 0.88),
						children: [tool("T-A/x", 1500, "bun test", "running")],
					}),
					span("T-B", "subagent", 2000, "done", {
						detail: "agy:m · 단계 기록 없음",
						model: "agy:m",
						worker: worker("task", null, null, null),
					}),
					span("L-c", "subagent", 3000, "failed", { error: "boom", worker: worker("lane", "low", "기계적", 0.7) }),
				],
			},
			approvals: [approval("P", "pending", 0), approval("E", "expired", 100), approval("A", "approved", 200, 300)],
		});
		const view = (): TraceViewState => ({ now: NOW, fold: {}, focus: null, open: null, title: "<요청> 한 줄" });
		const cards = (html: string): string[] => [...html.matchAll(/data-flow-worker="([^"]+)"/g)].map((m) => m[1] ?? "");
		const cardOf = (html: string, id: string): string =>
			new RegExp(`<button[^>]*data-flow-worker="${id}"[\\s\\S]*?</button>`).exec(html)?.[0] ?? "";

		test("one card per worker span (in-turn sub-agents are not cards), none of the waterfall's selectors, escaped text", () => {
			const html = renderFlow(flowAnswer(), view());
			expect(cards(html)).toEqual(["T-A", "T-B", "L-c"]);
			expect(html).not.toContain("data-trace");
			expect(html).not.toContain("data-part");
			expect(html).toContain("&lt;요청&gt; 한 줄");
			expect(html).toContain("일반 구현 &lt;b&gt;");
			expect(html).not.toContain("<b>일반");
		});

		test("confidence 88% shows a bar and the percent; no judgement shows no bar; tier and doing lines", () => {
			const html = renderFlow(flowAnswer(), view());
			const a = cardOf(html, "T-A");
			expect(a).toContain("확신 88%");
			expect(a).toContain('class="fl-bar"');
			expect(a).toContain("bun test");
			expect(a).toContain("middle");
			const b = cardOf(html, "T-B");
			expect(b).toContain("판정 없음");
			expect(b).not.toContain("fl-bar");
			expect(b).toContain("등급 없음");
			expect(b).toContain("단계 기록 없음");
			expect(cardOf(html, "L-c")).toContain("실패 · boom");
		});

		test("approvals: pending is the warning branch with its wait, expired is faded, header chips match the fixture", () => {
			const html = renderFlow(flowAnswer(), view());
			expect(html).toMatch(/is-approvals is-pending/);
			expect(html).toMatch(/fl-appr is-pending[^>]*>요약 P · 대기 1분/);
			expect(html).toMatch(/fl-appr is-expired[^>]*>시간 초과/);
			expect(html).toMatch(/fl-appr is-approved[^>]*>승인됨 · \d\d:\d\d/);
			const chips = /data-flow-card="chips"[^>]*>(.*?)<\/div>/.exec(html)?.[1] ?? "";
			const numbers = [...chips.matchAll(/([가-힣 ]+) <b>(\d+)<\/b>/g)].map((m) => [m[1]?.trim(), m[2]]);
			expect(numbers).toEqual([
				["진행 중", "1"],
				["끝남", "1"],
				["실패", "1"],
				["승인 대기", "1"],
			]);
		});

		test("no workers and no approvals: the empty line, no branch, zero chips kept", () => {
			const empty = { ...flowAnswer(), approvals: undefined } as TurnTrace;
			if (empty.ok) empty.root = { ...empty.root, children: [tool("t1", 500, "송박 도구")] };
			const html = renderFlow(empty, view());
			expect(html).toContain("이 턴은 맡긴 워커가 없어요");
			expect(html).not.toContain("is-approvals");
			expect((html.match(/is-zero/g) ?? []).length).toBe(4);
		});

		test("a card's data-sig holds while the markup holds and changes with it", () => {
			const sigs = (html: string): string[] =>
				[...html.matchAll(/data-flow-card="[^"]+" data-sig="([^"]+)"/g)].map((m) => m[1] ?? "");
			const first = renderFlow(flowAnswer(), view());
			expect(sigs(renderFlow(flowAnswer(), view()))).toEqual(sigs(first));
			const later = sigs(renderFlow(flowAnswer(), { ...view(), now: NOW + 120_000 }));
			const before = sigs(first);
			expect(later.filter((sig, i) => sig !== before[i])).toHaveLength(1);
		});

		test("the page script carries renderFlow and flowDoing, and the mode toggle", () => {
			const page = renderDashboardPage(SNAP);
			expect(page).toContain(`const renderFlow = ${renderFlow.toString()}`);
			expect(page).toContain(`const flowDoing = ${flowDoing.toString()}`);
			expect(page).toContain('"trace-mode"');
		});
	});
});
