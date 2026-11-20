import { afterAll, describe, expect, test } from "bun:test";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { type OmpDialogRequest, OmpDriverError, type OmpExitInfo, type OmpFinal } from "../src/omp/driver";
import {
	OmpRpcClient,
	RPC_CHUNK_PAYLOAD_BYTES,
	RpcChunkAssembler,
	RpcCommandError,
	type RpcHostTool,
	RpcProtocolError,
	readLines,
} from "../src/omp/rpc-client";
import { RpcOmpDriver } from "../src/omp/rpc-driver";
import { redact } from "../src/redact";
import { FakeOmpPeer, fakeOmpExecutable } from "./helpers/fake-omp-rpc";

const root = mkdtempSync(join(tmpdir(), "ompbot-rpc-client-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirCounter = 0;

/** Rejects when `promise` has not settled within `ms` (a failure deadline, never a wait for time to pass). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
	return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer));
}

async function startedClient(
	peer: FakeOmpPeer,
	extra: { hostTools?: RpcHostTool[]; onUnreadable?: (line: string) => void } = {},
) {
	const client = new OmpRpcClient({
		executable: "omp",
		args: ["--mode", "rpc"],
		cwd: root,
		env: {},
		spawn: peer.spawn,
		...extra,
	});
	await client.start();
	return client;
}

async function startedDriver(peer: FakeOmpPeer, extra: Partial<ConstructorParameters<typeof RpcOmpDriver>[0]> = {}) {
	const dir = join(root, `d${++dirCounter}`);
	mkdirSync(dir, { recursive: true });
	const driver = new RpcOmpDriver({
		ompExecutable: fakeOmpExecutable(dir),
		cwd: join(dir, "ws"),
		sessionDir: join(dir, "s"),
		spawn: peer.spawn,
		...extra,
	});
	await driver.start();
	return driver;
}

/** omp's protocol-2 encoding of one logical frame: base64 slices of its UTF-8 JSON, one `rpc_chunk` line each. */
function chunkLines(frame: Record<string, unknown>, chunkId = "rpc-1"): string {
	const bytes = Buffer.from(JSON.stringify(frame), "utf8");
	const count = Math.ceil(bytes.byteLength / RPC_CHUNK_PAYLOAD_BYTES);
	let text = "";
	for (let index = 0; index < count; index++) {
		const data = bytes
			.subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES)
			.toString("base64");
		text += `${JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.byteLength, data })}\n`;
	}
	return text;
}

describe("handshake", () => {
	test("ready → negotiate_protocol v2 → set_host_tools, before start() resolves", async () => {
		const peer = new FakeOmpPeer();
		const tool: RpcHostTool = { name: "t", label: "T", description: "d", parameters: {}, execute: () => "x" };
		const client = await startedClient(peer, { hostTools: [tool] });
		expect(peer.commands.map((command) => command.type)).toEqual(["negotiate_protocol", "set_host_tools"]);
		expect(peer.commands[0]).toMatchObject({ protocolVersion: 2 });
		expect(peer.commands[1]?.tools).toEqual([{ name: "t", label: "T", description: "d", parameters: {} }]);
		expect(peer.spawned[0]?.argv).toEqual(["omp", "--mode", "rpc"]);
		await client.stop();
	});

	test("a ready without protocol 2 is refused as omp_rpc_unsupported and the child is ended", async () => {
		const peer = new FakeOmpPeer();
		peer.ready = { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] };
		const client = new OmpRpcClient({ executable: "omp", args: [], cwd: root, env: {}, spawn: peer.spawn });
		const error = await client.start().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OmpDriverError);
		expect(error).toMatchObject({ code: "omp_rpc_unsupported" });
		expect(peer.signals[0]).toBe("SIGTERM");
		expect(peer.commands).toEqual([]);
	});

	test("a child that exits before ready rejects start with its stderr", async () => {
		const peer = new FakeOmpPeer();
		peer.ready = undefined;
		peer.stderrText = "boom: config broken";
		const client = new OmpRpcClient({ executable: "omp", args: [], cwd: root, env: {}, spawn: peer.spawn });
		const started = client.start();
		peer.exit(1);
		await expect(started).rejects.toThrow("boom: config broken");
	});
});

