import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import {
	type OmpDialogAnswerer,
	type OmpDialogResponse,
	OmpDriverError,
	type OmpEntries,
	type OmpEvent,
	type OmpFinal,
} from "../src/omp/driver";
import { buildChildEnv } from "../src/omp/env";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { ExtensionUiTap, leafIdViaCursor, RpcOmpDriver } from "../src/omp/rpc-driver";
import { redact } from "../src/redact";
import { FakeOmpPeer, fakeOmpExecutable } from "./helpers/fake-omp-rpc";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function nextFinal(driver: FakeOmpDriver): Promise<OmpFinal> {
	const { promise, resolve } = Promise.withResolvers<OmpFinal>();
	const off = driver.onFinal((final) => {
		off();
		resolve(final);
	});
	return promise;
}

test("buildChildEnv strips SLACK_/OMPBOT_ and adds extras", () => {
	const env = buildChildEnv(
		{ OMP_WIKI_NOTE_DISABLE: "1" },
		{ PATH: "/bin", SLACK_BOT_TOKEN: "x", OMPBOT_HOME: "y", OMPBOT: "keep-not-prefixed", HOME: "/h", GONE: undefined },
	);
	expect(env).toEqual({ PATH: "/bin", OMPBOT: "keep-not-prefixed", HOME: "/h", OMP_WIKI_NOTE_DISABLE: "1" });
	expect(() => buildChildEnv({ SLACK_X: "1" }, {})).toThrow(OmpDriverError);
});

test("RpcOmpDriver fails fast with omp_executable_missing (no spawn, no retry)", async () => {
	const dir = tempDir("ompbot-missing-");
	const driver = new RpcOmpDriver({ ompExecutable: join(dir, "no-such-omp"), cwd: dir, sessionDir: join(dir, "s") });
	const started = performance.now();
	const error = await driver.start().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "omp_executable_missing" });
	expect(performance.now() - started).toBeLessThan(1000);
	expect(driver.pid).toBeUndefined();
});

test("RpcOmpDriver refuses an executable whose --version is not omp/<x.y.z>, before any spawn", async () => {
	const dir = tempDir("ompbot-notomp-");
	const peer = new FakeOmpPeer();
	const driver = new RpcOmpDriver({
		ompExecutable: fakeOmpExecutable(dir, "1.4.4"),
		cwd: dir,
		sessionDir: join(dir, "s"),
		spawn: peer.spawn,
	});
	const error = await driver.start().catch((e: unknown) => e);
	expect(error).toMatchObject({ code: "omp_executable_missing" });
	expect(String(error)).toContain("did not print omp/<version>");
	expect(peer.spawned).toEqual([]);
});

test("RpcOmpDriver starts the executable itself (no bun in front) with the RPC argv and the child env", async () => {
	const dir = tempDir("ompbot-argv-");
	const peer = new FakeOmpPeer();
	const ompExecutable = fakeOmpExecutable(dir);
	const driver = new RpcOmpDriver({
		ompExecutable,
		cwd: join(dir, "ws"),
		sessionDir: join(dir, "s"),
		provider: "p",
		model: "m",
		thinking: "low",
		overlayConfig: "/o.yml",
		extraArgs: ["--append-system-prompt", "S"],
		env: { OMP_WIKI_NOTE_DISABLE: "1" },
		baseEnv: { PATH: process.env.PATH, SLACK_BOT_TOKEN: "xoxb-TEST-0" },
		spawn: peer.spawn,
	});
	await driver.start();
	try {
		expect(peer.spawned[0]?.argv).toEqual([
			ompExecutable,
			"--mode",
			"rpc",
			"--no-title",
			"--provider",
			"p",
			"--model",
			"m",
			"--session-dir",
			join(dir, "s"),
			"--config",
			"/o.yml",
			"--thinking",
			"low",
			"--append-system-prompt",
			"S",
		]);
		expect(peer.spawned[0]?.options).toEqual({
			cwd: join(dir, "ws"),
			env: { PATH: process.env.PATH ?? "", OMP_WIKI_NOTE_DISABLE: "1" },
		});
	} finally {
		await driver.stop();
	}
});

