// Approval cards in the asking thread (doc/plans/slack-approval-in-thread.md F1, here on Discord): the escalation card stays the
// canonical one, a mirror card with the same buttons lands in the asking thread, one decision settles both, and a
// timed-out card offers `다시 요청`. Broker tests drive timeouts with manual timers; daemon tests click through the
// Discord adapter. Waits are on transport calls and log lines (bounded), never sleeps.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { DiscordChannel } from "../src/discord/channel";
import {
	type CreateMessageArgs,
	DiscordCallError,
	type DiscordInteraction,
	type EditMessageArgs,
} from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import {
	ApprovalBroker,
	type ApprovalResult,
	type ApprovalStore,
	type ApprovalTimers,
	approvalActionId,
	parseApprovalActionId,
} from "../src/safety/approval";
import { openStore, type Store } from "../src/store/db";
import {
	CHANNEL,
	discordBinding,
	GUILD,
	hasButtons,
	makeHome,
	OWNER,
	OWNER_DM,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import type { FakeDiscordCall } from "./helpers/discord-fake-transport";

const ESC = "300000000000000010";
const REQ = CHANNEL;
const THREAD = "700000000000000077";
const WAIT_MS = 4_000;
const ROW_1 = "900000000000000101";
const ROW_2 = "900000000000000102";
const ROW_3 = "900000000000000103";
const ROW_4 = "900000000000000104";
const MIRROR_ID = "900000000000000108";

type Post = Extract<FakeDiscordCall, { method: "createMessage" }>;
type Update = Extract<FakeDiscordCall, { method: "editMessage" }>;

/** The id a post is answered under: the message it replies to (a thread in a server channel), if any. */
const threadOf = (post: Post): string | undefined => post.messageReference?.messageId;
const textOf = (post: Post | Update | undefined): string => post?.content ?? "";

/** Custom ids of the buttons in a message's component rows (`[]` without buttons). */
function actionIds(components: readonly unknown[] | undefined): string[] {
	return (
		(components as ReadonlyArray<{ components: Array<{ custom_id: string }> }> | undefined)?.flatMap((row) =>
			row.components.map((button) => button.custom_id),
		) ?? []
	);
}

/** The grey note line (the `-# ` last line of the embed text) of a card; `""` when there is none. */
function contextText(embeds: readonly unknown[] | undefined): string {
	const description = (embeds?.[0] as { description?: string } | undefined)?.description ?? "";
	const last = description.split("\n").at(-1) ?? "";
	return last.startsWith("-# ") ? last : "";
}

/** Fake transport whose calls wake bounded waiters; `failMirror` makes the mirror card post (thread + buttons) fail. */
class WatchTransport extends WaitingDiscordTransport {
	failMirror = false;
	readonly #waiters = new Set<() => void>();

	override async createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		if (this.failMirror && args.messageReference !== undefined && hasButtons(args.components)) {
			throw new DiscordCallError("definitive", "discord_http_403:50001 Missing Access", 403, 50001);
		}
		const result = await super.createMessage(args);
		this.#wake();
		return result;
	}

	override async editMessage(args: EditMessageArgs): Promise<void> {
		await super.editMessage(args);
		this.#wake();
	}

	#wake(): void {
		for (const waiter of [...this.#waiters]) waiter();
	}

	edits(channel: string, messageId: string): Update[] {
		return this.calls.filter(
			(call): call is Update =>
				call.method === "editMessage" && call.channelId === channel && call.messageId === messageId,
		);
	}

	until(done: () => boolean, what: string): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!done()) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`timed out waiting for ${what}`));
		}, WAIT_MS);
		this.#waiters.add(check);
		check();
		return promise;
	}
}

class ManualTimers implements ApprovalTimers {
	readonly callbacks = new Map<number, () => void>();
	#next = 1;
	set(fn: () => void): unknown {
		const id = this.#next++;
		this.callbacks.set(id, fn);
		return id;
	}
	clear(handle: unknown): void {
		this.callbacks.delete(handle as number);
	}
	fireAll(): void {
		for (const fn of [...this.callbacks.values()]) fn();
	}
}