describe("ask dialog over rpc-ui", () => {
	test("the driver spawns rpc-ui, opts in to ask, and writes the owner's answer to the ask request", async () => {
		const peer = new FakeOmpPeer();
		const asked: OmpDialogRequest[] = [];
		const driver = await startedDriver(peer, {
			answerDialog: async (request) => {
				asked.push(request);
				return { value: "B" };
			},
		});
		try {
			expect(peer.spawned[0]?.argv.slice(1, 4)).toEqual(["--mode", "rpc-ui", "--no-title"]);
			expect(await peer.command((c) => c.type === "set_ask_dialog")).toMatchObject({ enabled: true });
			const answered = peer.command((c) => c.type === "extension_ui_response");
			peer.push({
				type: "extension_ui_request",
				id: "ui-1",
				method: "ask",
				questions: [{ id: "q1", question: "어느 쪽?", options: [{ label: "A" }, { label: "B" }] }],
			});
			expect(await within(answered, 2000, "ask answer")).toEqual({
				type: "extension_ui_response",
				id: "ui-1",
				value: "B",
			});
			expect(asked[0]).toMatchObject({ method: "ask", id: "ui-1", questions: [{ id: "q1", question: "어느 쪽?" }] });
		} finally {
			await driver.stop();
		}
	});

	test("without an answerer the child is headless rpc, ask is off and a dialog is cancelled at once", async () => {
		const peer = new FakeOmpPeer();
		const driver = await startedDriver(peer);
		try {
			expect(peer.spawned[0]?.argv.slice(1, 3)).toEqual(["--mode", "rpc"]);
			expect(await peer.command((c) => c.type === "set_ask_dialog")).toMatchObject({ enabled: false });
			const answered = peer.command((c) => c.type === "extension_ui_response");
			peer.push({ type: "extension_ui_request", id: "ui-2", method: "confirm", title: "t", message: "m" });
			expect(await within(answered, 2000, "cancel")).toEqual({
				type: "extension_ui_response",
				id: "ui-2",
				cancelled: true,
			});
		} finally {
			await driver.stop();
		}
	});
});

describe("host tools", () => {
	test("a string result is sent as AgentToolResult text; sendUpdate streams host_tool_update first", async () => {
		const peer = new FakeOmpPeer();
		const seen: unknown[] = [];
		const tool: RpcHostTool = {
			name: "echo",
			description: "echo",
			parameters: {},
			execute: (params, context) => {
				seen.push(params, context.toolCallId);
				context.sendUpdate("half");
				return `done ${String(params.x)}`;
			},
		};
		const client = await startedClient(peer, { hostTools: [tool] });
		try {
			const result = peer.command((c) => c.type === "host_tool_result");
			peer.push({ type: "host_tool_call", id: "call-1", toolCallId: "tc-1", toolName: "echo", arguments: { x: 7 } });
			expect(await within(result, 2000, "tool result")).toEqual({
				type: "host_tool_result",
				id: "call-1",
				result: { content: [{ type: "text", text: "done 7" }] },
			});
			expect(peer.commands.filter((c) => c.type === "host_tool_update")).toEqual([
				{ type: "host_tool_update", id: "call-1", partialResult: { content: [{ type: "text", text: "half" }] } },
			]);
			expect(seen).toEqual([{ x: 7 }, "tc-1"]);
		} finally {
			await client.stop();
		}
	});

	test("host_tool_cancel aborts the running call and nothing is written for it afterwards", async () => {
		const peer = new FakeOmpPeer();
		const aborted = Promise.withResolvers<void>();
		const late = Promise.withResolvers<string>();
		const tool: RpcHostTool = {
			name: "slow",
			description: "slow",
			parameters: {},
			execute: (_params, context) => {
				context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				return late.promise;
			},
		};
		const client = await startedClient(peer, { hostTools: [tool] });
		try {
			peer.push({ type: "host_tool_call", id: "call-2", toolCallId: "tc-2", toolName: "slow", arguments: {} });
			peer.push({ type: "host_tool_cancel", id: "cancel-1", targetId: "call-2" });
			await within(aborted.promise, 2000, "abort");
			late.resolve("too late");
			await late.promise;
			// A later answered call proves the client has written everything for the cancelled one by now.
			const marker = peer.command((c) => c.type === "host_tool_result" && c.id === "call-3");
			peer.push({ type: "host_tool_call", id: "call-3", toolCallId: "tc-3", toolName: "nope", arguments: {} });
			expect(await within(marker, 2000, "unregistered tool result")).toMatchObject({
				isError: true,
				result: { content: [{ type: "text", text: 'Host tool "nope" is not registered' }] },
			});
			expect(peer.commands.filter((c) => c.id === "call-2")).toEqual([]);
		} finally {
			await client.stop();
		}
	});

	test("a throwing tool answers isError with its message", async () => {
		const peer = new FakeOmpPeer();
		const tool: RpcHostTool = {
			name: "bad",
			description: "bad",
			parameters: {},
			execute: () => {
				throw new Error("refused");
			},
		};
		const client = await startedClient(peer, { hostTools: [tool] });
		try {
			const result = peer.command((c) => c.type === "host_tool_result");
			peer.push({ type: "host_tool_call", id: "call-4", toolCallId: "tc-4", toolName: "bad", arguments: {} });
			expect(await within(result, 2000, "error result")).toEqual({
				type: "host_tool_result",
				id: "call-4",
				result: { content: [{ type: "text", text: "refused" }], details: {} },
				isError: true,
			});
		} finally {
			await client.stop();
		}
	});
});