test("FakeOmpDriver: entriesSince is strict and returns leafId", async () => {
	const driver = new FakeOmpDriver();
	await driver.start();
	const seeded = await driver.entriesSince();
	expect(seeded.entries.length).toBeGreaterThan(0); // like real omp, a fresh session already has entries
	expect(seeded.leafId).toBe(seeded.entries.at(-1)?.id ?? null);

	const before = await driver.leafId();
	const done = nextFinal(driver);
	await driver.prompt("hello");
	const final = await done;
	expect(final.status).toBe("completed");

	const since = await driver.entriesSince(before ?? undefined);
	expect(since.entries.map((e) => e.message?.role)).toEqual(["user", "assistant"]);
	expect(since.leafId).toBe(since.entries.at(-1)?.id ?? null);

	const leaf = await driver.leafId();
	expect((await driver.entriesSince(leaf ?? undefined)).entries).toEqual([]);
	const rejection = await driver.entriesSince("nope").catch((e: unknown) => e);
	expect(rejection).toBeInstanceOf(OmpDriverError);
	expect(rejection).toMatchObject({ code: "unknown_since" });
});

test("FakeOmpDriver: onFinal never precedes prompt resolution; prompt while busy rejects", async () => {
	const driver = new FakeOmpDriver({ holdTurns: true });
	await driver.start();
	const order: string[] = [];
	driver.onFinal(() => order.push("final"));
	const opRef = await driver.prompt("a");
	order.push(`prompt:${opRef}`);
	await driver.steer("b");
	await expect(driver.prompt("overlap")).rejects.toMatchObject({ code: "rpc_error" });
	const done = nextFinal(driver);
	driver.release();
	const final = await done;
	expect(order).toEqual([`prompt:${opRef}`, "final"]);
	expect(final.text).toContain("b");
});

test("FakeOmpDriver: sessions persist across stop/start through a shared store", async () => {
	const store = new FakeSessionStore();
	const first = new FakeOmpDriver({ store, sessionDir: "d" });
	await first.start();
	const done = nextFinal(first);
	await first.prompt("one");
	await done;
	const leaf = await first.leafId();
	await first.stop();

	const second = new FakeOmpDriver({ store, sessionDir: "d" });
	await second.start();
	expect((await second.openSession()).resumed).toBe(true);
	expect(await second.leafId()).toBe(leaf);
});

/** In-memory get_entries mirroring omp's selectRpcEntries: delta after `since`, unknown cursor rejects. */
function fakeGetEntries(session: OmpEntries["entries"], calls: Array<string | undefined>) {
	return async (since?: string): Promise<OmpEntries> => {
		calls.push(since);
		const index = since === undefined ? -1 : session.findIndex((entry) => entry.id === since);
		if (since !== undefined && index === -1) {
			throw new OmpDriverError("unknown_since", `Unknown entries cursor: ${since}`);
		}
		return { entries: session.slice(index + 1), leafId: session.at(-1)?.id ?? null };
	};
}

test("leafIdViaCursor reads get_entries(since=cursor) and re-seeds the cache on unknown_since", async () => {
	const calls: Array<string | undefined> = [];
	const session: OmpEntries["entries"] = [{ id: "e1", type: "message" }];
	const getEntries = fakeGetEntries(session, calls);
	const cache: { since?: string } = {};

	// First read has no cursor yet: one full read, leafId cached.
	expect(await leafIdViaCursor(getEntries, cache)).toBe("e1");
	expect(calls).toEqual([undefined]);
	expect(cache.since).toBe("e1");

	// Growth between reads: only the delta moves through the pipe.
	session.push({ id: "e2", type: "message" }, { id: "e3", type: "message" });
	expect(await leafIdViaCursor(getEntries, cache)).toBe("e3");
	expect(calls).toEqual([undefined, "e1"]);

	// Cursor gone (session switch / compaction): one full read, cache re-seeded from it.
	session.length = 0;
	session.push({ id: "x1", type: "message" });
	expect(await leafIdViaCursor(getEntries, cache)).toBe("x1");
	expect(calls).toEqual([undefined, "e1", "e3", undefined]);

	// Empty session: leafId null is never fed back as a cursor (omp treats only an absent since as "everything").
	session.length = 0;
	expect(await leafIdViaCursor(getEntries, cache)).toBeNull();
	expect(calls).toEqual([undefined, "e1", "e3", undefined, "x1", undefined]);
	expect(cache.since).toBeUndefined();
});

