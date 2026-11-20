import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "../log";
import type { HostToolDef } from "../safety/host-tools";
import {
	type OmpAskQuestion,
	type OmpCompactResult,
	type OmpDialogAnswerer,
	type OmpDialogRequest,
	type OmpDialogResponse,
	OmpDriverError,
	type OmpEntries,
	type OmpEvent,
	type OmpExitInfo,
	type OmpFinal,
	type OmpOpenResult,
	type OmpSessionDriver,
	type OmpState,
	type TodoPhase,
} from "./driver";
import { buildChildEnv } from "./env";
import {
	type BtwRecord,
	OmpRpcClient,
	type PromptResultFrame,
	type RpcChild,
	RpcCommandError,
	type RpcProtocolError,
	type RpcSpawnOptions,
} from "./rpc-client";
import { checkOmpRuntime } from "./runtime-check";
import { isRecord } from "./type-guards";

/** How long a side question may take, counted from the `btw` command. */
export const BTW_TIMEOUT_MS = 120_000;

/**
 * Session-only omp events ompbot reads. `auto_retry_end` is here because a retry whose delay exceeds
 * `retry.maxDelayMs` with no fallback ends with `finalError` and no `auto_retry_start` before it.
 */
const FORWARDED_SESSION_EVENTS: ReadonlySet<string> = new Set([
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
]);

/** A finite number of at least `min`, else undefined. */
function countOf(value: unknown, min: number): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? value : undefined;
}

/**
 * `OmpState.context` from omp's `contextUsage`: nothing without a positive window (an unknown model), `tokens`/`percent`
 * null when omp sends no number (right after a compaction it does not know them yet).
 */
function contextOf(usage: unknown): Pick<OmpState, "context"> {
	if (!isRecord(usage)) return {};
	const window = countOf(usage.contextWindow, 1);
	if (window === undefined) return {};
	const tokens = countOf(usage.tokens, 0) ?? null;
	const percent = tokens === null ? null : (countOf(usage.percent, 0) ?? null);
	return { context: { tokens, window, percent } };
}

export interface RpcOmpDriverOptions {
	/** The omp executable (`OMPBOT_OMP_EXECUTABLE`): the package's `dist/cli.js` or the standalone binary. */
	ompExecutable: string;
	cwd: string;
	sessionDir: string;
	provider?: string;
	model?: string;
	thinking?: string;
	/** ompbot-owned `--config` overlay file, only when needed. */
	overlayConfig?: string;
	/** Extra child env, e.g. `{ OMP_WIKI_NOTE_DISABLE: "1" }`. `SLACK_`/`OMPBOT_` keys are rejected. */
	env?: Record<string, string>;
	extraArgs?: string[];
	/** Host tools registered with `set_host_tools` on start (executed by this process). */
	hostTools?: HostToolDef[];
	/** Parent environment source (tests); default `process.env`. */
	baseEnv?: Record<string, string | undefined>;
	/**
	 * Owner answers to omp's select/confirm/input/editor/ask dialogs (chat cards). With it the driver opts in to the
	 * `ask` dialog (`set_ask_dialog enabled:true`) and spawns `--mode rpc-ui` so omp offers the `ask` tool; without it
	 * the child stays headless `rpc` and every dialog is cancelled at once.
	 */
	answerDialog?: OmpDialogAnswerer;
	/** Side question deadline (tests); default `BTW_TIMEOUT_MS`. */
	btwTimeoutMs?: number;
	/** Where `omp_stream_unreadable` warnings go. */
	log?: Logger;
	/** Process launcher (tests: an in-memory RPC peer); default a new process group of the executable. */
	spawn?: (argv: string[], options: RpcSpawnOptions) => RpcChild;
}

/**
 * omp's `extension_ui_request` dialogs and local slash commands, read from the decoded frames of one child.
 *
 * Owner dialogs (`DIALOG_METHODS`) go to `answer` when one is given; without it, or when it returns `undefined`,
 * throws, or the frame does not parse, the dialog is answered `cancelled` (fail-closed). omp's `method:"cancel"`
 * (its own timeout or an aborted turn) aborts the waiting answer, and nothing is written for that dialog afterwards.
 *
 * `localCommand` hears about a prompt omp handled as a local slash command: its `prompt` response says
 * `agentInvoked: false` and no `prompt_result` follows. The text is the `command_output` frames written since the
 * previous `prompt` response — omp writes a command's output before answering the prompt that ran it — joined by
 * newlines, "" when there were none.
 */
