// qa-x channel defects (doc/plans/qa-x-channel-fixes.md): one reproduction per defect, written before the fix.
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { splitCards, tableToAscii } from "../src/channel/card";
import type { CoreSink, DeliverySource, InboundMessage } from "../src/channel/types";
import { DiscordAdapter } from "../src/discord/adapter";
import { DiscordBackfill, QUARANTINE_RETRY_MS } from "../src/discord/backfill";
import { DiscordChannel } from "../src/discord/channel";
import { escapeDiscordMarkdown, mrkdwnToDiscord } from "../src/discord/format";
import { DiscordGateway, type GatewayTimers } from "../src/discord/gateway";
import { DiscordSocketTransport } from "../src/discord/socket-transport";
import { DiscordCallError, type DiscordHandlers, type DiscordMessageEvent } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { renderOutboundText, renderTeamsParts } from "../src/teams/format";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const OWNER = "100000000000000001";
const BOT = "500000000000000000";
const GUILD = "300000000000000001";
const CH = "111111111111111111";
const WAIT_MS = 5_000;
// Not a real token: assembled at runtime so no token-shaped literal sits in the repo.
const TOKEN = ["TEST", "qa-x", "token"].join(".");

describe("1. a quarantined channel is read again after a day without a restart", () => {
	test("the in-memory mark expires with the ledger row", async () => {
		const ledger = new Map<string, string>();
		let now = 1_800_000_000_000;
		let reads = 0;
		const backfill = new DiscordBackfill({
			transport: {
				listMessages: async () => {
					reads += 1;
					throw new DiscordCallError("definitive", "discord_http_403:50001 Missing Access", 403, 50001);
				},
			},
			cursors: {
				getCursor: (key) => ledger.get(key),
				setCursor: (key, value) => void ledger.set(key, value),
				deleteCursor: (key) => void ledger.delete(key),
			},
			log: createLogger({ sink: () => {}, clock: { now: () => 0 }, redact }),
			now: () => now,
			targets: () => [{ channelId: CH, dm: true }],
			ready: async () => true,
			locate: async () => ({ dm: true }),
			ingest: async () => "recorded",
		});
		const pass = async (): Promise<void> => {
			backfill.trigger();
			await backfill.waitForIdle();
		};
		await pass();
		expect(reads).toBe(1);
		await pass();
		expect(reads).toBe(1);
		now += QUARANTINE_RETRY_MS + 1;
		await pass();
		expect(reads).toBe(2);
	});
});

describe("2. an edit of a recorded channel-root command is dropped", () => {
	test("a root command fixed into plain text is not recorded as a new thread origin", async () => {
		const transport = new FakeDiscordTransport({ botUserId: BOT });
		transport.setChannel({ id: CH, type: 0, guildId: GUILD });
		const inbound: InboundMessage[] = [];
		const logs: string[] = [];
		const core: CoreSink = {
			onInbound: (message) => {
				inbound.push(message);
				return undefined;
			},
			onCommand: () => undefined,
			onAction: () => {},
			knowsThread: (threadRef) => inbound.some((m) => m.threadRef === threadRef),
			hasInbound: (id) => inbound.some((m) => m.platformMessageId === id),
			inboundText: (id) => inbound.find((m) => m.platformMessageId === id)?.text,
		};
		const noDeliveries: DeliverySource = { claimDue: () => [], confirm: () => {}, fail: () => {}, defer: () => {} };
		const adapter = new DiscordAdapter({
			channel: new DiscordChannel(transport, { ownerUserId: OWNER }),
			core,
			deliveries: noDeliveries,
			ownerUserId: OWNER,
			clock: { now: () => 1_800_000_000_000 },
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact }),
			onInboundFailure: () => {},
		});
		await adapter.start();
		const root: DiscordMessageEvent = {
			id: "700000000000000001",
			channel_id: CH,
			guild_id: GUILD,
			author: { id: OWNER },
			content: `<@${BOT}> !model`,
			type: 0,
		};
		await transport.emitMessage(root);
		expect(inbound).toHaveLength(1);
		const editedAt = new Date(Number((BigInt(root.id) >> 22n) + 1_420_070_400_000n) + 60_000).toISOString();
		await transport.emitMessageUpdate({ ...root, content: `<@${BOT}> 그냥 문장`, edited_timestamp: editedAt });
		expect(inbound).toHaveLength(1);
		expect(logs.some((line) => line.includes("reason=edit_command"))).toBe(true);
	});
});

describe("3. Teams outbound fences GFM tables", () => {
	const table = "| a | b |\n|---|---|\n| 1 | 2 |";
	test("renderTeamsParts", () => {
		const [part] = renderTeamsParts(table, false);
		expect(part).toContain("```");
		expect(part).not.toContain("|---|");
	});
	test("renderOutboundText body", () => {
		const text = renderOutboundText({ text: "t", body: table });
		expect(text).toContain("```");
		expect(text).not.toContain("|---|");
	});
});

