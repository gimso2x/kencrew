// Discord Gateway v10 client on Bun's global WebSocket (JSON encoding, one shard, no compression).
// The reconnect skeleton is shared (src/channel/socket-base.ts); what stays here is Discord's protocol: op codes,
// heartbeat with ACK tracking, session resume and the fatal close codes.

import { SocketBase, type SocketTimers } from "../channel/socket-base";
import {
	DISCORD_INTENTS,
	DiscordCallError,
	DiscordGatewayFatalError,
	type DiscordHandlers,
	type DiscordInteraction,
	type DiscordMessageEvent,
	type DiscordRole,
	FATAL_CLOSE_CODES,
} from "./transport";

/** Timer seam: the gateway's heartbeat, reconnect and backoff waits all go through it, so tests drive time by hand. */
export type GatewayTimers = SocketTimers;

export interface DiscordGatewayOptions {
	token: string;
	/** Gateway URL, or a resolver (`GET /gateway/bot`) called once and cached. Version/encoding query is added. */
	url: string | (() => Promise<string>);
	handlers: DiscordHandlers;
	intents?: number;
	timers?: GatewayTimers;
	/** 0–1; heartbeat jitter and the Invalid Session wait. */
	random?: () => number;
	now?: () => number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	/** Every Ready (`resumed: false`, a new session: events in between are lost) and Resumed (`resumed: true`). */
	onReady?: (info: { resumed: boolean }) => void;
	/** A non-retryable close (4004, 4010–4014): the gateway has stopped for good. */
	onFatal?: (error: DiscordGatewayFatalError) => void;
	/** Body-less errors only (never the token). */
	onError?: (error: Error) => void;
	/** Fired when a connection is being replaced (close, op 7, op 9, missing heartbeat ACK). */
	onReconnect?: (reason: string) => void;
}

const OP = {
	DISPATCH: 0,
	HEARTBEAT: 1,
	IDENTIFY: 2,
	RESUME: 6,
	RECONNECT: 7,
	INVALID_SESSION: 9,
	HELLO: 10,
	HEARTBEAT_ACK: 11,
} as const;

/** A connection with no HELLO this long after it was made is closed and retried after the backoff. */
const HELLO_TIMEOUT_MS = 30_000;

/** Client-side close code that keeps the session resumable (1000/1001 would end it). */
const RESUMABLE_CLOSE = 4900;

/** Close codes after which the session cannot be resumed: 4007 invalid seq, 4009 session timed out. */
const NEW_SESSION_CLOSE: ReadonlySet<number> = new Set([4007, 4009]);

interface Frame {
	op?: number;
	d?: unknown;
	s?: number | null;
	t?: string | null;
}

interface ReconnectPlan {
	/** Drop the session and Identify anew instead of resuming. */
	newSession: boolean;
	/** `backoff`: exponential from `backoffBaseMs`; a number: that exact wait; 0: at once. */
	delay: number | "backoff";
}

