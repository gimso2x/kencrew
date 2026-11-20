import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcChild, RpcSpawnOptions } from "../../src/omp/rpc-client";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES } from "../../src/omp/rpc-client";

/** A command the client wrote, as parsed from its stdin line. */
export type Command = Record<string, unknown> & { type: string; id?: string };

/**
 * How the peer answers one command: `data` (success), `error` (+ `code`) or `hold` (the test answers later with
 * `respond`). Commands without a rule succeed with `{}` data, except the ones in `DEFAULT_DATA`.
 */
export type Reply = { data?: unknown } | { error: string; code?: string } | "hold";

export const READY_V2 = {
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: MAX_RPC_FRAME_BYTES,
	maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
};

/** Frames the host writes that omp never answers (they answer omp). */
const NOT_COMMANDS: ReadonlySet<string> = new Set(["host_tool_result", "host_tool_update", "extension_ui_response"]);

const DEFAULT_DATA: Record<string, (command: Command) => unknown> = {
	negotiate_protocol: () => ({ protocolVersion: 2 }),
	set_host_tools: (command) => ({ toolNames: (command.tools as Array<{ name: string }>).map((tool) => tool.name) }),
	get_last_assistant_text: () => ({ text: "fake assistant text" }),
	get_state: () => ({
		sessionId: "fake-session",
		isStreaming: false,
		isCompacting: false,
		isSettled: true,
		queuedMessageCount: 0,
		messageCount: 0,
	}),
	get_entries: () => ({ entries: [], leafId: null }),
	open_session: () => ({ cancelled: false, resumed: false, sessionId: "fake-session" }),
	new_session: () => ({ cancelled: false }),
	switch_session: () => ({ cancelled: false }),
	abort_and_restore_queue: () => ({ steering: [], followUp: [] }),
};

/**
 * An in-memory omp RPC peer: the `spawn` it hands to the client returns a child whose stdin is parsed here and whose
 * stdout the test writes. It sends `ready` (protocol 2 by default) on spawn and answers commands by `replies`.
 */
export class FakeOmpPeer {
	readonly commands: Command[] = [];
	readonly spawned: Array<{ argv: string[]; options: RpcSpawnOptions }> = [];
	readonly replies = new Map<string, (command: Command) => Reply>();
	readonly signals: string[] = [];
	ready: Record<string, unknown> | undefined = READY_V2;
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	#exit = Promise.withResolvers<number | null>();
	#waiters: Array<{ match: (command: Command) => boolean; resolve: (command: Command) => void }> = [];
	stderrText = "";

	readonly spawn = (argv: string[], options: RpcSpawnOptions): RpcChild => {
		this.spawned.push({ argv, options });
		const stdout = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.#controller = controller;
			},
		});
		if (this.ready !== undefined) queueMicrotask(() => this.push(this.ready ?? {}));
		return {
			pid: 4242,
			stdout,
			write: (line) => this.#receive(line),
			stderr: () => this.stderrText,
			exited: this.#exit.promise,
			signal: (signal) => {
				this.signals.push(signal);
				this.exit(signal === "SIGKILL" ? 137 : 143);
			},
		};
	};

	/** Writes a frame (or a raw text, newline included by the caller) to the child's stdout. */
	push(frame: Record<string, unknown> | string): void {
		const text = typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`;
		this.#controller?.enqueue(new TextEncoder().encode(text));
	}

	/** Answers a held command. */
	respond(command: Command, reply: Exclude<Reply, "hold">): void {
		this.push(
			"error" in reply
				? { type: "response", id: command.id, command: command.type, success: false, ...reply }
				: { type: "response", id: command.id, command: command.type, success: true, data: reply.data },
		);
	}

	/** Resolves with the first command (already written or still to come) that `match` accepts. */
	command(match: (command: Command) => boolean): Promise<Command> {
		const seen = this.commands.find(match);
		if (seen !== undefined) return Promise.resolve(seen);
		const found = Promise.withResolvers<Command>();
		this.#waiters.push({ match, resolve: found.resolve });
		return found.promise;
	}

	/** The child ends: stdout closes, `exited` resolves. */
	exit(code: number | null): void {
		try {
			this.#controller?.close();
		} catch {
			// already closed
		}
		// Like a dead child's pipe, later frames go nowhere.
		this.#controller = undefined;
		this.#exit.resolve(code);
	}

	#receive(line: string): void {
		const command = JSON.parse(line) as Command;
		this.commands.push(command);
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.match(command)) waiter.resolve(command);
			else this.#waiters.push(waiter);
		}
		if (command.id === undefined || NOT_COMMANDS.has(command.type)) return;
		const rule = this.replies.get(command.type);
		const reply: Reply = rule ? rule(command) : { data: DEFAULT_DATA[command.type]?.(command) ?? {} };
		if (reply !== "hold") queueMicrotask(() => this.respond(command, reply));
	}
}

/** A stand-in omp executable that only answers `--version` (the driver's pre-spawn check). */
export function fakeOmpExecutable(dir: string, version = "omp/19.0.0"): string {
	const path = join(dir, "omp");
	writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
	chmodSync(path, 0o755);
	return path;
}