describe("4. a 404 on a message id is not remembered as a missing channel", () => {
	test("a thread opened later from that message is found", async () => {
		const transport = new FakeDiscordTransport({ botUserId: BOT });
		transport.setChannel({ id: CH, type: 0, guildId: GUILD });
		const channel = new DiscordChannel(transport, { ownerUserId: OWNER });
		const messageId = "700000000000000009";
		expect(await channel.destination(CH, messageId)).toEqual({
			channelId: CH,
			messageReference: { messageId },
		});
		transport.setChannel({ id: messageId, type: 11, parentId: CH, guildId: GUILD });
		expect(await channel.destination(CH, messageId)).toEqual({ channelId: messageId });
		expect(await channel.channelInfo(messageId)).toMatchObject({ id: messageId, type: 11 });
	});
});

interface Frame {
	op: number;
	d: unknown;
}

interface Server {
	port: number;
	conns: Array<{ ws: ServerWebSocket<unknown>; received: Frame[]; closed: boolean; path: string }>;
	/** What to send after a connection takes its IDENTIFY/RESUME; called with the connection index. */
	onSession: (index: number) => void;
	notify(): void;
	until(cond: () => boolean): Promise<void>;
	stop(): void;
}

function startServer(): Server {
	const waiters: Array<() => void> = [];
	const s: Server = {
		port: 0,
		conns: [],
		onSession: () => {},
		notify: () => {
			for (const w of waiters.splice(0)) w();
		},
		until: async (cond) => {
			const deadline = Date.now() + WAIT_MS;
			while (!cond()) {
				const left = deadline - Date.now();
				if (left <= 0) throw new Error("timed out waiting for condition");
				const { promise, resolve } = Promise.withResolvers<void>();
				const t = setTimeout(resolve, left);
				waiters.push(() => {
					clearTimeout(t);
					resolve();
				});
				await promise;
			}
		},
		stop: () => {},
	};
	const server = Bun.serve<{ path: string }>({
		port: 0,
		fetch(req, srv) {
			return srv.upgrade(req, { data: { path: new URL(req.url).pathname } })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(ws) {
				s.conns.push({ ws, received: [], closed: false, path: ws.data.path });
				ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }));
				s.notify();
			},
			message(ws, raw) {
				const index = s.conns.findIndex((c) => c.ws === ws);
				const frame = JSON.parse(String(raw)) as Frame;
				s.conns[index]?.received.push(frame);
				if (frame.op === 2 || frame.op === 6) s.onSession(index);
				s.notify();
			},
			close(ws) {
				const conn = s.conns.find((c) => c.ws === ws);
				if (conn) conn.closed = true;
				s.notify();
			},
		},
	});
	s.port = server.port ?? 0;
	s.stop = () => void server.stop(true);
	return s;
}

const ready = (port: number) => ({
	op: 0,
	t: "READY",
	s: 1,
	d: {
		v: 10,
		session_id: "sess-1",
		resume_gateway_url: `ws://localhost:${port}/resume`,
		user: { id: BOT, bot: true },
		application: { id: "600000000000000001" },
	},
});

class ManualTimers implements GatewayTimers {
	#seq = 0;
	readonly pending = new Map<number, number>();
	set(_fn: () => void, ms: number): unknown {
		this.#seq += 1;
		this.pending.set(this.#seq, ms);
		return this.#seq;
	}
	clear(handle: unknown): void {
		this.pending.delete(handle as number);
	}
}

let server: Server | undefined;
let gateway: DiscordGateway | undefined;
let transport: DiscordSocketTransport | undefined;

afterEach(async () => {
	gateway?.stop();
	await transport?.stop();
	server?.stop();
	gateway = undefined;
	transport = undefined;
	server = undefined;
});

const noHandlers: DiscordHandlers = { message: async () => {}, interaction: async () => {} };

describe("5. a stopped gateway or transport cannot be revived on a stale session", () => {
	test("start() after stop() identifies anew and resolves", async () => {
		const srv = startServer();
		server = srv;
		srv.onSession = (index) => {
			const resume = srv.conns[index]?.received.some((f) => f.op === 6) === true;
			srv.conns[index]?.ws.send(JSON.stringify(resume ? { op: 0, t: "RESUMED", s: 2, d: {} } : ready(srv.port)));
		};
		const gw = new DiscordGateway({
			token: TOKEN,
			url: `ws://localhost:${srv.port}/gateway`,
			handlers: noHandlers,
			timers: new ManualTimers(),
			backoffBaseMs: 100,
			backoffMaxMs: 1_000,
		});
		gateway = gw;
		await gw.start();
		gw.stop();
		expect(gw.session().sessionId).toBeUndefined();
		await gw.start();
		expect(srv.conns).toHaveLength(2);
		expect(srv.conns[1]?.received.map((f) => f.op)).toContain(2);
		expect(srv.conns[1]?.received.map((f) => f.op)).not.toContain(6);
	});

	test("a second start() on a running transport is refused and opens no second socket", async () => {
		const srv = startServer();
		server = srv;
		srv.onSession = (index) => srv.conns[index]?.ws.send(JSON.stringify(ready(srv.port)));
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ url: `ws://localhost:${srv.port}/gateway` }), {
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		transport = new DiscordSocketTransport({ botToken: TOKEN }, { baseUrl: "http://localhost/api/v10", fetchImpl });
		await transport.start(noHandlers);
		await expect(transport.start(noHandlers)).rejects.toThrow();
		await srv.until(() => srv.conns.length >= 1);
		expect(srv.conns).toHaveLength(1);
		expect(srv.conns[0]?.closed).toBe(false);
	});
});