describe("session commands", () => {
	test("/compact sends compact with the instructions and returns omp's summary", async () => {
		const peer = new FakeOmpPeer();
		peer.replies.set("compact", () => ({ data: { summary: "요약", tokensBefore: 1234 } }));
		const driver = await startedDriver(peer);
		try {
			expect(await driver.compact("짧게")).toEqual({ summary: "요약", tokensBefore: 1234 });
			expect(peer.commands.find((c) => c.type === "compact")).toMatchObject({ customInstructions: "짧게" });
		} finally {
			await driver.stop();
		}
	});

	test("/new sends new_session; /resume opens the session dir and switches to an absolute session file", async () => {
		const peer = new FakeOmpPeer();
		peer.replies.set("open_session", () => ({ data: { cancelled: false, resumed: true, sessionId: "s-9" } }));
		const driver = await startedDriver(peer);
		try {
			expect(await driver.newSession()).toEqual({ cancelled: false });
			expect(await driver.openSession()).toEqual({ resumed: true, sessionId: "s-9" });
			expect(await driver.switchSession("rel/session.jsonl")).toEqual({ cancelled: false });
			const types = peer.commands.map((c) => c.type);
			expect(types).toContain("new_session");
			const open = peer.commands.find((c) => c.type === "open_session");
			expect(String(open?.sessionDir)).toStartWith("/");
			expect(peer.commands.find((c) => c.type === "switch_session")?.sessionPath).toBe(
				join(process.cwd(), "rel/session.jsonl"),
			);
		} finally {
			await driver.stop();
		}
	});

	test("an error's code survives: unknown_since reaches the driver as code and rpcCode", async () => {
		const peer = new FakeOmpPeer();
		peer.replies.set("get_entries", () => ({ error: "Unknown entries cursor: x", code: "unknown_since" }));
		peer.replies.set("set_model", () => ({ error: "no such model" }));
		const client = await startedClient(peer);
		const raw = await client.getEntries("x").catch((e: unknown) => e);
		expect(raw).toBeInstanceOf(RpcCommandError);
		expect(raw).toMatchObject({ code: "unknown_since", command: "get_entries" });
		await client.stop();

		const second = new FakeOmpPeer();
		for (const [type, rule] of peer.replies) second.replies.set(type, rule);
		const driver = await startedDriver(second);
		try {
			const error = await driver.entriesSince("x").catch((e: unknown) => e);
			expect(error).toBeInstanceOf(OmpDriverError);
			expect(error).toMatchObject({ code: "unknown_since", rpcCode: "unknown_since" });
			expect(await driver.setModel("a/b").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
		} finally {
			await driver.stop();
		}
	});

	test("a request without a response times out; the child's exit rejects what still waits", async () => {
		const peer = new FakeOmpPeer();
		peer.replies.set("get_state", () => "hold");
		const client = new OmpRpcClient({
			executable: "omp",
			args: [],
			cwd: root,
			env: {},
			spawn: peer.spawn,
			requestTimeoutMs: 50,
		});
		await client.start();
		await expect(client.getState()).rejects.toThrow("no response to get_state");
		const pending = client.getState();
		peer.exit(9);
		await expect(pending).rejects.toThrow("omp exited (code 9)");
	});

	test("a request after the child's exit is refused at once, not after requestTimeoutMs", async () => {
		const peer = new FakeOmpPeer();
		const client = new OmpRpcClient({
			executable: "omp",
			args: [],
			cwd: root,
			env: {},
			spawn: peer.spawn,
			requestTimeoutMs: 60_000,
		});
		await client.start();
		const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
		peer.exit(9);
		await exited;
		const failure = await within(
			client.getState().catch((error: unknown) => error),
			2_000,
			"the refusal",
		);
		expect(failure).toBeInstanceOf(OmpDriverError);
		expect(failure).toMatchObject({ code: "not_started", message: expect.stringContaining("omp exited (code 9)") });
	});
});

describe("rpc_chunk", () => {
	test("a 1.5 MB response arrives as chunks and is reassembled", async () => {
		const peer = new FakeOmpPeer();
		peer.replies.set("get_last_assistant_text", () => "hold");
		const client = await startedClient(peer);
		try {
			const text = `${"가".repeat(500_000)}END`; // 1.5 MB of UTF-8, so slices split characters
			const answer = client.getLastAssistantText();
			const command = await peer.command((c) => c.type === "get_last_assistant_text");
			const lines = chunkLines({
				type: "response",
				id: command.id,
				command: "get_last_assistant_text",
				success: true,
				data: { text },
			});
			expect(lines.split("\n").filter(Boolean).length).toBeGreaterThan(4);
			peer.push(lines);
			expect(await within(answer, 5000, "reassembled response")).toBe(text);
		} finally {
			await client.stop();
		}
	});

	test("a chunked event reaches the listeners whole", async () => {
		const peer = new FakeOmpPeer();
		const client = await startedClient(peer);
		try {
			const got = Promise.withResolvers<unknown>();
			client.onEvent((event) => got.resolve(event));
			const big = { type: "message_end", message: { role: "assistant", text: "x".repeat(1_200_000) } };
			peer.push(chunkLines(big, "rpc-7"));
			expect(await within(got.promise, 5000, "event")).toEqual(big);
		} finally {
			await client.stop();
		}
	});

	test("a declared length over 64 MB is a protocol error: the driver ends the turn and the child is stopped", async () => {
		const peer = new FakeOmpPeer();
		const warns: string[] = [];
		const driver = await startedDriver(peer, {
			log: createLogger({ sink: (line) => warns.push(line), clock: { now: () => 0 }, redact }),
		});
		const finals: OmpFinal[] = [];
		const ended = Promise.withResolvers<void>();
		driver.onFinal((final) => {
			finals.push(final);
			ended.resolve();
		});
		const opRef = await driver.prompt("hi");
		peer.push({ type: "rpc_chunk", chunkId: "c", index: 0, count: 300, byteLength: 65 * 1024 * 1024, data: "AAAA" });
		await within(ended.promise, 2000, "error final");
		expect(finals).toEqual([{ opRef, status: "error", text: "", error: expect.stringContaining("exceeds") }]);
		expect(peer.signals[0]).toBe("SIGTERM");
		expect(warns.some((line) => line.includes("omp_stream_protocol_error"))).toBe(true);
	});

	test("the assembler refuses out-of-order, interrupted and pre-negotiation sequences", () => {
		const assembler = new RpcChunkAssembler();
		const frame = { type: "x", pad: "y".repeat(RPC_CHUNK_PAYLOAD_BYTES * 2) };
		const [first, second] = chunkLines(frame)
			.split("\n")
			.map((line) => (line ? JSON.parse(line) : undefined));
		expect(() => new RpcChunkAssembler().push(second)).toThrow(RpcProtocolError);
		expect(assembler.push(first)).toBeUndefined();
		expect(() => assembler.push({ type: "message_end" })).toThrow("interrupted");
		expect(new RpcChunkAssembler().push({ type: "plain" })).toEqual({ type: "plain" });
	});

	test("rpc_chunk before negotiation stops the child", async () => {
		const peer = new FakeOmpPeer();
		peer.ready = undefined;
		const client = new OmpRpcClient({ executable: "omp", args: [], cwd: root, env: {}, spawn: peer.spawn });
		const started = client.start();
		peer.push({ type: "rpc_chunk", chunkId: "c", index: 0, count: 2, byteLength: 10, data: "AAAA" });
		await expect(started).rejects.toThrow("before protocol 2");
		expect(peer.signals[0]).toBe("SIGTERM");
	});
});

describe("stdout lines", () => {
	test("readLines joins chunk-split lines and UTF-8 sequences, and drops a last line without newline", async () => {
		const bytes = new TextEncoder().encode('{"id":"물음표"}\n{"a":1}\n{"tail":');
		const split = 9; // inside the 3-byte "물"
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, split));
				controller.enqueue(bytes.slice(split, split + 3));
				controller.enqueue(bytes.slice(split + 3));
				controller.close();
			},
		});
		const lines: string[] = [];
		for await (const line of readLines(stream)) lines.push(line);
		expect(lines).toEqual(['{"id":"물음표"}', '{"a":1}']);
	});

	test("non-object lines are reported and skipped; later frames still arrive", async () => {
		const peer = new FakeOmpPeer();
		const unreadable: string[] = [];
		const client = await startedClient(peer, { onUnreadable: (line) => unreadable.push(line) });
		try {
			const results: unknown[] = [];
			const got = Promise.withResolvers<void>();
			client.onPromptResult((frame) => {
				results.push(frame);
				got.resolve();
			});
			peer.push("plain log line\nnull\n[1,2]\n\n   \n");
			peer.push({ type: "prompt_result", id: "req_9", agentInvoked: true, status: "completed", sessionSettled: true });
			await within(got.promise, 2000, "prompt_result");
			expect(unreadable).toEqual(["plain log line", "null", "[1,2]"]);
			expect(results).toEqual([
				{ type: "prompt_result", id: "req_9", agentInvoked: true, status: "completed", sessionSettled: true },
			]);
		} finally {
			await client.stop();
		}
	});
});