describe("broker: mirror card in the asking thread", () => {
	let dir: string;
	let store: Store;
	let transport: WatchTransport;
	let timers: ManualTimers;
	let lines: string[];
	let logWaiters: Set<() => void>;

	/** Resolves once a log line matches (bounded): the broker logs `approval_mirrored` after recording the mirror. */
	function untilLog(match: RegExp): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!lines.some((line) => match.test(line))) return;
			clearTimeout(timer);
			logWaiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			logWaiters.delete(check);
			reject(new Error(`timed out waiting for ${match}`));
		}, WAIT_MS);
		logWaiters.add(check);
		check();
		return promise;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-approval-thread-"));
		store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock: { now: () => 1_000 }, redact });
		transport = new WatchTransport();
		transport.setChannel({ id: ESC, type: 0, guildId: GUILD });
		transport.setChannel({ id: REQ, type: 0, guildId: GUILD });
		timers = new ManualTimers();
		lines = [];
		logWaiters = new Set();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	/** `null`: no escalation channel configured. */
	function broker(escalationChannel: string | null = ESC): ApprovalBroker {
		return new ApprovalBroker({
			timezone: "Asia/Seoul",
			channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
			ownerUserId: OWNER,
			escalationChannel: escalationChannel === null ? undefined : { discord: escalationChannel },
			log: createLogger({
				sink: (line) => {
					lines.push(line);
					for (const waiter of [...logWaiters]) waiter();
				},
				clock: { now: () => 0 },
				redact,
			}),
			store: store as unknown as ApprovalStore,
			clock: { now: () => 2_000 },
			timers,
		});
	}

	const origin = { originKey: `discord/ch/${REQ}/t/${THREAD}`, channel: REQ, threadTs: THREAD };
	const detail = { action: "git push --force origin main", impact: "main 이력이 바뀜" };
	const canonicalPost = () => transport.posts().find((p) => p.channelId === ESC && threadOf(p) === undefined);
	const mirrorPost = () => transport.posts().find((p) => p.channelId === REQ && threadOf(p) === THREAD);

	/** Asks with an origin thread and waits until both cards are up; returns the canonical and mirror ts. */
	async function askInThread(b: ApprovalBroker, signal?: AbortSignal) {
		const result = b.ask(REQ, "force push main\n자세히", { origin, detail, signal });
		await untilLog(/event=approval_mirror(ed|_failed) /);
		const canonical = canonicalPost();
		if (canonical === undefined) throw new Error("no canonical card");
		return { result, canonicalTs: canonical.id, mirrorTs: mirrorPost()?.id };
	}

	test("AC-1: the mirror card lands in the asking thread with the same title and fields, buttons carrying the canonical key, no owner mention; the row records mirror_ref", async () => {
		const b = broker();
		const { result, canonicalTs, mirrorTs } = await askInThread(b);
		const canonical = canonicalPost() as Post;
		const mirror = mirrorPost() as Post;
		expect(textOf(canonical).split("\n")[0]).toBe(`🔐 승인 요청 <@${OWNER}>`);
		expect(JSON.stringify(transport.edits(ESC, canonicalTs).at(-1)?.embeds)).toContain(`<@${OWNER}>`);
		expect(textOf(mirror)).not.toContain(`<@${OWNER}>`);
		expect(JSON.stringify(mirror.embeds)).not.toContain(`<@${OWNER}>`);
		expect(JSON.stringify(mirror.embeds)).not.toContain("요청 위치");
		// Same header and field section as the canonical card.
		const canonicalEmbed = transport.edits(ESC, canonicalTs).at(-1)?.embeds?.[0] as {
			title?: string;
			fields?: unknown;
		};
		const mirrorEmbed = mirror.embeds?.[0] as { title?: string; fields?: unknown };
		expect(mirrorEmbed.title).toEqual(canonicalEmbed.title);
		expect(mirrorEmbed.fields).toEqual(canonicalEmbed.fields);
		expect(actionIds(mirror.components)).toEqual([
			approvalActionId("approve", ESC, canonicalTs),
			approvalActionId("deny", ESC, canonicalTs),
		]);
		expect(contextText(mirror.embeds)).toContain("버튼으로 답해 주세요(이 스레드의 글 답장은 승인으로 세지 않음)");
		expect(contextText(mirror.embeds)).toContain(`https://discord.com/channels/${GUILD}/${ESC}/${canonicalTs}`);
		expect(b.handleAction({ actionId: approvalActionId("approve", ESC, canonicalTs), userId: OWNER })).toBe(true);
		expect(await result).toBe("approved");
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.mirrorRef).toBe(`${REQ}:${mirrorTs}`);
		// No pointer line once the mirror is up.
		expect(transport.posts((text) => text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
	});

	test("AC-1: a failed mirror post falls back to the pointer line; the row keeps no mirror_ref", async () => {
		transport.failMirror = true;
		const b = broker();
		const { result, canonicalTs } = await askInThread(b);
		await transport.until(() => transport.posts((text) => text.startsWith("🔐 승인 요청을")).length > 0, "pointer");
		const pointers = transport.posts((text) => text.startsWith("🔐 승인 요청을"));
		expect(pointers).toHaveLength(1);
		expect(pointers[0]).toMatchObject({ channelId: REQ, messageReference: { messageId: THREAD } });
		expect(textOf(pointers[0])).toStartWith(`🔐 승인 요청을 <#${ESC}>에 올렸습니다 — force push main`);
		expect(hasButtons(pointers[0]?.components)).toBe(false);
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.mirrorRef).toBeNull();
		b.handleAction({ actionId: approvalActionId("deny", ESC, canonicalTs), userId: OWNER });
		expect(await result).toBe("denied");
	});

	test("AC-2: no origin, an origin without a thread, no escalation channel or the escalation channel itself: one card, no mirror", async () => {
		const settleAll = async (pending: Promise<ApprovalResult>) => {
			await transport.until(
				() => transport.calls.some((c) => c.method === "editMessage" && hasButtons(c.components)),
				"buttons",
			);
			timers.fireAll();
			await pending;
		};
		// No origin: the card stays in the request channel, nothing else is posted.
		await settleAll(broker().ask(REQ, "a"));
		expect(transport.posts().map((p) => [p.channelId, threadOf(p)])).toEqual([[REQ, undefined]]);

		// An origin without a thread (channel top level): the escalation card + today's pointer line, no mirror.
		transport.calls.length = 0;
		const top = broker();
		const pendingTop = top.ask(REQ, "b", { origin: { originKey: `discord/ch/${REQ}`, channel: REQ } });
		await transport.until(() => transport.posts((text) => text.startsWith("🔐 승인 요청을")).length > 0, "pointer");
		expect(transport.posts().map((p) => [p.channelId, threadOf(p), hasButtons(p.components)])).toEqual([
			[ESC, undefined, false],
			[REQ, undefined, false],
		]);
		timers.fireAll();
		await pendingTop;

		// No escalation channel, and an escalation channel equal to the request channel: one card in the thread's channel.
		for (const escalation of [null, REQ]) {
			transport.calls.length = 0;
			const b = broker(escalation);
			await settleAll(b.ask(REQ, "c", { origin }));
			expect(transport.posts().map((p) => p.channelId)).toEqual([REQ]);
			expect(transport.posts((text) => text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
		}
	});

	test("AC-3: a mirror click and a canonical click settle once; the second click only logs", async () => {
		const b = broker();
		const { result, canonicalTs } = await askInThread(b);
		const approve = approvalActionId("approve", ESC, canonicalTs);
		// The mirror's button carries the canonical key, so a mirror click is this very call.
		expect(actionIds(mirrorPost()?.components)[0]).toBe(approve);
		expect(b.handleAction({ actionId: approve, userId: OWNER })).toBe(true);
		expect(b.handleAction({ actionId: approve, userId: OWNER })).toBe(false);
		expect(await result).toBe("approved");
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.status).toBe("approved");
		expect(lines.filter((l) => l.includes("event=approval_click "))).toHaveLength(1);
		expect(lines.some((l) => l.includes("reason=already_decided"))).toBe(true);
	});

	test("AC-3: two clicks at once (mirror + canonical) decide the ledger once", async () => {
		const b = broker();
		const { result, canonicalTs } = await askInThread(b);
		const approve = approvalActionId("approve", ESC, canonicalTs);
		const deny = approvalActionId("deny", ESC, canonicalTs);
		const clicks = await Promise.all([
			Promise.resolve().then(() => b.handleAction({ actionId: approve, userId: OWNER })),
			Promise.resolve().then(() => b.handleAction({ actionId: deny, userId: OWNER })),
		]);
		expect(clicks).toEqual([true, false]);
		expect(await result).toBe("approved");
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.status).toBe("approved");
		expect(lines.filter((l) => l.includes("event=approval_click "))).toHaveLength(1);
		expect(
			lines.filter((l) => l.includes("reason=already_decided") || l.includes("reason=ledger_not_pending")),
		).toHaveLength(1);
	});

	for (const [name, act, line] of [
		[
			"approve",
			(b: ApprovalBroker, key: string) =>
				b.handleAction({ actionId: approvalActionId("approve", ESC, key.split(":")[1] ?? ""), userId: OWNER }),
			"✅ 승인됨",
		],
		[
			"deny",
			(b: ApprovalBroker, key: string) =>
				b.handleAction({ actionId: approvalActionId("deny", ESC, key.split(":")[1] ?? ""), userId: OWNER }),
			"⛔ 거부됨",
		],
		[
			"replied",
			(b: ApprovalBroker, key: string) => b.handleCardReply({ approvalId: key, ts: "9.9", text: "그 브랜치만" }),
			"💬 답장으로 처리됨: 그 브랜치만",
		],
	] as const) {
		test(`AC-4/AC-5: ${name} redraws canonical and mirror with the same result line, no buttons`, async () => {
			const b = broker();
			const { result, canonicalTs, mirrorTs } = await askInThread(b);
			act(b, `${ESC}:${canonicalTs}`);
			await result;
			const canonical = transport.edits(ESC, canonicalTs).at(-1);
			const mirror = transport.edits(REQ, mirrorTs ?? "").at(-1);
			expect(contextText(canonical?.embeds)).toContain(line);
			expect(contextText(mirror?.embeds)).toBe(contextText(canonical?.embeds));
			expect(actionIds(canonical?.components)).toEqual([]);
			expect(actionIds(mirror?.components)).toEqual([]);
		});
	}

	test("AC-4/AC-5: an aborted wait redraws both cards with the abort line and no button", async () => {
		const controller = new AbortController();
		const b = broker();
		const { result, canonicalTs, mirrorTs } = await askInThread(b, controller.signal);
		controller.abort();
		expect(await result).toBe("denied");
		const canonical = transport.edits(ESC, canonicalTs).at(-1);
		const mirror = transport.edits(REQ, mirrorTs ?? "").at(-1);
		expect(contextText(canonical?.embeds)).toContain("기다리던 작업이 중단돼 만료됨");
		expect(contextText(mirror?.embeds)).toBe(contextText(canonical?.embeds));
		expect(actionIds(canonical?.components)).toEqual([]);
		expect(actionIds(mirror?.components)).toEqual([]);
	});

	test("AC-5: a timed-out card keeps one `다시 요청` button on both cards, carrying the canonical key", async () => {
		const b = broker();
		const { result, canonicalTs, mirrorTs } = await askInThread(b);
		timers.fireAll();
		expect(await result).toBe("timeout");
		const retry = `ompbot:approval:retry:${ESC}:${canonicalTs}`;
		const canonical = transport.edits(ESC, canonicalTs).at(-1);
		const mirror = transport.edits(REQ, mirrorTs ?? "").at(-1);
		expect(actionIds(canonical?.components)).toEqual([retry]);
		expect(actionIds(mirror?.components)).toEqual([retry]);
		expect(contextText(mirror?.embeds)).toBe(contextText(canonical?.embeds));
		expect(contextText(canonical?.embeds)).toContain("⌛ 시간 초과: 거부로 처리됨");
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.status).toBe("expired");
		// The broker leaves the retry click to the daemon.
		expect(parseApprovalActionId(retry)).toEqual({ decision: "retry", channel: ESC, ts: canonicalTs });
		expect(b.handleAction({ actionId: retry, userId: OWNER })).toBe(false);
	});

	test("AC-5: a timed-out card with no asking thread gets no retry button", async () => {
		const b = broker(null);
		const pending = b.ask(REQ, "d");
		await transport.until(
			() => transport.calls.some((c) => c.method === "editMessage" && hasButtons(c.components)),
			"buttons",
		);
		timers.fireAll();
		expect(await pending).toBe("timeout");
		const card = transport.posts()[0] as Post;
		expect(actionIds(transport.edits(REQ, card.id).at(-1)?.components)).toEqual([]);
	});

	test("AC-4/AC-5: a restart expiry redraws the mirror of rows that recorded one; old rows only their card; retry only with an asking thread", async () => {
		const row = (id: string, summary: string, threadRef?: string) =>
			store.createApproval({
				approvalId: `${ESC}:${id}`,
				channel: ESC,
				messageTs: id,
				summary,
				createdAt: 1_000,
				expiresAt: 999_000,
				...(threadRef === undefined ? {} : { originKey: origin.originKey, originThreadRef: threadRef }),
			});
		row(ROW_1, "with mirror", `${REQ}:${THREAD}`);
		expect(store.setApprovalMirrorRef(`${ESC}:${ROW_1}`, `${REQ}:${MIRROR_ID}`)).toBe(true);
		row(ROW_2, "old row", `${REQ}:${THREAD}`);
		row(ROW_3, "no thread");
		row(ROW_4, "❓ 질문 카드", `${REQ}:${THREAD}`);
		expect(await broker().expireStale(false)).toBe(4);
		const retryOf = (ts: string) => [`ompbot:approval:retry:${ESC}:${ts}`];
		expect(actionIds(transport.edits(ESC, ROW_1).at(-1)?.components)).toEqual(retryOf(ROW_1));
		expect(actionIds(transport.edits(REQ, MIRROR_ID).at(-1)?.components)).toEqual(retryOf(ROW_1));
		expect(transport.edits(REQ, MIRROR_ID).at(-1)?.content).toBe(transport.edits(ESC, ROW_1).at(-1)?.content);
		expect(actionIds(transport.edits(ESC, ROW_2).at(-1)?.components)).toEqual(retryOf(ROW_2));
		expect(actionIds(transport.edits(ESC, ROW_3).at(-1)?.components)).toEqual([]);
		expect(actionIds(transport.edits(ESC, ROW_4).at(-1)?.components)).toEqual([]);
		// Only the first row has a mirror: five edits in all, one per card.
		expect(transport.calls.filter((c) => c.method === "editMessage")).toHaveLength(5);
		// mirror_ref is written only on a pending row.
		expect(store.setApprovalMirrorRef(`${ESC}:${ROW_2}`, `${REQ}:900000000000000199`)).toBe(false);
	});
});

