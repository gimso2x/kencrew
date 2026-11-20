import { OmpDriverError, type OmpEntries, type OmpEvent, type TodoPhase } from "./driver";
import { isRecord } from "./type-guards";

/*
 * omp's stdio RPC, spoken directly: no file of the omp package is imported (types included), so an omp executable is
 * whatever `ompExecutable` names — the package's `dist/cli.js` or the standalone binary `omp update` installs.
 *
 * Wire (omp 19, `--mode rpc` / `rpc-ui`): one JSON object per stdout line. The child first writes `ready`; when it
 * offers protocol 2 the client sends `negotiate_protocol` and from then on a logical frame longer than one line
 * (1 MiB) arrives as consecutive `rpc_chunk` lines (base64 slices of its UTF-8 JSON, at most 256 KiB each, 64 MiB in
 * all). Commands carry an `id` the `response` echoes; everything else is an event or a request from the child
 * (`host_tool_call`, `host_tool_cancel`, `extension_ui_request`).
 */

/** Largest physical frame: one stdout line, newline included. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Largest logical frame protocol 2 reassembles from `rpc_chunk` lines. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** Largest decoded payload of one `rpc_chunk`. */
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

const REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;
/** How long the process group gets between SIGTERM and SIGKILL. */
const TERMINATION_GRACE_MS = 1_000;
/** Bytes of the child's stderr kept for exit reports. */
const STDERR_TAIL_BYTES = 64 * 1024;

/** Agent events (`onEvent`); the session listener hears these too. */
const AGENT_EVENT_TYPES: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_stream_update",
	"tool_execution_end",
]);

/** Session-level events (`onSessionEvent`), on top of the agent events. */
const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
	...AGENT_EVENT_TYPES,
	"auto_compaction_start",
	"auto_compaction_end",
	"manual_compaction_start",
	"manual_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"cache_warming_start",
	"cache_warming_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"model_changed",
	"goal_updated",
	"queue_update",
]);

/** A failed command; `code` is omp's machine-readable error code when it sent one (e.g. `unknown_since`). */
export class RpcCommandError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "RpcCommandError";
	}
}

/** The stream broke the wire protocol (a bad `rpc_chunk` sequence, a frame over the reassembly ceiling). */
export class RpcProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcProtocolError";
	}
}

export interface PromptResultFrame {
	id?: string;
	status: "completed" | "aborted" | "error";
	error?: { message: string };
}

/** A side question's record (`btw_record`; only the fields ompbot reads). */
export interface BtwRecord {
	id: string;
	status: "running" | "complete" | "cancelled" | "error" | "interrupted";
	answer: string;
	error?: string;
}

export interface RpcState {
	sessionId: string;
	sessionFile?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	isSettled: boolean;
	queuedMessageCount: number;
	messageCount: number;
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
	/** `{ tokens, contextWindow, percent }`; read field by field, never trusted as typed. */
	contextUsage?: unknown;
}

/** A tool result as omp's `AgentToolResult`; a tool may return a plain string instead. */
export interface RpcToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}

/** A tool this process executes for the child (`set_host_tools`). */
export interface RpcHostTool {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(
		params: Record<string, unknown>,
		context: {
			toolCallId: string;
			signal: AbortSignal;
			/** Streams a partial result to the child as `host_tool_update`. */
			sendUpdate(partial: string | RpcToolResult): void;
		},
	): Promise<string | RpcToolResult> | string | RpcToolResult;
}