/** A real RPC child (bun script) that starts a grandchild writing into `fifo`; the fifo's EOF means it is dead. */
function realPeer(dir: string, fifo: string, exitOnGetState: boolean): string {
	const script = join(dir, "peer.ts");
	writeFileSync(
		script,
		`#!${process.execPath}
Bun.spawn(["sh", "-c", 'exec sleep 1000 > "$0"', ${JSON.stringify(fifo)}], { stdio: ["ignore", "ignore", "ignore"] });
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
out(${JSON.stringify({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: 1024 * 1024,
			maxReassembledFrameBytes: 64 * 1024 * 1024,
		})});
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	let newline = buffer.indexOf("\\n");
	while (newline !== -1) {
		const command = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\\n");
		if (command.type === "get_state" && ${exitOnGetState}) process.exit(3);
		const data = command.type === "negotiate_protocol" ? { protocolVersion: 2 } : {};
		out({ type: "response", id: command.id, command: command.type, success: true, data });
	}
}
`,
		{ mode: 0o755 },
	);
	return script;
}

/** Resolves when every writer of `fifo` has closed it. The reader is opened before any writer exists. */
function fifoClosed(fifo: string): Promise<void> {
	const closed = Promise.withResolvers<void>();
	const stream = createReadStream(fifo);
	stream.on("data", () => undefined);
	stream.on("end", () => closed.resolve());
	stream.on("error", closed.reject);
	return closed.promise;
}

describe("process group", () => {
	for (const how of ["stop()", "the child's own exit"] as const) {
		test(`after ${how} no process of the group is left`, async () => {
			const dir = join(root, `group-${how === "stop()" ? "stop" : "exit"}`);
			mkdirSync(dir, { recursive: true });
			const fifo = join(dir, "fifo");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
			const grandchildGone = fifoClosed(fifo);
			const client = new OmpRpcClient({
				executable: realPeer(dir, fifo, how !== "stop()"),
				args: [],
				cwd: dir,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			});
			const exited = Promise.withResolvers<OmpExitInfo["code"]>();
			client.onExit((code) => exited.resolve(code));
			await within(client.start(), 10_000, "start");
			const pid = client.pid ?? 0;
			expect(pid).toBeGreaterThan(0);
			if (how === "stop()") await within(client.stop(), 5000, "stop");
			else await expect(client.getState()).rejects.toThrow("omp exited (code 3)");
			await within(exited.promise, 5000, "exit");
			await within(grandchildGone, 5000, "grandchild end");
			expect(existsSync(`/proc/${pid}/cmdline`) && Bun.file(`/proc/${pid}/stat`).size > 0).toBe(false);
		}, 20_000);
	}
});