test("leafIdViaCursor propagates other errors and leaves the cache untouched", async () => {
	const calls: Array<string | undefined> = [];
	const cache: { since?: string } = { since: "e1" };
	const getEntries = async (since?: string): Promise<OmpEntries> => {
		calls.push(since);
		throw new OmpDriverError("rpc_error", "child died");
	};
	const error = await leafIdViaCursor(getEntries, cache).catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "rpc_error" });
	expect(calls).toEqual(["e1"]);
	expect(cache.since).toBe("e1");
});

/** An `ExtensionUiTap` with its events and replies collected; `untilReplies` resolves once `count` were written. */
function uiTap(answer?: OmpDialogAnswerer) {
	const events: OmpEvent[] = [];
	const replies: Array<Record<string, unknown>> = [];
	let wanted: { count: number; resolve: () => void } | undefined;
	const tap = new ExtensionUiTap(
		(event) => events.push(event),
		(frame) => {
			replies.push(frame);
			if (wanted !== undefined && replies.length >= wanted.count) wanted.resolve();
		},
		answer,
	);
	const send = (frame: Record<string, unknown>) => tap.frame({ type: "extension_ui_request", ...frame });
	const untilReplies = (count: number): Promise<void> => {
		if (replies.length >= count) return Promise.resolve();
		const reached = Promise.withResolvers<void>();
		wanted = { count, resolve: reached.resolve };
		return reached.promise;
	};
	return { tap, events, replies, send, untilReplies };
}

test("ExtensionUiTap without an answerer emits every request and instantly cancels every dialog", () => {
	const { tap, events, replies, send } = uiTap();
	const dialogs = ["select", "confirm", "input", "editor", "ask"];
	dialogs.forEach((method, index) => {
		send({ method, id: `u${index + 1}` });
	});
	send({ method: "status_widget", id: "u9" }); // answerable: no cancel
	tap.frame({ type: "message.update", seq: 3 }); // not a UI request: no event
	send({}); // no method/id: emitted once, never answered
	expect(events).toEqual([
		...dialogs.map((method, index) => ({ type: "extension_ui_request", method, id: `u${index + 1}` })),
		{ type: "extension_ui_request", method: "status_widget", id: "u9" },
		{ type: "extension_ui_request", method: undefined, id: undefined },
	]);
	expect(replies).toEqual(
		dialogs.map((_method, index) => ({ type: "extension_ui_response", id: `u${index + 1}`, cancelled: true })),
	);
});

test("ExtensionUiTap hands dialogs to the answerer and writes its response; undefined, a throw or a bad frame is cancelled", async () => {
	const seen: string[] = [];
	const live = uiTap(async (request) => {
		seen.push(request.method);
		if (request.method === "select") return { value: request.options[1] ?? "" };
		if (request.method === "confirm") return undefined;
		throw new Error("boom");
	});
	live.send({ method: "select", id: "u1", title: "t", options: ["a", "b"] });
	live.send({ method: "confirm", id: "u2", title: "t", message: "m" });
	live.send({ method: "input", id: "u3", title: "t" });
	live.send({ method: "select", id: "u4", title: "t" }); // no options: never reaches the answerer
	live.send({ method: "notify", id: "u5", message: "hi" }); // not a dialog: no response
	await live.untilReplies(4);
	live.tap.close();
	expect(seen).toEqual(["select", "confirm", "input"]);
	expect(new Set(live.replies.map((frame) => JSON.stringify(frame)))).toEqual(
		new Set(
			[
				{ type: "extension_ui_response", id: "u4", cancelled: true },
				{ type: "extension_ui_response", id: "u1", value: "b" },
				{ type: "extension_ui_response", id: "u2", cancelled: true },
				{ type: "extension_ui_response", id: "u3", cancelled: true },
			].map((frame) => JSON.stringify(frame)),
		),
	);
});