export class ExtensionUiTap {
	readonly #emit: (event: OmpEvent) => void;
	readonly #reply: (frame: Record<string, unknown>) => void;
	readonly #answer: OmpDialogAnswerer | undefined;
	readonly #localCommand: ((id: string, output: string) => void) | undefined;
	readonly #waiting = new Map<string, AbortController>();
	readonly #commandOutput: string[] = [];

	constructor(
		emit: (event: OmpEvent) => void,
		reply: (frame: Record<string, unknown>) => void,
		answer?: OmpDialogAnswerer,
		localCommand?: (id: string, output: string) => void,
	) {
		this.#emit = emit;
		this.#reply = reply;
		this.#answer = answer;
		this.#localCommand = localCommand;
	}

	frame(frame: Record<string, unknown>): void {
		if (frame.type === "command_output") {
			if (typeof frame.text === "string") this.#commandOutput.push(frame.text);
			return;
		}
		if (frame.type === "response") {
			if (frame.command !== "prompt") return;
			const output = this.#commandOutput.splice(0).join("\n");
			const local = frame.success === true && isRecord(frame.data) && frame.data.agentInvoked === false;
			if (local && typeof frame.id === "string") this.#localCommand?.(frame.id, output);
			return;
		}
		if (frame.type !== "extension_ui_request") return;
		this.#emit({ type: "extension_ui_request", method: frame.method, id: frame.id });
		if (frame.method === "cancel" && typeof frame.targetId === "string") {
			this.#waiting.get(frame.targetId)?.abort();
			this.#waiting.delete(frame.targetId);
			return;
		}
		if (typeof frame.method !== "string" || !DIALOG_METHODS.has(frame.method)) return;
		const answer = this.#answer;
		const request = answer === undefined ? undefined : parseDialogRequest(frame);
		if (answer === undefined || request === undefined) {
			this.#reply({ type: "extension_ui_response", id: frame.id, cancelled: true });
			return;
		}
		const controller = new AbortController();
		this.#waiting.set(request.id, controller);
		void answerDialog(answer, request, controller.signal).then((response) => {
			if (controller.signal.aborted) return; // omp already settled it; a late answer must not land
			this.#waiting.delete(request.id);
			this.#reply({ type: "extension_ui_response", id: request.id, ...response });
		});
	}

	/** The child is gone: nobody reads an answer anymore, so close the cards still waiting. */
	close(): void {
		for (const controller of this.#waiting.values()) controller.abort();
		this.#waiting.clear();
	}
}

/** The answerer's response, or `cancelled` when it has none or throws (fail-closed). */
async function answerDialog(
	answer: OmpDialogAnswerer,
	request: OmpDialogRequest,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	try {
		return (await answer(request, signal)) ?? { cancelled: true };
	} catch {
		return { cancelled: true };
	}
}

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** One `ask` question from the wire, or undefined when its shape is not omp's. */
function parseAskQuestion(value: unknown): OmpAskQuestion | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.question !== "string") return undefined;
	if (!Array.isArray(value.options)) return undefined;
	const options: OmpAskQuestion["options"] = [];
	for (const option of value.options) {
		if (!isRecord(option) || typeof option.label !== "string") return undefined;
		const description = optionalString(option.description);
		options.push(description === undefined ? { label: option.label } : { label: option.label, description });
	}
	const header = optionalString(value.header);
	const recommended = typeof value.recommended === "number" ? value.recommended : undefined;
	return {
		id: value.id,
		question: value.question,
		options,
		...(header === undefined ? {} : { header }),
		...(value.multi === true ? { multi: true } : {}),
		...(recommended === undefined ? {} : { recommended }),
	};
}