function withQuery(url: string): string {
	const parsed = new URL(url);
	if (!parsed.searchParams.has("v")) parsed.searchParams.set("v", "10");
	if (!parsed.searchParams.has("encoding")) parsed.searchParams.set("encoding", "json");
	return parsed.toString();
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Hello → heartbeat (first beat after `interval × jitter`) → Identify, or Resume when a session exists. Ready keeps
 * `session_id`, `resume_gateway_url` and every Dispatch's `s`; a lost connection resumes on the resume URL. A beat whose
 * predecessor got no ACK marks a zombie connection: it is closed and resumed. Reconnect (op 7) resumes at once; Invalid
 * Session (op 9) resumes when `d` is true, otherwise identifies anew after 1–5 s. Fatal close codes stop the client.
 */
export class DiscordGateway extends SocketBase<{ botUserId: string; applicationId: string }> {
	readonly #opts: DiscordGatewayOptions;
	readonly #random: () => number;
	readonly #intents: number;
	#baseUrl: string | undefined;
	#sessionId: string | undefined;
	#resumeUrl: string | undefined;
	#seq: number | undefined;
	#heartbeatTimer: unknown;
	#helloTimer: unknown;
	#awaitingAck = false;

	constructor(options: DiscordGatewayOptions) {
		super({
			backoffBaseMs: options.backoffBaseMs ?? 1_000,
			backoffMaxMs: options.backoffMaxMs ?? 60_000,
			...(options.now === undefined ? {} : { now: options.now }),
			...(options.timers === undefined ? {} : { timers: options.timers }),
			onError: options.onError,
			onReconnect: options.onReconnect,
		});
		this.#opts = options;
		this.#random = options.random ?? Math.random;
		this.#intents = options.intents ?? DISCORD_INTENTS;
	}

	/** Resolves on the first Ready. Rejects on a fatal close or a refused gateway URL lookup; other failures retry. */
	start(): Promise<{ botUserId: string; applicationId: string }> {
		if (!this.stopped) return Promise.reject(new Error("discord gateway already started"));
		const ready = this.beginStart();
		void this.connect();
		return ready;
	}

	stop(): void {
		this.#clearHeartbeat();
		this.#clearHello();
		this.halt(new Error("discord gateway stopped before ready"), 1000);
	}

	#clearHeartbeat(): void {
		this.timers.clear(this.#heartbeatTimer);
		this.#heartbeatTimer = undefined;
	}

	#clearHello(): void {
		this.timers.clear(this.#helloTimer);
		this.#helloTimer = undefined;
	}

	/** What a resume needs: the session, its resume URL and the last Dispatch sequence. */
	session(): { sessionId: string | undefined; resumeUrl: string | undefined; seq: number | undefined } {
		return { sessionId: this.#sessionId, resumeUrl: this.#resumeUrl, seq: this.#seq };
	}

	async #resolveBaseUrl(): Promise<string> {
		if (this.#baseUrl === undefined) {
			const url = this.#opts.url;
			this.#baseUrl = typeof url === "string" ? url : await url();
		}
		return this.#baseUrl;
	}

	protected override async connect(): Promise<void> {
		if (this.stopped) return;
		const gen = this.bumpGeneration();
		const resumeUrl = this.#sessionId === undefined ? undefined : this.#resumeUrl;
		let url: string;
		try {
			url = resumeUrl ?? (await this.#resolveBaseUrl());
		} catch (err) {
			if (gen !== this.generation) return;
			this.report(err);
			if (err instanceof DiscordCallError && err.kind === "definitive") {
				// The gateway URL lookup was refused (bad token): retrying will not help.
				const first = this.takeFirst();
				if (first !== undefined) {
					this.stop();
					first.reject(err);
					return;
				}
			}
			this.scheduleConnect(this.nextBackoff());
			return;
		}
		if (gen !== this.generation) return;

		let ws: WebSocket;
		try {
			ws = new WebSocket(withQuery(url));
		} catch (err) {
			// A gateway URL that is no URL: forget it (the lookup runs again), and a bad resume URL drops the session.
			this.report(new Error(`discord gateway url unusable: ${err instanceof Error ? err.message : String(err)}`));
			if (resumeUrl === undefined) this.#baseUrl = undefined;
			else this.#dropSession();
			this.scheduleConnect(this.nextBackoff());
			return;
		}
		this.ws = ws;
		this.#clearHello();
		this.#helloTimer = this.timers.set(() => {
			if (gen === this.generation) this.#reconnect("hello timeout", { newSession: false, delay: "backoff" });
		}, HELLO_TIMEOUT_MS);
		const resuming = resumeUrl !== undefined;
		const current = (): boolean => this.isCurrent(gen, ws);
		ws.addEventListener("message", (ev) => {
			if (current()) this.#onFrame(gen, ev.data, resuming);
		});
		ws.addEventListener("error", () => {
			if (current()) this.report(new Error("discord gateway websocket error"));
		});
		ws.addEventListener("close", (ev) => {
			if (current()) this.#onClose(ev.code, ev.reason);
		});
	}

	#send(payload: { op: number; d: unknown }): void {
		const ws = this.ws;
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
	}

	#onFrame(gen: number, data: unknown, resuming: boolean): void {
		let frame: Frame;
		try {
			frame = JSON.parse(typeof data === "string" ? data : String(data)) as Frame;
		} catch {
			this.report(new Error("unparseable discord gateway frame"));
			return;
		}
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
			this.report(new Error("non-object discord gateway frame"));
			return;
		}
		if (typeof frame.s === "number") this.#seq = frame.s;
		switch (frame.op) {
			case OP.HELLO: {
				this.#clearHello();
				const interval = record(frame.d).heartbeat_interval;
				if (typeof interval !== "number" || !(interval > 0)) {
					this.report(new Error("discord hello without heartbeat_interval"));
					this.#reconnect("bad hello", { newSession: false, delay: "backoff" });
					return;
				}
				this.#awaitingAck = false;
				this.#clearHeartbeat();
				this.#heartbeatTimer = this.timers.set(() => this.#beat(gen, interval), interval * this.#random());
				if (resuming && this.#sessionId !== undefined) {
					this.#send({
						op: OP.RESUME,
						d: { token: this.#opts.token, session_id: this.#sessionId, seq: this.#seq ?? null },
					});
				} else {
					this.#send({
						op: OP.IDENTIFY,
						d: {
							token: this.#opts.token,
							intents: this.#intents,
							properties: { os: process.platform, browser: "ompbot", device: "ompbot" },
							// Without a presence the bot shows offline in the member list; a resume keeps the session's.
							presence: { status: "online", since: null, activities: [], afk: false },
						},
					});
				}
				return;
			}
			case OP.HEARTBEAT_ACK:
				this.#awaitingAck = false;
				return;
			case OP.HEARTBEAT:
				this.#send({ op: OP.HEARTBEAT, d: this.#seq ?? null });
				return;
			case OP.RECONNECT:
				this.#reconnect("reconnect requested", { newSession: false, delay: 0 });
				return;
			case OP.INVALID_SESSION:
				if (frame.d === true) this.#reconnect("invalid session (resumable)", { newSession: false, delay: 0 });
				else {
					this.#reconnect("invalid session", {
						newSession: true,
						delay: Math.round(1_000 + this.#random() * 4_000),
					});
				}
				return;
			case OP.DISPATCH:
				this.#dispatch(frame.t ?? "", frame.d);
				return;
		}
	}

	#beat(gen: number, interval: number): void {
		if (gen !== this.generation) return;
		if (this.#awaitingAck) {
			this.#reconnect("heartbeat ack missing", { newSession: false, delay: 0 });
			return;
		}
		this.#awaitingAck = true;
		this.#send({ op: OP.HEARTBEAT, d: this.#seq ?? null });
		this.#heartbeatTimer = this.timers.set(() => this.#beat(gen, interval), interval);
	}

	#dispatch(type: string, data: unknown): void {
		const d = record(data);
		const handlers = this.#opts.handlers;
		switch (type) {
			case "READY": {
				const user = record(d.user);
				const application = record(d.application);
				if (
					typeof d.session_id !== "string" ||
					typeof d.resume_gateway_url !== "string" ||
					typeof user.id !== "string" ||
					typeof application.id !== "string"
				) {
					this.report(new Error("discord ready without session or ids"));
					this.#reconnect("bad ready", { newSession: true, delay: "backoff" });
					return;
				}
				this.#sessionId = d.session_id;
				this.#resumeUrl = d.resume_gateway_url;
				this.resetBackoff();
				this.setUp();
				this.#opts.onReady?.({ resumed: false });
				this.resolveFirst({ botUserId: user.id, applicationId: application.id });
				return;
			}
			case "RESUMED":
				this.resetBackoff();
				this.setUp();
				this.#opts.onReady?.({ resumed: true });
				return;
			// Handlers start in arrival order; each runs on its own so a slow one does not hold the socket.
			case "MESSAGE_CREATE":
				this.#run(() => handlers.message(data as DiscordMessageEvent));
				return;
			case "INTERACTION_CREATE":
				this.#run(() => handlers.interaction(data as DiscordInteraction));
				return;
			case "GUILD_CREATE":
				if (Array.isArray(d.roles)) this.#run(() => handlers.roles?.(d.roles as DiscordRole[]));
				return;
			case "GUILD_ROLE_CREATE":
			case "GUILD_ROLE_UPDATE":
				if (d.role !== undefined) this.#run(() => handlers.roles?.([d.role as DiscordRole]));
		}
	}

	#run(handler: () => Promise<void> | void): void {
		try {
			Promise.resolve(handler()).catch((err: unknown) => this.report(err));
		} catch (err) {
			this.report(err);
		}
	}

	#onClose(code: number, reason: string): void {
		if (FATAL_CLOSE_CODES.has(code)) {
			const error = new DiscordGatewayFatalError(code, reason);
			const first = this.takeFirst();
			this.stop();
			first?.reject(error);
			this.#opts.onFatal?.(error);
			return;
		}
		this.#reconnect(`closed ${code}`, { newSession: NEW_SESSION_CLOSE.has(code), delay: "backoff" });
	}

	#reconnect(reason: string, plan: ReconnectPlan): void {
		if (this.stopped) return;
		this.#clearHeartbeat();
		this.#clearHello();
		if (plan.newSession) this.#dropSession();
		this.replaceConnection(reason, plan.newSession ? 1000 : RESUMABLE_CLOSE);
		const delay = plan.delay === "backoff" ? this.nextBackoff() : plan.delay;
		if (delay === 0) void this.connect();
		else this.scheduleConnect(delay);
	}

	#dropSession(): void {
		this.#sessionId = undefined;
		this.#resumeUrl = undefined;
		this.#seq = undefined;
	}
}
