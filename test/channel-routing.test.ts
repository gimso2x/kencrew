import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AdapterDeps, ChannelAdapter, ChannelBinding } from "../src/channel/adapter";
import type { ChannelPort, MessageRef, OutboundMessage, PostTarget } from "../src/channel/port";
import type { IngestOutcome } from "../src/channel/types";
import { Daemon } from "../src/daemon/daemon";
import type { EditMessageArgs } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { approvalActionId } from "../src/safety/approval";
import {
	discordBinding,
	GUILD,
	hasButtons,
	makeHome,
	OWNER,
	OWNER_DM,
	ownerMessage,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import type { FakeDiscordCall } from "./helpers/discord-fake-transport";

const ESCALATION = "300000000000000002";
const DM = OWNER_DM;
const ORIGIN = `discord/dm/${DM}`;
const OTHER_USER = "100000000000000999";
const clock = { now: () => Date.now() };

type Post = Extract<FakeDiscordCall, { method: "createMessage" }>;
type Update = Extract<FakeDiscordCall, { method: "editMessage" }>;

/** Resolves `shown` when approval buttons go up on a card and `finalized` when a card edit removes them. */
class CardTransport extends WaitingDiscordTransport {
	shown = Promise.withResolvers<{ channel: string; ts: string }>();
	finalized = Promise.withResolvers<Update>();

	override async editMessage(args: EditMessageArgs): Promise<void> {
		await super.editMessage(args);
		if (hasButtons(args.components)) this.shown.resolve({ channel: args.channelId, ts: args.messageId });
		else if ((args.content ?? "").startsWith("🔐")) this.finalized.resolve({ method: "editMessage", ...args });
	}
}

let home: TestHome;
let daemon: Daemon;
let transport: CardTransport;
let logs: string[];

/** The test home's config with `channels.discord` extended (a server channel needs a mention here, like in production). */
function discordConfig(overrides: { escalationChannelId?: string } = {}) {
	const discord = home.config.channels.discord;
	if (discord === undefined) throw new Error("no discord config");
	return { ...home.config, channels: { discord: { ...discord, requireMention: true, ...overrides } } };
}

async function boot(overrides: { escalationChannelId?: string } = {}): Promise<void> {
	transport = new CardTransport();
	transport.setChannel({ id: DM, type: 1 });
	transport.setChannel({ id: ESCALATION, type: 0, guildId: GUILD });
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: discordConfig(overrides),
		channels: [discordBinding(transport)],
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
}

/** An owner DM message first, so the origin has a current thread (`<dm>:<message id>`) the approval request comes from. */
async function seedThread(): Promise<string> {
	await transport.emitMessage(ownerMessage("700000000000000001", "배포 준비해줘"));
	await transport.waitForPosts((text) => text.includes("ECHO 배포 준비해줘"));
	return "700000000000000001";
}

function ask(summary = "force push main"): Promise<string> {
	const tool = daemon.hostToolsFor(ORIGIN).find((t) => t.name === "ompbot_request_approval");
	if (!tool) throw new Error("tool missing");
	return tool.execute({ summary }, { signal: new AbortController().signal });
}

function cardPost(channel: string): Post {
	const post = transport
		.posts()
		.find(
			(p) =>
				p.channelId === channel && (p.content ?? "").startsWith("🔐 승인 요청") && p.messageReference === undefined,
		);
	if (!post) throw new Error(`no card in ${channel}`);
	return post;
}

/** A message in a card's thread (the thread id is the card's message id; the thread sits in the escalation channel). */
function threadReply(thread: string, id: string, content: string, user = OWNER) {
	transport.setChannel({ id: thread, type: 11, parentId: ESCALATION, guildId: GUILD });
	return transport.emitMessage({
		id,
		channel_id: thread,
		guild_id: GUILD,
		author: { id: user, username: "u" },
		content,
		type: 0,
	});
}

/** A click on `customId` of the card `ts` in `channel`. */
function click(customId: string, channel: string, ts: string) {
	return transport.emitInteraction({
		id: "800000000000000001",
		application_id: "600000000000000000",
		type: 3,
		token: "token-1",
		channel_id: channel,
		user: { id: OWNER },
		data: { custom_id: customId, component_type: 2 },
		message: { id: ts, channel_id: channel },
	});
}

beforeEach(() => {
	home = makeHome("ompbot-routing-");
	logs = [];
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

describe("escalation channel", () => {
	test("the card goes to the escalation channel with the owner mention and a link; its mirror with the same buttons lands in the asking thread", async () => {
		await boot({ escalationChannelId: ESCALATION });
		const thread = await seedThread();
		const result = ask("force push main\n자세히");
		const { channel, ts } = await transport.shown.promise;
		expect(channel).toBe(ESCALATION);
		const card = cardPost(ESCALATION);
		expect((card.content ?? "").split("\n")[0]).toBe(`🔐 승인 요청 <@${OWNER}>`);
		expect(card.content).toContain(`요청 위치: DM · [스레드 보기](https://discord.com/channels/@me/${DM}/${thread})`);
		// Exactly one mirror card in the requesting thread, its buttons carrying the escalation card's key; no pointer.
		await transport.waitForPosts((text) => text.startsWith("🔐 승인 요청\nforce push main"));
		const mirrors = transport.posts((text) => text.startsWith("🔐 승인 요청\nforce push main"));
		expect(mirrors).toHaveLength(1);
		expect(mirrors[0]).toMatchObject({ channelId: DM, messageReference: { messageId: thread } });
		expect(JSON.stringify(mirrors[0]?.components)).toContain(approvalActionId("approve", ESCALATION, ts));
		expect(JSON.stringify(mirrors[0])).toContain(
			`[#escalation에서 보기](https://discord.com/channels/${GUILD}/${ESCALATION}/${ts})`,
		);
		expect(transport.posts((text) => text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
		// The ledger row maps the card back to the asking conversation and thread.
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)).toMatchObject({
			status: "pending",
			originKey: ORIGIN,
			originThreadRef: `${DM}:${thread}`,
		});
		await click(approvalActionId("approve", ESCALATION, ts), ESCALATION, ts);
		expect(await result).toBe("approved");
	});

	test("the permalink failing falls back to the channel label", async () => {
		await boot({ escalationChannelId: ESCALATION });
		// No owner message through the adapter: the first channel lookups are the request's and the card's permalinks.
		daemon.store.ensureOrigin(ORIGIN, "sess/discord-dm");
		daemon.store.recordInbound({
			originKey: ORIGIN,
			platformMessageId: `${DM}:700000000000000001`,
			textRef: "푸시해",
			threadRef: `${DM}:700000000000000001`,
		});
		transport.failNext.getChannel = [new Error("boom"), new Error("boom")];
		void ask();
		await transport.shown.promise;
		await transport.waitForPosts((text) => text.startsWith("🔐 승인 요청\nforce push main"));
		expect((cardPost(ESCALATION).content ?? "").endsWith("요청 위치: DM")).toBe(true);
		const mirror = transport.posts((text) => text.startsWith("🔐 승인 요청\nforce push main"))[0];
		expect(JSON.stringify(mirror)).toContain(`정본 카드: <#${ESCALATION}>`);
	});

	test("a pending card's thread reply settles it as replied: the tool returns the text, the card says so, no session starts", async () => {
		await boot({ escalationChannelId: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		// Not the owner: ignored, the request stays pending.
		await threadReply(ts, "700000000000000101", "승인!", OTHER_USER);
		expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");
		// No mention in a channel that needs one: a card-thread reply still counts as addressed.
		await threadReply(ts, "700000000000000102", "네, 그 브랜치만 진행하세요");
		expect(await result).toBe("replied: 네, 그 브랜치만 진행하세요");
		const final = await transport.finalized.promise;
		expect(hasButtons(final.components)).toBe(false);
		expect(final.content).toContain("💬 답장으로 처리됨: 네, 그 브랜치만 진행하세요");
		expect(JSON.stringify(final.embeds)).toContain("💬 답장으로 처리됨: 네, 그 브랜치만 진행하세요");
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)).toMatchObject({
			status: "replied",
			replyTs: "700000000000000102",
			replyText: "네, 그 브랜치만 진행하세요",
		});
		// Consumed: no inbound row, no thread session in the escalation channel.
		expect(daemon.store.getInbound(`${ESCALATION}:700000000000000102`)).toBeUndefined();
		expect(daemon.store.hasInboundThread(`${ESCALATION}:${ts}`)).toBe(false);
		// A backfill replay of the same reply is a no-op duplicate.
		await threadReply(ts, "700000000000000102", "네, 그 브랜치만 진행하세요");
		expect(logs.filter((line) => line.includes("event=inbound_duplicate"))).toHaveLength(1);
		expect(daemon.store.getInbound(`${ESCALATION}:700000000000000102`)).toBeUndefined();
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)?.status).toBe("replied");
	});

	test("a reply in an already-settled card's thread reaches the asking session, answered inside the card thread", async () => {
		await boot({ escalationChannelId: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		await click(approvalActionId("deny", ESCALATION, ts), ESCALATION, ts);
		expect(await result).toBe("denied");
		await threadReply(ts, "700000000000000201", "그럼 다음에 하자");
		const row = daemon.store.getInbound(`${ESCALATION}:700000000000000201`);
		expect(row).toMatchObject({ originKey: ORIGIN, threadRef: `${ESCALATION}:${ts}` });
		await transport.waitForPosts((text) => text.includes("ECHO 그럼 다음에 하자"));
		const answer = transport.posts((text) => text.includes("ECHO 그럼 다음에 하자"))[0];
		expect(answer).toMatchObject({ channelId: ts });
		// A second reply keeps flowing to the same session instead of starting a thread session in the channel.
		await threadReply(ts, "700000000000000202", "고마워");
		expect(daemon.store.getInbound(`${ESCALATION}:700000000000000202`)?.originKey).toBe(ORIGIN);
	});

	// T-20261111-03: an inject may not answer a card (doc/plans/inject-card-guard-turn-undo-wiring.md §A). The marker
	// still goes up as a reply in the card's thread; only the owner's own reply settles the card.
	test("inject --thread into a card's thread posts the marker there but cannot answer the card", async () => {
		await boot({ escalationChannelId: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		transport.setChannel({ id: ts, type: 11, parentId: ESCALATION, guildId: GUILD });
		await expect(
			daemon.inject({ origin: `discord/ch/${ESCALATION}`, asOwner: true, text: "진행해", thread: ts }),
		).rejects.toThrow("approval/choice card");
		expect(transport.posts((text) => text.startsWith("🧪 inject ") && text.endsWith("\n> 진행해"))[0]).toMatchObject({
			channelId: ts,
		});
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)?.status).toBe("pending");
		await threadReply(ts, "700000000000000302", "진행해");
		expect(await result).toBe("replied: 진행해");
	});
});

describe("approval cards without an escalation channel", () => {
	test("the card stays in the asking conversation, no pointer, and a reply to it still settles it", async () => {
		await boot();
		await seedThread();
		const result = ask();
		const { channel, ts } = await transport.shown.promise;
		expect(channel).toBe(DM);
		expect(cardPost(DM).content).toBe("🔐 승인 요청\nforce push main");
		expect(transport.posts((text) => text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
		expect(daemon.store.getApproval(`${DM}:${ts}`)?.originKey).toBe(ORIGIN);
		await transport.emitMessage(
			ownerMessage("700000000000000301", "좋아요 진행", {
				type: 19,
				message_reference: { message_id: ts, channel_id: DM },
			}),
		);
		expect(await result).toBe("replied: 좋아요 진행");
		expect(daemon.store.getInbound(`${DM}:700000000000000301`)).toBeUndefined();
	});
});

const TEAMS_DM = "t0123456789abcdef";
const TEAMS_ORIGIN = `teams/dm/${TEAMS_DM}`;

/** A Teams port: records posts and wakes a waiter on each one. */
class SecondPort implements ChannelPort {
	readonly platform = "teams" as const;
	readonly posts: Array<{ target: PostTarget; msg: OutboundMessage }> = [];
	#waiters: Array<() => void> = [];

	async post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef> {
		this.posts.push({ target, msg });
		for (const waiter of this.#waiters.splice(0)) waiter();
		return { platform: "teams", conversationId: target.conversationId, messageId: `9000${this.posts.length}` };
	}
	async edit(): Promise<void> {}
	async react(): Promise<void> {}
	async uploadFile(): Promise<{ fileId: string }> {
		return { fileId: "F1" };
	}
	async permalink(): Promise<string | undefined> {
		return undefined;
	}
	mentionUser(userId: string): string {
		return `<@${userId}>`;
	}

	/** Resolves once a post satisfying `match` arrived (bounded). */
	waitForPost(match: (text: string) => boolean, timeoutMs = 10_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!this.posts.some((p) => match(p.msg.text))) return void this.#waiters.push(check);
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => reject(new Error("timed out waiting for a second-platform post")), timeoutMs);
		check();
		return promise;
	}
}

/** A Teams adapter: its pump takes what the daemon's delivery source hands it and confirms it. */
class SecondAdapter implements ChannelAdapter {
	readonly platform = "teams" as const;
	readonly botUserId = "999999999999999999";
	readonly pumped: string[] = [];
	constructor(private readonly deps: AdapterDeps) {}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async pumpDeliveries(): Promise<number> {
		const items = await this.deps.deliveries.claimDue();
		for (const item of items) {
			this.pumped.push(item.body);
			await this.deps.deliveries.confirm(item.deliveryId);
		}
		return items.length;
	}
	async tick(): Promise<void> {}
	async setStalled(): Promise<void> {}
	async setProgress(): Promise<void> {}
	async postNotice(): Promise<void> {}
	async ingestOwner(): Promise<IngestOutcome> {
		return "dropped";
	}
	setChannelPolicy(): void {}
	connectionState(): undefined {
		return undefined;
	}
	recover(): void {}
}

describe("a Teams platform beside Discord", () => {
	let port: SecondPort;
	let adapter: SecondAdapter | undefined;

	async function bootTwo(overrides: { escalationChannelId?: string } = {}): Promise<void> {
		transport = new CardTransport();
		transport.setChannel({ id: DM, type: 1 });
		port = new SecondPort();
		const second: ChannelBinding = {
			port,
			createAdapter: (deps) => {
				adapter = new SecondAdapter(deps);
				return adapter;
			},
		};
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: discordConfig(overrides),
			channels: [discordBinding(transport), second],
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
	}

	test("each delivery goes through the adapter of its thread ref's platform only", async () => {
		await bootTwo();
		daemon.store.recordInterim({
			originKey: TEAMS_ORIGIN,
			opRef: "op-t",
			threadRef: `${TEAMS_DM}:-`,
			index: 0,
			body: "팀즈로 갈 답",
		});
		daemon.store.recordInterim({
			originKey: ORIGIN,
			opRef: "op-d",
			threadRef: `${DM}:-`,
			index: 0,
			body: "디스코드로 갈 답",
		});
		await transport.waitForPosts((text) => text.includes("디스코드로 갈 답"));
		await daemon.pump();
		expect(adapter?.pumped).toEqual(["팀즈로 갈 답"]);
		expect(transport.posts((text) => text.includes("팀즈로 갈 답"))).toHaveLength(0);
		expect(transport.posts((text) => text.includes("디스코드로 갈 답"))).toHaveLength(1);
		expect(daemon.store.listDeliveries().map((row) => [row.body, row.state])).toEqual([
			["팀즈로 갈 답", "confirmed"],
			["디스코드로 갈 답", "confirmed"],
		]);
	});

	test("a Teams DM origin gets the base set only (no upload, lane or monitor tools); the Discord origin keeps its own set", async () => {
		await bootTwo();
		const names = daemon.hostToolsFor(TEAMS_ORIGIN).map((t) => t.name);
		expect(names).toContain("ompbot_request_approval");
		for (const absent of [
			"discord_send_file",
			"ompbot_work_start",
			"ompbot_lane_progress",
			"ompbot_claim_done",
			"ompbot_monitor_add",
		]) {
			expect(names).not.toContain(absent);
		}
		const discordNames = daemon.hostToolsFor(ORIGIN).map((t) => t.name);
		expect(discordNames).toContain("discord_send_file");
		for (const present of ["ompbot_monitor_add", "ompbot_monitor_list", "ompbot_monitor_remove"]) {
			expect(discordNames).toContain(present);
		}
	});

	test("a Teams conversation's approval card goes to that conversation even with an escalation channel", async () => {
		await bootTwo({ escalationChannelId: ESCALATION });
		const tool = daemon.hostToolsFor(TEAMS_ORIGIN).find((t) => t.name === "ompbot_request_approval");
		if (!tool) throw new Error("tool missing");
		const abort = new AbortController();
		const result = tool.execute({ summary: "force push main" }, { signal: abort.signal });
		await port.waitForPost((text) => text.startsWith("🔐 승인 요청"));
		expect(port.posts[0]?.target).toEqual({ conversationId: TEAMS_DM });
		expect(port.posts[0]?.msg.text).toBe("🔐 승인 요청\nforce push main");
		abort.abort();
		await result.catch(() => undefined);
		expect(transport.posts((text) => text.includes("승인 요청"))).toHaveLength(0);
	});
});
