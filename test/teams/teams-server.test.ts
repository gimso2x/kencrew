// The endpoint's body bound (muse review 2, defect 1): the token is checked from the header before any body is read,
// and a chunked body (no content-length) is cut with 413 the moment its bytes — not its characters — pass the limit.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { createLogger } from "../../src/log";
import { redact } from "../../src/redact";
import { TeamsAuth } from "../../src/teams/auth";
import { TeamsServer } from "../../src/teams/server";
import type { TeamsActivity } from "../../src/teams/types";
import { APP_ID, botFrameworkClaims, FakeMicrosoft, messageActivity, signJwt, TENANT } from "./harness";

const MAX_ACTIVITY_BYTES = 1024 * 1024;

let ms: FakeMicrosoft;
let server: TeamsServer;
let port: number;
let token: string;
const activities: TeamsActivity[] = [];
const sockets: Socket[] = [];

beforeAll(async () => {
	ms = new FakeMicrosoft();
	await ms.start();
	const auth = new TeamsAuth({
		appId: APP_ID,
		tenantId: TENANT,
		botFrameworkOpenIdUrl: ms.botFrameworkOpenIdUrl,
		entraOpenIdUrl: ms.entraOpenIdUrl,
	});
	server = new TeamsServer({
		hostname: "127.0.0.1",
		port: 0,
		auth,
		log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact }),
		onActivity: async (activity) => {
			activities.push(activity);
		},
	});
	port = server.start();
	token = await signJwt(ms.botFrameworkKey, botFrameworkClaims(ms.serviceUrl));
});

afterAll(async () => {
	for (const socket of sockets) socket.destroy();
	await server.stop();
	await ms.stop();
});

/**
 * A chunked POST written on a raw socket; `end: false` never sends the last chunk (the body stays open, as a sender
 * streaming without end would). Resolves with the response's status code; bounded.
 */
function chunkedPost(authorization: string | undefined, chunks: Uint8Array[], end: boolean): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const socket = connect(port, "127.0.0.1");
	sockets.push(socket);
	const timer = setTimeout(() => reject(new Error("no response within 5000ms")), 5_000);
	let head = "";
	socket.on("data", (data) => {
		head += data.toString("latin1");
		const status = /^HTTP\/1\.1 (\d{3})/.exec(head);
		if (status === null) return;
		clearTimeout(timer);
		resolve(Number(status[1]));
	});
	socket.on("error", () => undefined);
	socket.write(
		[
			"POST /api/messages HTTP/1.1",
			`Host: 127.0.0.1:${port}`,
			"Content-Type: application/json",
			"Transfer-Encoding: chunked",
			...(authorization === undefined ? [] : [`Authorization: Bearer ${authorization}`]),
			"",
			"",
		].join("\r\n"),
	);
	for (const chunk of chunks) {
		socket.write(`${chunk.byteLength.toString(16)}\r\n`);
		socket.write(chunk);
		socket.write("\r\n");
	}
	if (end) socket.write("0\r\n\r\n");
	return promise;
}

/** `count` chunks of 64 KiB of spaces (valid JSON whitespace). */
const blanks = (count: number): Uint8Array[] =>
	Array.from({ length: count }, () => new Uint8Array(64 * 1024).fill(0x20));

describe("Teams endpoint body bound", () => {
	test("a chunked body past the byte limit is cut with 413 without waiting for its end", async () => {
		// 17 × 64 KiB = 1.0625 MiB of an open body: answered while the sender is still sending.
		expect(await chunkedPost(token, blanks(17), false)).toBe(413);
	});

	test("the limit counts bytes: multi-byte text under the limit in characters but over it in bytes is 413", async () => {
		const activity = messageActivity({ id: "big-1", text: "가".repeat(400_000), serviceUrl: ms.serviceUrl });
		const body = new TextEncoder().encode(JSON.stringify(activity));
		expect(JSON.stringify(activity).length).toBeLessThan(MAX_ACTIVITY_BYTES);
		expect(body.byteLength).toBeGreaterThan(MAX_ACTIVITY_BYTES);
		const before = activities.length;
		expect(await chunkedPost(token, [body], true)).toBe(413);
		expect(activities.length).toBe(before);
	});

	test("the header token is checked before the body: no token, or a bad one, is 401 on an open body", async () => {
		expect(await chunkedPost(undefined, blanks(1), false)).toBe(401);
		const forged = await signJwt(ms.entraKey, botFrameworkClaims(ms.serviceUrl), "bf-key");
		expect(await chunkedPost(forged, blanks(1), false)).toBe(401);
	});

	test("a chunked Activity under the limit is still taken", async () => {
		const activity = messageActivity({ id: "small-1", text: "안녕", serviceUrl: ms.serviceUrl });
		const before = activities.length;
		expect(await chunkedPost(token, [new TextEncoder().encode(JSON.stringify(activity))], true)).toBe(200);
		expect(activities.length).toBe(before + 1);
	});
});