describe("6. an inject preview's code span shows no entity", () => {
	test("`a<b` stays a<b", () => {
		const shown = mrkdwnToDiscord(`> ${escapeDiscordMarkdown("`a<b`")}`);
		expect(shown).not.toContain("&lt;");
		expect(shown).toContain("a<b");
	});
});

describe("7. Teams port text keeps fields and button words past a long code block", () => {
	test("body is cut fence-safe, the tail stays", () => {
		const body = `\`\`\`\n${"abcdefghij\n".repeat(900)}\`\`\``;
		const text = renderOutboundText({
			text: "t",
			body,
			fields: [{ label: "필드", value: "값" }],
			buttons: [{ id: "ok", label: "승인" }] as never,
		});
		expect(text.length).toBeLessThanOrEqual(7000);
		expect(text).toContain("**필드**: 값");
		expect(text).toContain("선택지: 승인");
		const fences = text.split("\n").filter((line) => line.startsWith("```")).length;
		expect(fences % 2).toBe(0);
	});
});

describe("8. splitCards follows the shared fence rule", () => {
	test("a fence closed on its own line opens nothing: the card after it is a card", () => {
		const body = ["앞", "```js let a = 1;```", "```card", '{"title":"t"}', "```"].join("\n");
		expect(splitCards(body).map((s) => s.kind)).toEqual(["text", "card"]);
	});
	test("a card line indented inside nothing and a longer fence quoting a card stay as before", () => {
		const body = ["````", "```card", "{}", "```", "````"].join("\n");
		expect(splitCards(body).map((s) => s.kind)).toEqual(["text"]);
	});
});

describe("9. repeated Reconnect / Invalid Session does not storm", () => {
	for (const [name, frame] of [
		["op 7", { op: 7, d: null }],
		["op 9 d:true", { op: 9, d: true }],
	] as const) {
		test(`${name} frames after every session are throttled`, async () => {
			const srv = startServer();
			server = srv;
			srv.onSession = (index) => {
				const conn = srv.conns[index];
				if (conn === undefined) return;
				const resume = conn.received.some((f) => f.op === 6);
				if (!resume) conn.ws.send(JSON.stringify(ready(srv.port)));
				// A replaying proxy: every session is answered with the frame again, up to a cap that ends a storm.
				if (srv.conns.length < 20) conn.ws.send(JSON.stringify(frame));
			};
			const timers = new ManualTimers();
			const gw = new DiscordGateway({
				token: TOKEN,
				url: `ws://localhost:${srv.port}/gateway`,
				handlers: noHandlers,
				timers,
				random: () => 0.25,
				backoffBaseMs: 100,
				backoffMaxMs: 1_000,
			});
			gateway = gw;
			void gw.start().catch(() => {});
			await srv.until(() => srv.conns[1]?.closed === true);
			// The throttled reconnect wait: the backoff base (100) or the 1-5 s invalid-session wait (random 0.25 -> 2000).
			await srv.until(
				() => [...timers.pending.values()].some((ms) => ms === 100 || ms === 2_000) || srv.conns.length >= 20,
			);
			expect(srv.conns.length).toBeLessThan(20);
			expect(srv.conns).toHaveLength(2);
			if (name === "op 9 d:true") {
				const [wait] = [...timers.pending.values()];
				expect(wait).toBeGreaterThanOrEqual(1_000);
				expect(wait).toBeLessThanOrEqual(5_000);
			}
		});
	}
});

describe("10. a million-row table renders", () => {
	test("tableToAscii does not overflow the argument stack", () => {
		const rows = Array.from({ length: 1_000_000 }, () => ["x"]);
		expect(() => tableToAscii({ headers: ["h"], rows })).not.toThrow();
	});
});