test("ExtensionUiTap: a select frame carries omp's selectionMarker to the answerer, and none when omp sends none", async () => {
	const seen: unknown[] = [];
	const live = uiTap(async (request) => {
		seen.push(request.method === "select" ? request.selectionMarker : "n/a");
		return { cancelled: true };
	});
	live.send({ method: "select", id: "u1", title: "t", options: ["a"], selectionMarker: "checkbox" });
	live.send({ method: "select", id: "u2", title: "t", options: ["a"] });
	await live.untilReplies(2);
	expect(new Set(seen)).toEqual(new Set(["checkbox", undefined]));
});

test("ExtensionUiTap: omp's cancel aborts the waiting answer and its late response is never written", async () => {
	const late = Promise.withResolvers<OmpDialogResponse>();
	const aborted = Promise.withResolvers<void>();
	const live = uiTap(async (_request, signal) => {
		signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		return late.promise;
	});
	live.send({ method: "select", id: "u1", title: "t", options: ["a"] });
	live.send({ method: "cancel", id: "c1", targetId: "u1" });
	await aborted.promise;
	late.resolve({ value: "a" });
	await late.promise;
	expect(live.replies).toEqual([]);
});

test("ExtensionUiTap: close() aborts every waiting answer (the child is gone)", async () => {
	const aborted = Promise.withResolvers<void>();
	const live = uiTap(async (_request, signal) => {
		signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		return Promise.withResolvers<OmpDialogResponse>().promise;
	});
	live.send({ method: "confirm", id: "u1", title: "t", message: "m" });
	live.tap.close();
	await aborted.promise;
	expect(live.replies).toEqual([]);
});

/** A driver over a fake peer, with its finals, warn log lines and a barrier that proves earlier stdout was read. */
async function startPeerDriver(peer = new FakeOmpPeer()) {
	const dir = tempDir("ompbot-peer-");
	const warns: string[] = [];
	const driver = new RpcOmpDriver({
		ompExecutable: fakeOmpExecutable(dir),
		cwd: join(dir, "ws"),
		sessionDir: join(dir, "s"),
		spawn: peer.spawn,
		log: createLogger({ sink: (line) => warns.push(line), clock: { now: () => 0 }, redact }),
	});
	await driver.start();
	const finals: OmpFinal[] = [];
	const finalWaiters: Array<{ count: number; resolve: () => void }> = [];
	driver.onFinal((final) => {
		finals.push(final);
		for (const waiter of finalWaiters.filter((w) => finals.length >= w.count)) waiter.resolve();
	});
	/** Resolves once `count` finals arrived. */
	const untilFinals = (count: number): Promise<void> => {
		if (finals.length >= count) return Promise.resolve();
		const reached = Promise.withResolvers<void>();
		finalWaiters.push({ count, resolve: reached.resolve });
		return reached.promise;
	};
	let barrier = 0;
	/** Resolves once every line written so far was read: a notify frame pushed last comes back as an event. */
	const readAll = (): Promise<void> => {
		const id = `barrier-${++barrier}`;
		const seen = Promise.withResolvers<void>();
		const off = driver.onEvent((event) => {
			if (event.type === "extension_ui_request" && event.id === id) {
				off();
				seen.resolve();
			}
		});
		peer.push({ type: "extension_ui_request", method: "notify", id });
		return seen.promise;
	};
	return { driver, peer, finals, untilFinals, warns, readAll };
}

const promptResult = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
	type: "prompt_result",
	id,
	agentInvoked: true,
	status,
	sessionSettled: true,
	...extra,
});

test("RpcOmpDriver buffers a final that arrives before prompt() resolves, then delivers it on admission", async () => {
	const peer = new FakeOmpPeer();
	peer.replies.set("prompt", () => "hold");
	const { driver, finals, untilFinals, readAll } = await startPeerDriver(peer);
	try {
		let promptSettled = false;
		const promptPromise = driver.prompt("hello");
		void promptPromise.then(
			() => (promptSettled = true),
			() => (promptSettled = true),
		);
		const command = await peer.command((c) => c.type === "prompt");
		const opRef = command.id ?? "";

		// The wire result lands before the prompt response: it must be buffered, not delivered.
		peer.push(promptResult(opRef, "completed"));
		await readAll();
		expect(promptSettled).toBe(false);
		expect(finals).toEqual([]);

		peer.respond(command, { data: { agentInvoked: true } });
		expect(await promptPromise).toBe(opRef);
		await untilFinals(1);
		expect(finals[0]).toEqual({ opRef, status: "completed", text: "fake assistant text" });

		// Same race with an error result: buffered, then delivered with the mapped error message.
		const second = driver.prompt("second");
		const command2 = await peer.command((c) => c.type === "prompt" && c.id !== opRef);
		peer.push(promptResult(command2.id ?? "", "error", { error: { message: "boom" } }));
		peer.respond(command2, { data: {} });
		expect(await second).toBe(command2.id ?? "");
		await untilFinals(2);
		expect(finals[1]).toEqual({ opRef: command2.id ?? "", status: "error", text: "", error: "boom" });
	} finally {
		await driver.stop();
	}
});

