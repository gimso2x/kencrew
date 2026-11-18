// The Bot Framework endpoint: `POST /api/messages` on a loopback listener (a tunnel outside the daemon gives it its
// public HTTPS). A request is authenticated first; an accepted Activity is handed on and answered 200 at once — the
// answer itself goes out later through the Bot Connector.
import type { Logger } from "../log";
import type { TeamsAuth } from "./auth";
import type { TeamsActivity } from "./types";

/** Larger bodies are refused before parsing (a Teams message Activity is a few KB). */
const MAX_ACTIVITY_BYTES = 1024 * 1024;

interface TeamsServerOptions {
	hostname: string;
	/** 0: any free port (tests). */
	port: number;
	auth: TeamsAuth;
	log: Logger;
	/** Takes an authenticated Activity; the request is answered once it returns. Must not throw. */
	onActivity(activity: TeamsActivity): Promise<void>;
}

export class TeamsServer {
	readonly #options: TeamsServerOptions;
	#server: Bun.Server<undefined> | undefined;

	constructor(options: TeamsServerOptions) {
		this.#options = options;
	}

	/** Starts listening; returns the bound port. */
	start(): number {
		const { hostname, port } = this.#options;
		this.#server = Bun.serve({ hostname, port, fetch: (request) => this.#handle(request) });
		return this.#server.port ?? port;
	}

	async stop(): Promise<void> {
		await this.#server?.stop(true);
		this.#server = undefined;
	}

	async #handle(request: Request): Promise<Response> {
		const { auth, log, onActivity } = this.#options;
		if (new URL(request.url).pathname !== "/api/messages") return new Response("not found", { status: 404 });
		if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
		const unauthorized = (reason: string): Response => {
			log.warn("teams_auth_rejected", { reason });
			return new Response("unauthorized", { status: 401 });
		};
		// The token is checked from the header alone: an unauthenticated sender gets nothing buffered.
		const token = await auth.verifyToken(request.headers.get("authorization"));
		if (!token.ok) return unauthorized(token.reason);
		if (Number(request.headers.get("content-length") ?? 0) > MAX_ACTIVITY_BYTES) {
			return new Response("too large", { status: 413 });
		}
		const text = await readBounded(request);
		if (text === undefined) return new Response("too large", { status: 413 });
		let activity: TeamsActivity;
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			activity = parsed as TeamsActivity;
		} catch {
			return new Response("bad request", { status: 400 });
		}
		const verdict = auth.verifyActivity(token.token, activity);
		if (!verdict.ok) return unauthorized(verdict.reason);
		await onActivity(activity);
		return new Response(null, { status: 200 });
	}
}

/**
 * The body as text, read chunk by chunk and given up (`undefined`) the moment its bytes pass `MAX_ACTIVITY_BYTES` —
 * a chunked request has no content-length to refuse it by up front.
 */
async function readBounded(request: Request): Promise<string | undefined> {
	if (request.body === null) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_ACTIVITY_BYTES) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}