/** The optional row descriptions and checkbox state of a select frame with `rowCount` rows; malformed parts are left out. */
function selectExtras(
	frame: Record<string, unknown>,
	rowCount: number,
): Pick<Extract<OmpDialogRequest, { method: "select" }>, "descriptions" | "checkedIndices" | "markableCount"> {
	const extras: ReturnType<typeof selectExtras> = {};
	const { optionDetails, checkedIndices, markableCount } = frame;
	if (Array.isArray(optionDetails)) {
		const descriptions = optionDetails.slice(0, rowCount).map((detail) => {
			const text = isRecord(detail) ? optionalString(detail.description) : undefined;
			return text === undefined || text.trim() === "" ? undefined : text;
		});
		if (descriptions.some((text) => text !== undefined)) extras.descriptions = descriptions;
	}
	if (Array.isArray(checkedIndices)) {
		extras.checkedIndices = checkedIndices.filter(
			(index): index is number => Number.isInteger(index) && index >= 0 && index < rowCount,
		);
	}
	if (typeof markableCount === "number" && Number.isInteger(markableCount) && markableCount >= 0) {
		extras.markableCount = Math.min(markableCount, rowCount);
	}
	return extras;
}

/** A dialog frame as an `OmpDialogRequest`; undefined when a required field is missing (it is then cancelled). */
function parseDialogRequest(frame: Record<string, unknown>): OmpDialogRequest | undefined {
	const { id, title } = frame;
	if (typeof id !== "string") return undefined;
	const timeout = typeof frame.timeout === "number" ? frame.timeout : undefined;
	const withTimeout = timeout === undefined ? {} : { timeout };
	switch (frame.method) {
		case "select":
			if (typeof title !== "string" || !Array.isArray(frame.options)) return undefined;
			if (!frame.options.every((option) => typeof option === "string")) return undefined;
			return {
				method: "select",
				id,
				title,
				options: frame.options as string[],
				...withTimeout,
				...(typeof frame.selectionMarker === "string" ? { selectionMarker: frame.selectionMarker } : {}),
				...selectExtras(frame, frame.options.length),
			};
		case "confirm":
			if (typeof title !== "string" || typeof frame.message !== "string") return undefined;
			return { method: "confirm", id, title, message: frame.message, ...withTimeout };
		case "input": {
			if (typeof title !== "string") return undefined;
			const placeholder = optionalString(frame.placeholder);
			return {
				method: "input",
				id,
				title,
				...(placeholder === undefined ? {} : { placeholder }),
				...withTimeout,
				...(frame.secret === true ? { secret: true } : {}),
			};
		}
		case "editor": {
			if (typeof title !== "string") return undefined;
			const prefill = optionalString(frame.prefill);
			return { method: "editor", id, title, ...(prefill === undefined ? {} : { prefill }) };
		}
		case "ask": {
			if (!Array.isArray(frame.questions) || frame.questions.length === 0) return undefined;
			const questions = frame.questions.map(parseAskQuestion);
			if (questions.some((question) => question === undefined)) return undefined;
			return { method: "ask", id, questions: questions as OmpAskQuestion[], ...withTimeout };
		}
		default:
			return undefined;
	}
}

function toDriverError(error: unknown): unknown {
	if (!(error instanceof RpcCommandError)) return error;
	return new OmpDriverError(error.code === "unknown_since" ? "unknown_since" : "rpc_error", error.message, {
		rpcCode: error.code,
		cause: error,
	});
}

/** Dialogs only a person can answer: the owner through `answerDialog`, else cancelled at once instead of hanging the turn. */
const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor", "ask"]);

/**
 * `leafId()` without moving the whole session through the pipe: reads `get_entries(since=cache.since)` so only the
 * entries after the last-seen cursor are serialized, and remembers the returned `leafId`. An `unknown_since` error
 * (cursor gone after a session switch or compaction) falls back to one full read and re-seeds the cache. A `null`
 * leafId (empty session) is never fed back as a cursor: omp only treats an absent `since` as "everything".
 */
export async function leafIdViaCursor(
	getEntries: (since?: string) => Promise<OmpEntries>,
	cache: { since?: string },
): Promise<string | null> {
	try {
		const slice = await getEntries(cache.since);
		cache.since = slice.leafId ?? undefined;
		return slice.leafId;
	} catch (error) {
		if (!(error instanceof OmpDriverError) || error.code !== "unknown_since") throw error;
		const full = await getEntries(undefined);
		cache.since = full.leafId ?? undefined;
		return full.leafId;
	}
}

