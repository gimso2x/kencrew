// The reconnect skeleton the Discord gateway client builds on: generation counter, exponential
// backoff, guarded socket close, error report, the first-start promise, the up/down+since connection state and the
// timer seam. The protocol work (envelope acks, op codes, resume) stays in each client on purpose.

/** Timer seam: one-shot waits (reconnect backoff, heartbeat, hello timeout) go through it, so tests drive time by hand. */
export interface SocketTimers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const REAL_SOCKET_TIMERS: SocketTimers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Socket up/down rule. Starts `down` at construction; `connected` goes up; `reconnecting` goes down only from up (while
 * already down `since` is kept, so a long outage ages instead of resetting on each backoff). Errors never change the
 * state: the clients report handler and parse errors on a live socket and on every reconnect backoff.
 */
export class SocketConnectionState {
	#state: "up" | "down" = "down";
	#since: number;

	constructor(now: number) {
		this.#since = now;
	}

	on(event: "connected" | "reconnecting" | "error", now: number): void {
		if (event === "connected") {
			if (this.#state !== "up") {
				this.#state = "up";
				this.#since = now;
			}
		} else if (event === "reconnecting" && this.#state === "up") {
			this.#state = "down";
			this.#since = now;
		}
	}

	snapshot(): { state: "up" | "down"; since: number } {
		return { state: this.#state, since: this.#since };
	}
}

export interface SocketBaseOptions {
	/** Exponential reconnect backoff: `Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt++)`; reset on success. */
	backoffBaseMs: number;
	backoffMaxMs: number;
	/** Body-less errors only (never tokens). */
	onError?: (error: Error) => void;
	/** Fired when a connection is being replaced (disconnect envelope, close, dead socket). */
	onReconnect?: (reason: string) => void;
	now?: () => number;
	/** Defaults to `setTimeout`/`clearTimeout`. */
	timers?: SocketTimers;
}

/**
 * Reconnect skeleton shared by the platform WebSocket clients. It owns the generation counter, the backoff, the safe
 * close, the error report, the first-start promise, the up/down+since state and the reconnect timer; the subclass
 * drives them from its protocol (Discord op codes and resume), whose differences are intentional.
 */
export abstract class SocketBase<TFirst = void> {
	protected readonly timers: SocketTimers;
	protected readonly now: () => number;
	protected readonly backoffBaseMs: number;
	protected readonly backoffMaxMs: number;
	protected ws: WebSocket | undefined;
	protected stopped = true;
	/** Bumped whenever a socket is replaced; callbacks of older sockets compare against it and bail. */
	#generation = 0;
	#attempt = 0;
	#reconnectTimer: unknown;
	#first: { resolve: (value: TFirst) => void; reject: (error: Error) => void } | undefined;
	readonly #connection: SocketConnectionState;
	readonly #onError?: (error: Error) => void;
	readonly #onReconnect?: (reason: string) => void;

	protected constructor(options: SocketBaseOptions) {
		this.timers = options.timers ?? REAL_SOCKET_TIMERS;
		this.now = options.now ?? Date.now;
		this.backoffBaseMs = options.backoffBaseMs;
		this.backoffMaxMs = options.backoffMaxMs;
		this.#onError = options.onError;
		this.#onReconnect = options.onReconnect;
		this.#connection = new SocketConnectionState(this.now());
	}

	/** Up from the protocol's connect moment (Discord Ready/Resumed) until the connection is lost. */
	connectionState(): { state: "up" | "down"; since: number } {
		return this.#connection.snapshot();
	}

	protected setUp(): void {
		this.#connection.on("connected", this.now());
	}

	protected setDown(): void {
		this.#connection.on("reconnecting", this.now());
	}

	protected get generation(): number {
		return this.#generation;
	}

	protected bumpGeneration(): number {
		return ++this.#generation;
	}

	/** Whether `ws` is still the socket this generation opened. */
	protected isCurrent(gen: number, ws: WebSocket): boolean {
		return gen === this.#generation && this.ws === ws;
	}

	protected report(err: unknown): void {
		this.#onError?.(err instanceof Error ? err : new Error(String(err)));
	}

	/** `Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt++)` — one step per scheduling, reset on success. */
	protected nextBackoff(): number {
		return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.#attempt++);
	}

	protected resetBackoff(): void {
		this.#attempt = 0;
	}

	protected closeSocket(code?: number): void {
		const ws = this.ws;
		this.ws = undefined;
		if (!ws) return;
		try {
			if (code === undefined) ws.close();
			else ws.close(code);
		} catch {
			// already closed
		}
	}

	/** Start prologue: clears the stop flag and the backoff, and creates the first-start deferred. */
	protected beginStart(): Promise<TFirst> {
		this.stopped = false;
		this.resetBackoff();
		const { promise, resolve, reject } = Promise.withResolvers<TFirst>();
		this.#first = { resolve, reject };
		return promise;
	}

	/** Takes the first-start deferred out so `stop()` will not reject it; the caller rejects it itself. */
	protected takeFirst(): { resolve: (value: TFirst) => void; reject: (error: Error) => void } | undefined {
		const first = this.#first;
		this.#first = undefined;
		return first;
	}

	protected resolveFirst(value: TFirst): void {
		const first = this.#first;
		this.#first = undefined;
		first?.resolve(value);
	}

	/**
	 * Common stop core: no more reconnects or callbacks, the socket closed with `closeCode`, down, and the first-start
	 * promise failed with `firstError`.
	 */
	protected halt(firstError: Error, closeCode?: number): void {
		this.stopped = true;
		this.#generation++;
		this.clearReconnectTimer();
		this.closeSocket(closeCode);
		this.setDown();
		this.#first?.reject(firstError);
		this.#first = undefined;
	}

	/**
	 * Detaches the current socket and notifies: the generation is bumped (old callbacks bail), the socket is closed,
	 * the state goes down and `onReconnect` fires. The caller then connects again, at once or after a wait.
	 */
	protected replaceConnection(reason: string, closeCode?: number): void {
		this.#generation++;
		this.closeSocket(closeCode);
		this.setDown();
		this.#onReconnect?.(reason);
	}

	protected scheduleConnect(delayMs: number): void {
		if (this.stopped) return;
		this.clearReconnectTimer();
		this.#reconnectTimer = this.timers.set(() => {
			this.#reconnectTimer = undefined;
			void this.connect();
		}, delayMs);
	}

	protected clearReconnectTimer(): void {
		this.timers.clear(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
	}

	protected abstract connect(): Promise<void>;
}