describe("daemon: 다시 요청 on a timed-out approval card", () => {
	const DM = OWNER_DM;
	const ORIGIN = `discord/dm/${DM}`;
	const ASK_THREAD = "700000000000000001";
	const MISSING_CARD = "900000000000009999";
	let home: TestHome;
	let daemon: Daemon;
	let transport: WaitingDiscordTransport;
	let logs: string[];
	let interactionSeq = 0n;

	beforeEach(async () => {
		home = makeHome("ompbot-approval-retry-");
		logs = [];
		transport = new WaitingDiscordTransport();
		transport.setChannel({ id: ESC, type: 0, guildId: GUILD });
		transport.setChannel({ id: DM, type: 1 });
		const sessions = new FakeSessionStore();
		const discord = home.config.channels.discord;
		if (discord === undefined) throw new Error("no discord config");
		daemon = new Daemon({
			config: {
				...home.config,
				channels: { ...home.config.channels, discord: { ...discord, escalationChannelId: ESC } },
			},
			channels: [discordBinding(transport)],
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => Date.now() }, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
	});

	afterEach(async () => {
		await daemon.stop();
		home.remove();
	});

	/** A settled approval row with its canonical card in the escalation channel and (optionally) a mirror in the thread. */
	async function seed(options: { mirror?: boolean; expire?: boolean; threadRef?: string } = {}) {
		const canonical = await transport.createMessage({
			channelId: ESC,
			content: `🔐 승인 요청 <@${OWNER}>\nforce push main`,
		});
		const approvalId = `${ESC}:${canonical.id}`;
		const now = Date.now();
		daemon.store.createApproval({
			approvalId,
			channel: ESC,
			messageTs: canonical.id,
			summary: "force push main\n자세히",
			createdAt: now,
			expiresAt: now + 60_000,
			originKey: ORIGIN,
			originThreadRef: options.threadRef ?? `${DM}:${ASK_THREAD}`,
		});
		let mirrorTs: string | undefined;
		if (options.mirror !== false) {
			mirrorTs = (
				await transport.createMessage({
					channelId: DM,
					messageReference: { messageId: ASK_THREAD },
					content: "🔐 승인 요청\nforce push main",
				})
			).id;
			daemon.store.setApprovalMirrorRef(approvalId, `${DM}:${mirrorTs}`);
		}
		if (options.expire !== false) daemon.store.decideApproval(approvalId, "expired", now);
		return { canonicalTs: canonical.id, mirrorTs };
	}

	function retry(canonicalTs: string, from: { channel: string; ts: string }, user = OWNER): Promise<void> {
		interactionSeq += 1n;
		const interaction: DiscordInteraction = {
			id: String(800_000_000_000_000_000n + interactionSeq),
			application_id: "600000000000000000",
			type: 3,
			token: `token-${interactionSeq}`,
			channel_id: from.channel,
			user: { id: user },
			data: { custom_id: `ompbot:approval:retry:${ESC}:${canonicalTs}`, component_type: 2 },
			message: { id: from.ts, channel_id: from.channel },
		};
		return transport.emitInteraction(interaction);
	}

	const markers = () => transport.posts((text) => text === "🔘 다시 요청 (버튼)");
	const retryInbounds = () =>
		daemon.store.listInbound().filter((row) => row.textRef.trim().startsWith("다시 요청: force push main"));
	const lastEdit = (channel: string, messageId: string): Update | undefined =>
		transport.calls
			.filter((c): c is Update => c.method === "editMessage" && c.channelId === channel && c.messageId === messageId)
			.at(-1);

	test("AC-6: a retry click puts one 🔘 marker and one owner '다시 요청: …' in the asking thread and redraws both cards without buttons", async () => {
		const { canonicalTs, mirrorTs } = await seed();
		await retry(canonicalTs, { channel: DM, ts: mirrorTs ?? "" });
		expect(markers()).toHaveLength(1);
		expect(markers()[0]).toMatchObject({ channelId: DM, messageReference: { messageId: ASK_THREAD } });
		const inbound = retryInbounds();
		expect(inbound).toHaveLength(1);
		// A Discord DM has no threads: the owner message is its own thread root, anchored on the marker it follows.
		expect(inbound[0]).toMatchObject({ originKey: ORIGIN, threadRef: `${DM}:${markers()[0]?.id}` });
		expect(inbound[0]?.textRef).toContain("ompbot_request_approval");
		for (const [channel, ts] of [
			[ESC, canonicalTs],
			[DM, mirrorTs ?? ""],
		] as const) {
			const edit = lastEdit(channel, ts);
			expect(actionIds(edit?.components)).toEqual([]);
			expect(contextText(edit?.embeds)).toMatch(/^-# ▶ 다시 요청됨 · \d\d:\d\d$/);
		}
		expect(logs.some((l) => l.includes("event=action_ignored"))).toBe(false);
	});

	test("AC-6: canonical and mirror clicked at once: one inbound, the second is a logged duplicate", async () => {
		const { canonicalTs, mirrorTs } = await seed();
		await Promise.all([
			retry(canonicalTs, { channel: ESC, ts: canonicalTs }),
			retry(canonicalTs, { channel: DM, ts: mirrorTs ?? "" }),
		]);
		expect(markers()).toHaveLength(1);
		expect(retryInbounds()).toHaveLength(1);
		expect(
			logs.filter((l) => l.includes("event=approval_retry_ignored") && l.includes("reason=duplicate")),
		).toHaveLength(1);
	});

	test("AC-6: a row that is not expired, a missing row and an asking thread that does not parse: no inbound, approval_retry_ignored, ⚠️ note", async () => {
		const pending = await seed({ expire: false, mirror: false });
		await retry(pending.canonicalTs, { channel: ESC, ts: pending.canonicalTs });
		expect(contextText(lastEdit(ESC, pending.canonicalTs)?.embeds)).toContain("⚠️ 다시 요청할 수 없음");
		const badThread = await seed({ threadRef: "not-a-thread", mirror: false });
		await retry(badThread.canonicalTs, { channel: ESC, ts: badThread.canonicalTs });
		expect(contextText(lastEdit(ESC, badThread.canonicalTs)?.embeds)).toContain("⚠️ 다시 요청할 수 없음");
		await retry(MISSING_CARD, { channel: ESC, ts: MISSING_CARD });
		expect(lastEdit(ESC, MISSING_CARD)?.content).toContain("⚠️ 다시 요청할 수 없음");
		expect(markers()).toHaveLength(0);
		expect(retryInbounds()).toHaveLength(0);
		expect(logs.filter((l) => l.includes("event=approval_retry_ignored"))).toHaveLength(3);
		expect(daemon.store.getApproval(`${ESC}:${pending.canonicalTs}`)?.status).toBe("pending");
	});

	test("AC-6: the marker post fails: no inbound, approval_retry_inject_rejected, both cards say it did not go in", async () => {
		const { canonicalTs, mirrorTs } = await seed();
		transport.failNext.createMessage = [
			new DiscordCallError("definitive", "discord_http_403:50001 Missing Access", 403, 50001),
		];
		await retry(canonicalTs, { channel: DM, ts: mirrorTs ?? "" });
		expect(retryInbounds()).toHaveLength(0);
		expect(logs.filter((l) => l.includes("event=approval_retry_inject_rejected"))).toHaveLength(1);
		for (const [channel, ts] of [
			[ESC, canonicalTs],
			[DM, mirrorTs ?? ""],
		] as const) {
			const edit = lastEdit(channel, ts);
			expect(actionIds(edit?.components)).toEqual([]);
			expect(contextText(edit?.embeds)).toContain("⚠️ 다시 요청을 넣지 못함");
		}
	});

	test("AC-6: a click by anyone but the owner is denied before it reaches the daemon", async () => {
		const { canonicalTs, mirrorTs } = await seed();
		await retry(canonicalTs, { channel: DM, ts: mirrorTs ?? "" }, "100000000000000002");
		expect(logs.some((l) => l.includes("event=action_denied"))).toBe(true);
		expect(markers()).toHaveLength(0);
		expect(retryInbounds()).toHaveLength(0);
	});
});