/** The child process as the client drives it; tests substitute an in-memory peer. */
export interface RpcChild {
	readonly pid: number;
	readonly stdout: ReadableStream<Uint8Array>;
	/** Writes one serialized line; throws when the pipe is gone. */
	write(line: string): void;
	/** The last `STDERR_TAIL_BYTES` of stderr. */
	stderr(): string;
	/** Exit code, null when a signal ended it. */
	readonly exited: Promise<number | null>;
	/** Signals the child and everything it started. */
	signal(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface RpcSpawnOptions {
	cwd: string;
	env: Record<string, string>;
}

/**
 * Spawns `argv` as the leader of a new process group (`detached`), so `signal` reaches the tools and subagents omp
 * started as well. Limit: a descendant that left the group (`setsid`, its own `detached` spawn) is not reached.
 */
export function spawnProcessGroup(argv: string[], options: RpcSpawnOptions): RpcChild {
	const child = Bun.spawn(argv, {
		cwd: options.cwd,
		env: options.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	let tail = "";
	void (async () => {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of child.stderr) {
				tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
			}
		} catch {
			// stderr closes with the child
		}
	})();
	return {
		pid: child.pid,
		stdout: child.stdout,
		write(line) {
			child.stdin.write(line);
			child.stdin.flush();
		},
		stderr: () => tail,
		exited: child.exited,
		signal(signal) {
			try {
				process.kill(-child.pid, signal);
			} catch {
				// ESRCH: the whole group is already gone
			}
		},
	};
}

/** The lines of `stream`, UTF-8 sequences and lines split across chunks reassembled; a last line without `\n` is dropped. */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			yield buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
		// A line still without its newline past the frame limit is never a valid frame: stop buffering it.
		if (Buffer.byteLength(buffer) > MAX_RPC_FRAME_BYTES) {
			throw new RpcProtocolError(`line over ${MAX_RPC_FRAME_BYTES} bytes without a newline`);
		}
	}
}

/** A line as one JSON object; undefined for anything else (broken JSON, `null`, an array, a number). */
function parseObject(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Reassembles protocol-2 `rpc_chunk` sequences; any other frame passes through. Throws `RpcProtocolError`. */
export class RpcChunkAssembler {
	#pending: { chunkId: string; count: number; byteLength: number; parts: Uint8Array[]; received: number } | undefined;

	/** The logical frame, or undefined while a chunk sequence is still incomplete. */
	push(frame: Record<string, unknown>): Record<string, unknown> | undefined {
		if (frame.type !== "rpc_chunk") {
			if (this.#pending) throw new RpcProtocolError("rpc_chunk sequence interrupted by another frame");
			return frame;
		}
		const { chunkId, index, count, byteLength, data } = frame;
		if (
			typeof chunkId !== "string" ||
			chunkId === "" ||
			typeof index !== "number" ||
			typeof count !== "number" ||
			typeof byteLength !== "number" ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			count < 2 ||
			index < 0 ||
			index >= count
		) {
			throw new RpcProtocolError("rpc_chunk metadata invalid");
		}
		if (byteLength > MAX_RPC_REASSEMBLED_BYTES) {
			throw new RpcProtocolError(`rpc_chunk frame of ${byteLength} bytes exceeds ${MAX_RPC_REASSEMBLED_BYTES}`);
		}
		if (typeof data !== "string" || data === "" || !BASE64.test(data)) {
			throw new RpcProtocolError("rpc_chunk data is not base64");
		}
		const bytes = Buffer.from(data, "base64");
		if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) throw new RpcProtocolError("rpc_chunk payload over 256 KiB");
		if (this.#pending === undefined) {
			if (index !== 0) throw new RpcProtocolError("rpc_chunk sequence does not start at index 0");
			this.#pending = { chunkId, count, byteLength, parts: [], received: 0 };
		}
		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.parts.length !== index
		) {
			throw new RpcProtocolError("rpc_chunk sequence out of order");
		}
		pending.parts.push(bytes);
		pending.received += bytes.byteLength;
		if (pending.received > byteLength) throw new RpcProtocolError("rpc_chunk sequence longer than declared");
		if (pending.parts.length < count) return undefined;
		this.#pending = undefined;
		if (pending.received !== byteLength) throw new RpcProtocolError("rpc_chunk sequence shorter than declared");
		let json: string;
		try {
			json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.parts));
		} catch {
			throw new RpcProtocolError("rpc_chunk payload is not UTF-8");
		}
		const logical = parseObject(json);
		if (logical === undefined) throw new RpcProtocolError("rpc_chunk payload is not one JSON object");
		return logical;
	}
}

/** `true` when `ready` offers protocol 2 with the frame limits this client decodes. */
function offersProtocol2(ready: Record<string, unknown>): boolean {
	return (
		Array.isArray(ready.supportedProtocolVersions) &&
		ready.supportedProtocolVersions.includes(2) &&
		ready.maxFrameBytes === MAX_RPC_FRAME_BYTES &&
		ready.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES
	);
}