export class RpcOmpDriver implements OmpSessionDriver {
	readonly #options: RpcOmpDriverOptions;
	/** The started client: commands go here. */
	#client: OmpRpcClient | undefined;
	/** The client whose child is (or was last) running: its exit and stream reports count until `stop()` ends. */
	#active: OmpRpcClient | undefined;
	#stopping = false;
	readonly #finalListeners = new Set<(final: OmpFinal) => void>();
	readonly #eventListeners = new Set<(event: OmpEvent) => void>();
	readonly #exitListeners = new Set<(info: OmpExitInfo) => void>();
	readonly #admitted = new Set<string>();
	/** Ends of prompts whose `prompt()` has not resolved yet, delivered on admission so onFinal never precedes it. */
	readonly #early = new Map<string, () => void>();
	/** Last leafId this driver saw from a `leafId()` read; seed for the delta read in `leafIdViaCursor`. */
	readonly #leafCursor: { since?: string } = {};
	#unsubscribers: Array<() => void> = [];

	constructor(options: RpcOmpDriverOptions) {
		this.#options = options;
	}

	/** Pid of the live child (for leftover-process checks); undefined when not running. */
	get pid(): number | undefined {
		return this.#active?.pid;
	}

	async start(): Promise<void> {
		if (this.#client) throw new OmpDriverError("already_started", "driver already started");
		const options = this.#options;
		const env = buildChildEnv(options.env, options.baseEnv);
		const problem = await checkOmpRuntime(options.ompExecutable, env);
		if (problem) throw new OmpDriverError(problem.code, problem.message);

		mkdirSync(resolve(options.cwd), { recursive: true });
		mkdirSync(resolve(options.sessionDir), { recursive: true });

		// omp builds the `ask` tool only for a UI session; a child whose dialogs reach the owner runs `rpc-ui`.
		const args = ["--mode", options.answerDialog === undefined ? "rpc" : "rpc-ui", "--no-title"];
		if (options.provider) args.push("--provider", options.provider);
		if (options.model) args.push("--model", options.model);
		args.push("--session-dir", options.sessionDir);
		if (options.overlayConfig) args.push("--config", options.overlayConfig);
		if (options.thinking) args.push("--thinking", options.thinking);
		args.push(...(options.extraArgs ?? []));

		this.#stopping = false;
		const client: OmpRpcClient = new OmpRpcClient({
			executable: options.ompExecutable,
			args,
			cwd: options.cwd,
			env,
			...(options.hostTools === undefined ? {} : { hostTools: options.hostTools }),
			...(options.spawn === undefined ? {} : { spawn: options.spawn }),
			onUnreadable: (line) => {
				if (this.#active === client) this.#onUnreadable(line);
			},
		});
		const tap = new ExtensionUiTap(
			(event) => this.#emit(event),
			(frame) => this.#writeRaw(client, frame),
			options.answerDialog,
			(id, output) => {
				if (this.#active === client) this.#onLocalCommand(id, output);
			},
		);
		this.#active = client;
		// Not in #unsubscribers: the exit of a child being stopped is still reported (expected: true).
		client.onExit((code, stderr) => {
			tap.close();
			if (this.#active === client) this.#emitExit(code, stderr);
		});
		this.#unsubscribers = [
			client.onFrame((frame) => tap.frame(frame)),
			client.onEvent((event) => this.#emit(event)),
			// Session events also include the agent events `onEvent` delivers, so only the session-only types pass.
			client.onSessionEvent((event) => {
				if (FORWARDED_SESSION_EVENTS.has(event.type)) this.#emit(event);
			}),
			client.onPromptResult((frame) => this.#onPromptResult(frame)),
			client.onProtocolError((error) => {
				if (this.#active === client) this.#onProtocolError(error);
			}),
		];
		try {
			await client.start();
		} catch (error) {
			for (const off of this.#unsubscribers) off();
			this.#unsubscribers = [];
			if (this.#active === client) this.#active = undefined;
			throw toDriverError(error);
		}
		this.#client = client;
		// `ask` arrives as one dialog only when someone answers it; otherwise explicit false, so a default change cannot
		// enable a dialog nobody answers.
		const askDialog = options.answerDialog !== undefined;
		this.#writeRaw(client, {
			type: "set_ask_dialog",
			id: `ompbot-ask-dialog-${askDialog ? "on" : "off"}`,
			enabled: askDialog,
		});
	}

	#emit(event: OmpEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	/** One frame to the child outside request tracking (dialog answers, `set_ask_dialog`). */
	#writeRaw(client: OmpRpcClient, frame: Record<string, unknown>): void {
		try {
			client.write(frame);
		} catch {
			// the child is gone; its exit is reported through onExit
		}
	}

	#emitExit(code: number | null, stderr: string): void {
		const info: OmpExitInfo = { code, expected: this.#stopping, stderr };
		for (const listener of this.#exitListeners) listener(info);
	}

	/** A stdout line that is not one JSON object is skipped by the client; it is only logged. */
	#onUnreadable(line: string): void {
		this.#options.log?.warn("omp_stream_unreadable", { line: line.slice(0, 120), prompts: this.#admitted.size });
	}

	/**
	 * The stream broke the RPC protocol (a bad `rpc_chunk` sequence) and the client is stopping the child: the running
	 * prompts can no longer get a result, so they end now with an error final and the next message starts a fresh one.
	 */
	#onProtocolError(error: RpcProtocolError): void {
		const opRefs = [...this.#admitted];
		this.#options.log?.warn("omp_stream_protocol_error", { error: error.message, prompts: opRefs.length });
		this.#admitted.clear();
		for (const opRef of opRefs) {
			const final: OmpFinal = { opRef, status: "error", text: "", error: `omp stream broken: ${error.message}` };
			for (const listener of this.#finalListeners) listener(final);
		}
		void this.stop().catch((stopError: unknown) => {
			this.#options.log?.warn("omp_stop_failed", { error: String(stopError) });
		});
	}

	#onPromptResult(frame: PromptResultFrame): void {
		const id = frame.id;
		if (id === undefined) return;
		const deliver = () => void this.#finalize(id, frame);
		if (this.#admitted.has(id)) deliver();
		else this.#early.set(id, deliver);
	}

	/**
	 * A prompt omp ran as a local slash command: no `prompt_result` will come, so it ends here, completed with the
	 * command's output. The last assistant text is not read — it is the previous turn's answer.
	 */
	#onLocalCommand(id: string, output: string): void {
		const deliver = () => {
			this.#admitted.delete(id);
			const final: OmpFinal = { opRef: id, status: "completed", text: output };
			for (const listener of this.#finalListeners) listener(final);
		};
		if (this.#admitted.has(id)) deliver();
		else this.#early.set(id, deliver);
	}

	async #finalize(opRef: string, frame: PromptResultFrame): Promise<void> {
		this.#admitted.delete(opRef);
		const final: OmpFinal = { opRef, status: frame.status, text: "" };
		if (frame.error) final.error = frame.error.message;
		if (frame.status === "completed" && this.#client) {
			try {
				final.text = (await this.#client.getLastAssistantText()) ?? "";
			} catch (error) {
				final.status = "error";
				final.error = `get_last_assistant_text failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		for (const listener of this.#finalListeners) listener(final);
	}

	#require(): OmpRpcClient {
		if (!this.#client) throw new OmpDriverError("not_started", "driver not started");
		return this.#client;
	}

	async #call<T>(run: (client: OmpRpcClient) => Promise<T>): Promise<T> {
		try {
			return await run(this.#require());
		} catch (error) {
			throw toDriverError(error);
		}
	}

	async prompt(text: string): Promise<string> {
		const opRef = await this.#call((client) => client.prompt(text));
		this.#admitted.add(opRef);
		const early = this.#early.get(opRef);
		if (early) {
			this.#early.delete(opRef);
			early();
		}
		return opRef;
	}

	steer(text: string): Promise<void> {
		return this.#call((client) => client.steer(text));
	}

	abort(): Promise<void> {
		return this.#call((client) => client.abort());
	}

	async abortAndClearQueue(): Promise<void> {
		// The withdrawn queue is dropped: those messages are ledger rows of the stopped turn, settled with it.
		await this.#call((client) => client.abortAndRestoreQueue());
	}

	newSession(): Promise<{ cancelled: boolean }> {
		return this.#call((client) => client.newSession());
	}

	async openSession(): Promise<OmpOpenResult> {
		const result = await this.#call((client) => client.openSession(resolve(this.#options.sessionDir)));
		return { resumed: result.resumed, sessionId: result.sessionId };
	}

	async state(): Promise<OmpState> {
		const raw = await this.#call((client) => client.getState());
		return {
			sessionId: raw.sessionId,
			sessionFile: raw.sessionFile,
			idle: !raw.isStreaming && !raw.isCompacting,
			settled: raw.isSettled,
			queuedMessageCount: raw.queuedMessageCount,
			messageCount: raw.messageCount,
			model: raw.model?.id === undefined ? undefined : `${raw.model.provider ?? "?"}/${raw.model.id}`,
			...(raw.thinkingLevel === undefined ? {} : { thinking: raw.thinkingLevel }),
			...contextOf(raw.contextUsage),
		};
	}

	switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		return this.#call((client) => client.switchSession(resolve(sessionFile)));
	}

	async availableModels(): Promise<string[]> {
		const models = await this.#call((client) => client.getAvailableModels());
		return models.map((model) => `${model.provider}/${model.id}`);
	}

	async setModel(model: string): Promise<string> {
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) {
			throw new OmpDriverError("rpc_error", `model must be provider/id: ${model}`);
		}
		const set = await this.#call((client) => client.setModel(model.slice(0, slash), model.slice(slash + 1)));
		return `${set.provider}/${set.id}`;
	}

	thinkingLevels(): Promise<string[]> {
		return this.#call((client) => client.getAvailableThinkingLevels());
	}

	setThinking(level: string): Promise<void> {
		return this.#call((client) => client.setThinkingLevel(level));
	}

	async setTodos(phases: TodoPhase[]): Promise<void> {
		await this.#call((client) => client.setTodos(phases));
	}

	async compact(instructions?: string): Promise<OmpCompactResult> {
		const result = await this.#call((client) => client.compact(instructions));
		return { tokensBefore: result.tokensBefore, summary: result.summary };
	}

	async leafId(): Promise<string | null> {
		// mailbox.ts reads the cursor per message/per steer; keep it a delta read instead of a whole-session one.
		return leafIdViaCursor((since) => this.entriesSince(since), this.#leafCursor);
	}

	entriesSince(since?: string): Promise<OmpEntries> {
		return this.#call((client) => client.getEntries(since));
	}

	/**
	 * One side question (`btw`): subscribes to `btw_record` first, then asks. omp writes the `running` frame before the
	 * command's response, so frames seen before the id is known are kept and matched once it is; only a non-running
	 * record of that id settles. A deadline (from the command) cancels the question — by id when known, else whatever
	 * is running or starting.
	 */
	async btw(question: string): Promise<string> {
		const client = this.#require();
		const done = Promise.withResolvers<string>();
		let id: string | undefined;
		const early: BtwRecord[] = [];
		const settle = (record: BtwRecord): void => {
			if (record.id !== id || record.status === "running") return;
			if (record.status === "complete") {
				done.resolve(record.answer.trim() || "(빈 답)");
				return;
			}
			const reason = record.error === undefined ? record.status : `${record.status}: ${record.error}`;
			done.reject(new OmpDriverError("rpc_error", `btw ${reason}`));
		};
		const off = client.onBtwRecord((record) => {
			if (id === undefined) early.push(record);
			else settle(record);
		});
		const timer = setTimeout(() => {
			done.reject(new OmpDriverError("rpc_error", "btw timeout"));
			// Best effort: the caller already gets the timeout, and a cancel that fails leaves nothing to undo here.
			void (id === undefined ? client.cancelBtw() : client.cancelBtw(id)).catch(() => undefined);
		}, this.#options.btwTimeoutMs ?? BTW_TIMEOUT_MS);
		client.btw(question).then(
			(record) => {
				id = record.id;
				for (const seen of early) settle(seen);
			},
			(error: unknown) => done.reject(toDriverError(error)),
		);
		try {
			return await done.promise;
		} finally {
			clearTimeout(timer);
			off();
		}
	}

	onFinal(listener: (final: OmpFinal) => void): () => void {
		this.#finalListeners.add(listener);
		return () => this.#finalListeners.delete(listener);
	}

	onEvent(listener: (event: OmpEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onExit(listener: (info: OmpExitInfo) => void): () => void {
		this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	async stop(): Promise<void> {
		const client = this.#client;
		if (!client) return;
		this.#stopping = true;
		this.#client = undefined;
		for (const off of this.#unsubscribers) off();
		this.#unsubscribers = [];
		await client.stop();
		this.#admitted.clear();
		this.#early.clear();
		if (this.#active === client) this.#active = undefined;
	}
}