test("RpcOmpDriver forwards retry/fallback session events once and agent events through the agent listener", async () => {
	const { driver, peer, readAll } = await startPeerDriver();
	const received: OmpEvent[] = [];
	driver.onEvent((event) => {
		if (event.type !== "extension_ui_request") received.push(event);
	});
	try {
		const retry = {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 10,
			delayMs: 500,
			errorMessage: "429 rate_limit_error",
		};
		const tool = { type: "tool_execution_start", toolName: "bash" };
		const end = { type: "auto_retry_end", success: false, attempt: 3 }; // malformed on purpose: no finalError
		const fallback = { type: "retry_fallback_applied", from: "zai/a", to: "zai/b", role: "default", reason: "429" };
		for (const frame of [retry, tool, { type: "notice", text: "n" }, end, fallback]) peer.push(frame);
		await readAll();
		// tool_execution_start once (agent listener only), notice not forwarded at all.
		expect(received).toEqual([retry, tool, end, fallback]);
	} finally {
		await driver.stop();
	}
});

test("RpcOmpDriver opts in to the ask dialog only when an answerer is injected", async () => {
	const optIns: unknown[] = [];
	for (const answerDialog of [undefined, async () => ({ value: "x" })] as const) {
		const dir = tempDir("ompbot-ask-");
		const peer = new FakeOmpPeer();
		const driver = new RpcOmpDriver({
			ompExecutable: fakeOmpExecutable(dir),
			cwd: dir,
			sessionDir: join(dir, "s"),
			spawn: peer.spawn,
			...(answerDialog === undefined ? {} : { answerDialog }),
		});
		await driver.start();
		try {
			optIns.push((await peer.command((c) => c.type === "set_ask_dialog")).enabled);
		} finally {
			await driver.stop();
		}
	}
	expect(optIns).toEqual([false, true]);
});

test("RpcOmpDriver.abortAndClearQueue sends abort_and_restore_queue (not a plain abort) and drops the returned queue", async () => {
	const { driver, peer } = await startPeerDriver();
	try {
		expect(await driver.abortAndClearQueue()).toBeUndefined();
		const types = peer.commands.map((c) => c.type);
		expect(types).toContain("abort_and_restore_queue");
		expect(types).not.toContain("abort");
	} finally {
		await driver.stop();
	}
});

test("RpcOmpDriver.state() moves contextUsage into context and never makes up a 0", async () => {
	const peer = new FakeOmpPeer();
	let extra: Record<string, unknown> = {};
	peer.replies.set("get_state", () => ({
		data: {
			sessionId: "fake-session",
			isStreaming: false,
			isCompacting: false,
			isSettled: true,
			queuedMessageCount: 0,
			messageCount: 0,
			...extra,
		},
	}));
	const { driver } = await startPeerDriver(peer);
	try {
		extra = { contextUsage: { tokens: 123000, contextWindow: 1000000, percent: 12.3 } };
		expect((await driver.state()).context).toEqual({ tokens: 123000, window: 1000000, percent: 12.3 });

		extra = {};
		expect("context" in (await driver.state())).toBe(false);

		extra = { contextUsage: { tokens: null, contextWindow: 1000000, percent: null } };
		expect((await driver.state()).context).toEqual({ tokens: null, window: 1000000, percent: null });

		extra = { contextUsage: { tokens: "123000", contextWindow: 1000000, percent: 12.3 } };
		expect((await driver.state()).context).toEqual({ tokens: null, window: 1000000, percent: null });

		extra = { contextUsage: { tokens: 0, contextWindow: 0, percent: 0 } };
		expect("context" in (await driver.state())).toBe(false);
	} finally {
		await driver.stop();
	}
});