const PROMPT_STATUSES: ReadonlySet<unknown> = new Set(["completed", "aborted", "error"]);

/** A `prompt_result` frame as the turn's end; a status omp did not send (or sent as anything else) ends it as an error. */
function promptResultOf(frame: Record<string, unknown>): PromptResultFrame {
	if (PROMPT_STATUSES.has(frame.status)) return frame as unknown as PromptResultFrame;
	const id = typeof frame.id === "string" ? { id: frame.id } : {};
	return { ...id, status: "error", error: { message: "omp sent a prompt_result without a valid status" } };
}

function normalizeToolResult(result: string | RpcToolResult): RpcToolResult {
	return typeof result === "string" ? { content: [{ type: "text", text: result }] } : result;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Response {
	id?: string;
	command: string;
	success: boolean;
	error?: string;
	code?: string;
	data?: unknown;
}

function asResponse(frame: Record<string, unknown>): Response | undefined {
	if (frame.type !== "response" || typeof frame.command !== "string" || typeof frame.success !== "boolean") {
		return undefined;
	}
	if (frame.id !== undefined && typeof frame.id !== "string") return undefined;
	if (frame.success === false && typeof frame.error !== "string") return undefined;
	return frame as unknown as Response; // fields checked above
}

export interface OmpRpcClientOptions {
	/** The omp executable, started as is (`dist/cli.js` through its shebang, or the standalone binary). */
	executable: string;
	/** Arguments after the executable (`--mode rpc` …). */
	args: string[];
	cwd: string;
	/** The child's whole environment (not merged with this process's). */
	env: Record<string, string>;
	hostTools?: readonly RpcHostTool[];
	/** Every non-blank stdout line that is not one JSON object; the line is skipped. */
	onUnreadable?: (line: string) => void;
	/** Process launcher (tests); default `spawnProcessGroup`. */
	spawn?: (argv: string[], options: RpcSpawnOptions) => RpcChild;
	/** Response deadline per command (tests); default 30 s. */
	requestTimeoutMs?: number;
	/** SIGTERM→SIGKILL grace (tests); default 1 s. */
	terminationGraceMs?: number;
}

/**
 * One omp child over stdio RPC. `start()` spawns it and resolves once it is ready (protocol negotiated, host tools
 * registered); `stop()` ends the process group. Not restartable: a new child is a new client.
 */
export class OmpRpcClient {
	readonly #options: OmpRpcClientOptions;
	#child: RpcChild | undefined;
	#stopping: Promise<void> | undefined;
	#protocol2 = false;
	/** Set once the child has exited: later requests fail with it instead of waiting for an answer that cannot come. */
	#exitError: OmpDriverError | undefined;
	#requestId = 0;
	readonly #pending = new Map<string, { resolve: (response: Response) => void; reject: (error: Error) => void }>();
	readonly #toolCalls = new Map<string, AbortController>();
	readonly #frameListeners = new Set<(frame: Record<string, unknown>) => void>();
	readonly #eventListeners = new Set<(event: OmpEvent) => void>();
	readonly #sessionListeners = new Set<(event: OmpEvent) => void>();
	readonly #promptResultListeners = new Set<(frame: PromptResultFrame) => void>();
	readonly #btwListeners = new Set<(record: BtwRecord) => void>();
	readonly #exitListeners = new Set<(code: number | null, stderr: string) => void>();
	readonly #protocolErrorListeners = new Set<(error: RpcProtocolError) => void>();
	#ready: PromiseWithResolvers<Record<string, unknown>> | undefined;

	constructor(options: OmpRpcClientOptions) {
		this.#options = options;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	async start(): Promise<void> {
		if (this.#child) throw new OmpDriverError("already_started", "rpc client already started");
		const options = this.#options;
		const spawn = options.spawn ?? spawnProcessGroup;
		const child = spawn([options.executable, ...options.args], { cwd: options.cwd, env: options.env });
		this.#child = child;
		const ready = Promise.withResolvers<Record<string, unknown>>();
		this.#ready = ready;
		void child.exited.then(
			(code) => this.#onExit(child, code),
			() => this.#onExit(child, null),
		);
		void this.#read(child);
		const timer = setTimeout(
			() => ready.reject(new Error(`omp did not become ready within ${READY_TIMEOUT_MS / 1000}s: ${child.stderr()}`)),
			READY_TIMEOUT_MS,
		);
		try {
			const frame = await ready.promise;
			if (!offersProtocol2(frame)) {
				throw new OmpDriverError(
					"omp_rpc_unsupported",
					`omp at ${options.executable} does not offer RPC protocol 2 (ready: ${JSON.stringify(frame).slice(0, 200)})`,
				);
			}
			// Chunks are legal from the moment the request is out: omp switches before writing its answer.
			this.#protocol2 = true;
			const negotiated = this.#data<{ protocolVersion?: unknown }>(
				await this.#request({ type: "negotiate_protocol", protocolVersion: 2 }),
			);
			if (negotiated.protocolVersion !== 2) {
				throw new OmpDriverError("omp_rpc_unsupported", "omp refused RPC protocol 2");
			}
			const tools = options.hostTools ?? [];
			if (tools.length > 0) {
				const definitions = tools.map(({ name, label, description, parameters }) => ({
					name,
					label,
					description,
					parameters,
				}));
				this.#data(await this.#request({ type: "set_host_tools", tools: definitions }));
			}
		} catch (error) {
			await this.stop();
			throw error;
		} finally {
			clearTimeout(timer);
			this.#ready = undefined;
		}
	}

	/** Ends the process group (SIGTERM, SIGKILL after the grace) and rejects what still waits. Idempotent. */
	stop(): Promise<void> {
		const child = this.#child;
		if (!child) return Promise.resolve();
		this.#stopping ??= (async () => {
			this.#rejectAll(new Error("rpc client stopped"));
			child.signal("SIGTERM");
			const kill = setTimeout(() => child.signal("SIGKILL"), this.#options.terminationGraceMs ?? TERMINATION_GRACE_MS);
			await child.exited.catch(() => null);
			clearTimeout(kill);
			// Group members got the SIGTERM with the leader and its whole grace; whatever outlived the leader goes now.
			child.signal("SIGKILL");
		})();
		return this.#stopping;
	}

	#onExit(child: RpcChild, code: number | null): void {
		this.#ready?.reject(new Error(`omp exited (code ${code}) before ready: ${child.stderr()}`));
		const message = `omp exited (code ${code}): ${child.stderr().slice(-2_000)}`;
		this.#exitError = new OmpDriverError("not_started", message);
		this.#rejectAll(new Error(message));
		if (this.#stopping === undefined) {
			// Died on its own: what it started would outlive it, so the group is ended the way stop() ends it.
			child.signal("SIGTERM");
			setTimeout(() => child.signal("SIGKILL"), this.#options.terminationGraceMs ?? TERMINATION_GRACE_MS);
		}
		for (const listener of this.#exitListeners) listener(code, child.stderr());
	}

	#rejectAll(error: Error): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const request of pending) request.reject(error);
		for (const controller of this.#toolCalls.values()) controller.abort(error);
		this.#toolCalls.clear();
	}

	async #read(child: RpcChild): Promise<void> {
		const chunks = new RpcChunkAssembler();
		try {
			for await (const line of readLines(child.stdout)) {
				if (line.trim() === "") continue;
				const value = parseObject(line);
				if (value === undefined) {
					this.#options.onUnreadable?.(line);
					continue;
				}
				if (this.#ready !== undefined && value.type === "ready") {
					this.#ready.resolve(value);
					continue;
				}
				if (value.type === "rpc_chunk" && !this.#protocol2) {
					throw new RpcProtocolError("rpc_chunk before protocol 2 was negotiated");
				}
				const frame = chunks.push(value);
				if (frame !== undefined) this.#dispatch(frame);
			}
		} catch (error) {
			if (this.#child !== child || this.#stopping !== undefined) return;
			const broken = error instanceof RpcProtocolError ? error : new RpcProtocolError(`stdout: ${errorText(error)}`);
			this.#ready?.reject(broken);
			for (const listener of this.#protocolErrorListeners) listener(broken);
			void this.stop();
		}
	}

	#dispatch(frame: Record<string, unknown>): void {
		for (const listener of this.#frameListeners) listener(frame);
		const response = asResponse(frame);
		if (response !== undefined) {
			const pending = response.id === undefined ? undefined : this.#pending.get(response.id);
			if (pending !== undefined && response.id !== undefined) {
				this.#pending.delete(response.id);
				pending.resolve(response);
			}
			return;
		}
		switch (frame.type) {
			case "host_tool_call":
				void this.#hostToolCall(frame);
				return;
			case "host_tool_cancel":
				if (typeof frame.targetId === "string") this.#toolCalls.get(frame.targetId)?.abort();
				return;
			case "prompt_result":
				if (typeof frame.agentInvoked !== "boolean") return;
				for (const listener of this.#promptResultListeners) listener(promptResultOf(frame));
				return;
			case "btw_record":
				if (!isRecord(frame.record)) return;
				for (const listener of this.#btwListeners) listener(frame.record as unknown as BtwRecord);
				return;
		}
		if (typeof frame.type !== "string" || !SESSION_EVENT_TYPES.has(frame.type)) return;
		const event = frame as OmpEvent;
		for (const listener of this.#sessionListeners) listener(event);
		if (AGENT_EVENT_TYPES.has(frame.type)) for (const listener of this.#eventListeners) listener(event);
	}

	async #hostToolCall(frame: Record<string, unknown>): Promise<void> {
		const { id, toolCallId, toolName } = frame;
		const args = frame.arguments;
		if (typeof id !== "string" || typeof toolCallId !== "string" || typeof toolName !== "string" || !isRecord(args)) {
			return;
		}
		const tool = this.#options.hostTools?.find((candidate) => candidate.name === toolName);
		if (tool === undefined) {
			this.#writeQuiet({
				type: "host_tool_result",
				id,
				result: { content: [{ type: "text", text: `Host tool "${toolName}" is not registered` }], details: {} },
				isError: true,
			});
			return;
		}
		const controller = new AbortController();
		this.#toolCalls.set(id, controller);
		const sendUpdate = (partial: string | RpcToolResult): void => {
			if (controller.signal.aborted) return;
			this.#writeQuiet({ type: "host_tool_update", id, partialResult: normalizeToolResult(partial) });
		};
		try {
			const result = await tool.execute(args, { toolCallId, signal: controller.signal, sendUpdate });
			if (controller.signal.aborted) return;
			this.#writeQuiet({ type: "host_tool_result", id, result: normalizeToolResult(result) });
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeQuiet({
				type: "host_tool_result",
				id,
				result: { content: [{ type: "text", text: errorText(error) }], details: {} },
				isError: true,
			});
		} finally {
			this.#toolCalls.delete(id);
		}
	}

	/** One frame to the child outside request tracking (dialog answers, `set_ask_dialog`, tool results). */
	write(frame: Record<string, unknown>): void {
		const child = this.#child;
		if (!child) throw new OmpDriverError("not_started", "rpc client not started");
		child.write(`${JSON.stringify(frame)}\n`);
	}

	/** `write` for frames whose loss only matters through the child's exit, which is reported on its own. */
	#writeQuiet(frame: Record<string, unknown>): void {
		try {
			this.write(frame);
		} catch {
			// the child is gone; onExit reports it
		}
	}

	#request(command: Record<string, unknown> & { type: string }): Promise<Response> {
		if (this.#exitError) return Promise.reject(this.#exitError);
		const id = `req_${++this.#requestId}`;
		const answered = Promise.withResolvers<Response>();
		const timeoutMs = this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		const timer = setTimeout(() => {
			if (!this.#pending.delete(id)) return;
			answered.reject(
				new OmpDriverError(
					"request_timeout",
					`no response to ${command.type} within ${timeoutMs / 1000}s: ${this.stderr()}`,
				),
			);
		}, timeoutMs);
		this.#pending.set(id, answered);
		try {
			this.write({ ...command, id });
		} catch (error) {
			this.#pending.delete(id);
			answered.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return answered.promise.finally(() => clearTimeout(timer));
	}

	#data<T>(response: Response): T {
		if (!response.success) throw new RpcCommandError(response.error ?? "", response.command, response.code);
		return response.data as T; // the shape each command answers with (rpc-types.ts of omp 19)
	}

	stderr(): string {
		return this.#child?.stderr() ?? "";
	}

	/** Every decoded frame, before it is routed (chunked frames reassembled). */
	onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
		this.#frameListeners.add(listener);
		return () => this.#frameListeners.delete(listener);
	}

	onEvent(listener: (event: OmpEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	/** Session events, agent events included. */
	onSessionEvent(listener: (event: OmpEvent) => void): () => void {
		this.#sessionListeners.add(listener);
		return () => this.#sessionListeners.delete(listener);
	}

	onPromptResult(listener: (frame: PromptResultFrame) => void): () => void {
		this.#promptResultListeners.add(listener);
		return () => this.#promptResultListeners.delete(listener);
	}

	onBtwRecord(listener: (record: BtwRecord) => void): () => void {
		this.#btwListeners.add(listener);
		return () => this.#btwListeners.delete(listener);
	}

	/** The child exited (on its own or through `stop()`). */
	onExit(listener: (code: number | null, stderr: string) => void): () => void {
		this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	/** The stream broke the protocol; the client is stopping the child. */
	onProtocolError(listener: (error: RpcProtocolError) => void): () => void {
		this.#protocolErrorListeners.add(listener);
		return () => this.#protocolErrorListeners.delete(listener);
	}

	/** Resolves with the request id once the prompt is admitted; its end comes as a `prompt_result` with that id. */
	async prompt(message: string): Promise<string> {
		const response = await this.#request({ type: "prompt", message });
		this.#data(response);
		return response.id ?? "";
	}

	// steer, abort and set_thinking_level resolve without checking `success`, as omp's own client always did.
	async steer(message: string): Promise<void> {
		await this.#request({ type: "steer", message });
	}

	async abort(): Promise<void> {
		await this.#request({ type: "abort" });
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.#request({ type: "set_thinking_level", level });
	}

	/** Aborts and withdraws omp's steer/follow-up queue, resolving with what was withdrawn. */
	async abortAndRestoreQueue(): Promise<unknown> {
		return this.#data(await this.#request({ type: "abort_and_restore_queue" }));
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		return this.#data(await this.#request({ type: "new_session" }));
	}

	async openSession(sessionDir: string): Promise<{ cancelled: boolean; resumed: boolean; sessionId: string }> {
		return this.#data(await this.#request({ type: "open_session", sessionDir }));
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return this.#data(await this.#request({ type: "switch_session", sessionPath }));
	}

	async getState(): Promise<RpcState> {
		return this.#data(await this.#request({ type: "get_state" }));
	}

	async getEntries(since?: string): Promise<OmpEntries> {
		return this.#data(await this.#request({ type: "get_entries", since }));
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.#data<{ text: string | null }>(await this.#request({ type: "get_last_assistant_text" })).text;
	}

	async getAvailableModels(): Promise<Array<{ provider: string; id: string }>> {
		return this.#data<{ models: Array<{ provider: string; id: string }> }>(
			await this.#request({ type: "get_available_models" }),
		).models;
	}

	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		return this.#data(await this.#request({ type: "set_model", provider, modelId }));
	}

	async getAvailableThinkingLevels(): Promise<string[]> {
		return this.#data<{ levels: string[] }>(await this.#request({ type: "get_available_thinking_levels" })).levels;
	}

	async compact(customInstructions?: string): Promise<{ summary: string; tokensBefore: number }> {
		return this.#data(await this.#request({ type: "compact", customInstructions }));
	}

	/** Replaces the session's task list; resolves with the phases omp stored. */
	async setTodos(phases: TodoPhase[]): Promise<TodoPhase[]> {
		return this.#data<{ todoPhases: TodoPhase[] }>(await this.#request({ type: "set_todos", phases })).todoPhases;
	}

	/** Starts a side question; resolves with its `running` record, the outcome arrives through `onBtwRecord`. */
	async btw(question: string): Promise<BtwRecord> {
		return this.#data<{ record: BtwRecord }>(await this.#request({ type: "btw", question })).record;
	}

	/** Cancels the running (or starting) side question; with an id only when it is that record. */
	async cancelBtw(recordId?: string): Promise<boolean> {
		const command = recordId === undefined ? { type: "btw_cancel" } : { type: "btw_cancel", recordId };
		return this.#data<{ cancelled: boolean }>(await this.#request(command)).cancelled;
	}
}