test("an unreadable stdout line during a prompt is logged and skipped; the turn still ends with its own result (#88)", async () => {
	for (const broken of ["{ this is not json", "null", "[1,2,3]"]) {
		const { driver, peer, finals, untilFinals, warns, readAll } = await startPeerDriver();
		try {
			const opRef = await driver.prompt("hi");
			peer.push(`${broken}\n`);
			await readAll();
			expect(finals, broken).toEqual([]);
			expect(
				warns.filter((line) => line.includes("omp_stream_unreadable")),
				broken,
			).toHaveLength(1);
			peer.push(promptResult(opRef, "completed"));
			await untilFinals(1);
			expect(finals, broken).toEqual([{ opRef, status: "completed", text: "fake assistant text" }]);
			expect(peer.signals, broken).toEqual([]);
		} finally {
			await driver.stop();
		}
	}
});

test("blank lines and unknown event types are neither logged nor routed (#88)", async () => {
	const { driver, peer, finals, untilFinals, warns, readAll } = await startPeerDriver();
	try {
		const opRef = await driver.prompt("hi");
		peer.push(
			`\n   \n${JSON.stringify({ type: "totally_unknown_event_type", payload: 1 })}\n${JSON.stringify({ type: 12345 })}\n`,
		);
		await readAll();
		expect(finals).toEqual([]);
		expect(warns.filter((line) => line.includes("omp_stream_unreadable"))).toEqual([]);
		peer.push(promptResult(opRef, "completed"));
		await untilFinals(1);
		expect(finals).toEqual([{ opRef, status: "completed", text: "fake assistant text" }]);
	} finally {
		await driver.stop();
	}
});

test("qa-h n79: a local slash command (agentInvoked:false) ends with its command_output, not the last assistant text", async () => {
	const peer = new FakeOmpPeer();
	let local = true;
	peer.replies.set("prompt", () => (local ? { data: { agentInvoked: false } } : "hold"));
	const { driver, finals, untilFinals } = await startPeerDriver(peer);
	try {
		// omp writes the output, then answers the prompt; no prompt_result follows.
		const pending = driver.prompt("/usage");
		peer.push({ type: "command_output", text: "Usage: 12 requests" });
		peer.push({ type: "command_output", text: "Cost: $0.10" });
		const opRef = await pending;
		await untilFinals(1);
		expect(finals).toEqual([{ opRef, status: "completed", text: "Usage: 12 requests\nCost: $0.10" }]);

		// No output → "".
		local = false;
		const second = driver.prompt("/clear-todos");
		const command = await peer.command((c) => c.type === "prompt" && c.id !== opRef);
		peer.respond(command, { data: { agentInvoked: false } });
		expect(await second).toBe(command.id ?? "");
		await untilFinals(2);
		expect(finals[1]).toEqual({ opRef: command.id ?? "", status: "completed", text: "" });
	} finally {
		await driver.stop();
	}
});

test("qa-h n79: an ordinary prompt response (no agentInvoked:false) still waits for its prompt_result", async () => {
	const { driver, peer, finals, untilFinals, readAll } = await startPeerDriver();
	try {
		const opRef = await driver.prompt("hi");
		peer.push({ id: opRef, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
		await readAll();
		expect(finals).toEqual([]);
		peer.push(promptResult(opRef, "completed"));
		await untilFinals(1);
		expect(finals).toEqual([{ opRef, status: "completed", text: "fake assistant text" }]);
	} finally {
		await driver.stop();
	}
});

test("RpcOmpDriver reports the child's own exit as unexpected and stop()'s exit as expected", async () => {
	for (const how of ["crash", "stop"] as const) {
		const { driver, peer } = await startPeerDriver();
		const exits: Array<{ code: number | null; expected: boolean }> = [];
		const exited = Promise.withResolvers<void>();
		driver.onExit((info) => {
			exits.push({ code: info.code, expected: info.expected });
			exited.resolve();
		});
		if (how === "crash") peer.exit(7);
		else await driver.stop();
		await exited.promise;
		expect(exits, how).toEqual([how === "crash" ? { code: 7, expected: false } : { code: 143, expected: true }]);
		await driver.stop();
	}
});
