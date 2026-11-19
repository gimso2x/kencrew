// Channel root isolation: every new channel root is its own origin
// `discord/ch/<C>/t/<rootId>` — its own omp session and mailbox — so a second root never steers into the first root's
// running turn and answers, taskSpec threads and approval rows stay on their own root thread. Waits are on log lines,
// posts and finals (bounded), never fixed sleeps.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { THREAD_CONTEXT_HEADER } from "../src/core/mailbox";
import { normalizeInbound } from "../src/core/normalize";
import { OriginRouter, openBotStore, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { Daemon } from "../src/daemon/daemon";
import { INTERRUPTED_NOTICE, recoverDispatched } from "../src/daemon/recovery";
import type { DiscordInteraction, DiscordMessageEvent } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { gcSessions } from "../src/ops/gc";
import { redact } from "../src/redact";
import { approvalActionId } from "../src/safety/approval";
import type { Store } from "../src/store/db";
import {
	CHANNEL,
	discordBinding,
	GUILD,
	hasButtons,
	makeHome,
	OWNER,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { ROOMY_STATFS } from "./helpers/disk";
import { makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

const CH = CHANNEL;
const CHANNEL_ORIGIN = `discord/ch/${CH}`;
const STEER_POINTER = "↪ 이 요청은 진행 중이던 작업에 합쳐져서 답을 다른 스레드에 올렸어";
/** Failure bound of every wait, below bun's 5 s test timeout so a miss names what it waited for. */
const WAIT_MS = 4_000;

/** Message ids (snowflakes) in ascending order: `tsAt(100)` is older than `tsAt(200)`. */
const tsAt = (n: number) => String(710_000_000_000_000_000n + BigInt(n));
const rootOrigin = (ts: string) => `${CHANNEL_ORIGIN}/t/${ts}`;
const ref = (ts: string) => `${CH}:${ts}`;

/** Resolves when approval buttons go up on a card. */
class CardTransport extends WaitingDiscordTransport {
	shown = Promise.withResolvers<{ channel: string; ts: string }>();

	override async editMessage(args: Parameters<WaitingDiscordTransport["editMessage"]>[0]): Promise<void> {
		await super.editMessage(args);
		if (hasButtons(args.components)) this.shown.resolve({ channel: args.channelId, ts: args.messageId });
	}
}

/** Daemon log sink whose waiters resolve on the line set that satisfies them (bounded, no polling). */
class LogLines {
	readonly lines: string[] = [];
	readonly #waiters = new Set<() => void>();

	push(line: string): void {
		this.lines.push(line);
		for (const waiter of [...this.#waiters]) waiter();
	}

	count(re: RegExp): number {
		return this.lines.filter((line) => re.test(line)).length;
	}

	waitFor(done: () => boolean, what: string): Promise<void> {
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

/** The owner's message in the server channel CH; with `threadId` it is a reply inside that root's thread channel. */
function channelMessage(id: string, content: string, threadId?: string): DiscordMessageEvent {
	return {
		id,
		channel_id: threadId ?? CH,
		guild_id: GUILD,
		author: { id: OWNER },
		content,
		type: 0,
	};
}

describe("daemon: channel roots are isolated sessions", () => {
	let home: TestHome;
	let daemon: Daemon;
	let transport: CardTransport;
	let logs: LogLines;
	let drivers: Map<string, FakeOmpDriver>;

	/** `sessions` is the omp session storage; a restart test passes the dead daemon's so the new one resumes it. */
	async function boot(hold: (origin: string) => boolean, sessions = new FakeSessionStore()): Promise<void> {
		transport = new CardTransport();
		transport.setChannel({ id: CH, type: 0, guildId: GUILD });
		const clock = { now: () => Date.now() };
		const discord = home.config.channels.discord;
		if (discord === undefined) throw new Error("makeHome has no channels.discord");
		daemon = new Daemon({
			config: {
				...home.config,
				channels: { discord: { ...discord, mentionFreeChannels: [CH] } },
				herdr: {},
			},
			channels: [discordBinding(transport)],
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			stopDrainMs: 0,
			statfs: ROOMY_STATFS, // the [TASK] start's disk check never depends on this machine's free space
			driverFactory: (origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: hold(origin) });
				drivers.set(origin, driver);
				return driver;
			},
		});
		await daemon.start();
	}

	function driverOf(origin: string): FakeOmpDriver {
		const driver = drivers.get(origin);
		if (driver === undefined) throw new Error(`no driver for ${origin}`);
		return driver;
	}

	/** Prompts and steers an origin's omp child received (session bookkeeping calls left out). */
	const turnCalls = (origin: string) =>
		driverOf(origin).calls.filter((call) => call.startsWith("prompt:") || call.startsWith("steer:"));
	const turnStarts = () => logs.count(/event=turn_start /);
	const steers = () => logs.lines.filter((line) => /event=steer_delivered /.test(line));

	/** Root A's turn is running (held) when root B arrives; resolves once B is either prompted or steered. */
	async function twoRootsInFlight(a: string, b: string, textB = "ego 질문"): Promise<void> {
		await boot(() => true);
		await transport.emitMessage(channelMessage(a, "inferhub 질문"));
		await logs.waitFor(() => turnStarts() >= 1, "root A turn_start");
		await transport.emitMessage(channelMessage(b, textB));
		await logs.waitFor(() => turnStarts() >= 2 || steers().length >= 1, "root B prompted or steered");
	}

	function answersByThread(): Array<[string, string]> {
		return daemon.store
			.listDeliveries()
			.filter((d) => d.body.startsWith("ECHO"))
			.map((d): [string, string] => [d.threadRef, d.body]);
	}

	beforeEach(() => {
		home = makeHome("ompbot-root-iso-");
		logs = new LogLines();
		drivers = new Map();
	});

	afterEach(async () => {
		for (const driver of drivers.values()) driver.release();
		await daemon.stop();
		home.remove();
	});

	test("AC-1: root B arriving while root A's turn runs is its own turn; each answer stays on its own root", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		await twoRootsInFlight(a, b);
		expect(steers()).toEqual([]);
		expect(daemon.store.getInbound(ref(b))?.originKey).toBe(rootOrigin(b));
		expect(daemon.store.getInbound(ref(a))?.originKey).toBe(rootOrigin(a));
		expect(turnCalls(rootOrigin(b))).toEqual(["prompt:ego 질문"]);
		expect(turnCalls(rootOrigin(a))).toEqual(["prompt:inferhub 질문"]);

		driverOf(rootOrigin(a)).release();
		driverOf(rootOrigin(b)).release();
		await transport.waitForPosts((text) => text.startsWith("ECHO"), 2);
		expect(answersByThread().sort()).toEqual([
			[ref(a), "ECHO inferhub 질문"],
			[ref(b), "ECHO ego 질문"],
		]);
		// Each root's thread channel (a Discord thread started from the root message has the root's id) got its answer.
		const posted = transport.posts((text) => text.startsWith("ECHO"));
		expect(posted.map((p) => [p.channelId, (p.content ?? "").split("\n")[0]]).sort()).toEqual([
			[a, "ECHO inferhub 질문"],
			[b, "ECHO ego 질문"],
		]);
		expect(daemon.store.listDeliveries().filter((d) => d.body.startsWith(STEER_POINTER))).toEqual([]);
		expect(transport.posts((text) => text.startsWith(STEER_POINTER))).toEqual([]);
	});

	test("AC-2: B finishing first and A finishing later still answers each root in its own thread", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		await twoRootsInFlight(a, b);
		driverOf(rootOrigin(b)).release();
		await transport.waitForPosts((text) => text.startsWith("ECHO ego 질문"));
		expect(answersByThread()).toEqual([[ref(b), "ECHO ego 질문"]]);
		expect(daemon.store.getInbound(ref(a))?.state).toBe("dispatched");

		driverOf(rootOrigin(a)).release();
		await transport.waitForPosts((text) => text.startsWith("ECHO inferhub 질문"));
		expect(answersByThread()).toEqual([
			[ref(b), "ECHO ego 질문"],
			[ref(a), "ECHO inferhub 질문"],
		]);
		expect(
			transport.posts((text) => text.startsWith("ECHO")).map((p) => [p.channelId, (p.content ?? "").split("\n")[0]]),
		).toEqual([
			[b, "ECHO ego 질문"],
			[a, "ECHO inferhub 질문"],
		]);
		expect(daemon.store.listDeliveries().filter((d) => d.body.startsWith(STEER_POINTER))).toEqual([]);
	});

	test("AC-4: a reply in root A's thread joins A's session (steered into A's running turn); A's approval row points at A", async () => {
		const a = tsAt(100);
		const reply = tsAt(150);
		await boot(() => true);
		await transport.emitMessage(channelMessage(a, "배포 준비해줘"));
		await logs.waitFor(() => turnStarts() >= 1, "root A turn_start");
		const opRef = daemon.store.getInbound(ref(a))?.opRef;

		await transport.emitMessage(channelMessage(reply, "main 브랜치로", a));
		await logs.waitFor(() => steers().length >= 1, "reply steered");
		expect(daemon.store.getInbound(`${CH}:${reply}`)).toMatchObject({
			originKey: rootOrigin(a),
			threadRef: ref(a),
			opRef,
		});
		expect(turnCalls(rootOrigin(a))).toEqual(["prompt:배포 준비해줘", "steer:main 브랜치로"]);

		const tool = daemon.hostToolsFor(rootOrigin(a)).find((t) => t.name === "ompbot_request_approval");
		if (!tool) throw new Error("approval tool missing");
		const result = tool.execute({ summary: "force push main" }, { signal: new AbortController().signal });
		const card = await transport.shown.promise;
		expect(card.channel).toBe(CH);
		expect(daemon.store.getApproval(`${card.channel}:${card.ts}`)).toMatchObject({
			status: "pending",
			originKey: rootOrigin(a),
			originThreadRef: ref(a),
		});
		const click: DiscordInteraction = {
			id: tsAt(900),
			application_id: "600000000000000000",
			type: 3,
			token: "token-approve",
			channel_id: card.channel,
			guild_id: GUILD,
			member: { user: { id: OWNER } },
			data: { custom_id: approvalActionId("approve", card.channel, card.ts), component_type: 2 },
			message: { id: card.ts, channel_id: card.channel },
		};
		await transport.emitInteraction(click);
		expect(await result).toBe("approved");

		driverOf(rootOrigin(a)).release();
		await transport.waitForPosts((text) => text.startsWith("ECHO"));
		expect(answersByThread()).toEqual([[ref(a), "ECHO 배포 준비해줘 | main 브랜치로"]]);
	});

	test("AC-5: the same root event twice is one row, one origin, one turn, one answer", async () => {
		await boot(() => false);
		// A channel-level command first: it keeps the channel origin.
		const command = channelMessage(tsAt(50), "!thinking high");
		await transport.emitMessage(command);
		await transport.waitForPosts((text) => text.includes("high"));
		const x = tsAt(100);
		const root = channelMessage(x, "중복 테스트");
		await transport.emitMessage(root);
		await transport.waitForPosts((text) => text.startsWith("ECHO 중복 테스트"));
		await transport.emitMessage(root);
		const rootDuplicate = new RegExp(`event=inbound_duplicate id=${CH}:${x}\\b`);
		await logs.waitFor(() => logs.count(rootDuplicate) >= 1, "live duplicate");

		expect(daemon.store.listInbound().filter((row) => row.platformMessageId === ref(x))).toHaveLength(1);
		expect(daemon.store.listOrigins("discord").filter((origin) => origin.endsWith(x))).toEqual([rootOrigin(x)]);
		expect(driverOf(rootOrigin(x)).calls.filter((call) => call.startsWith("prompt:"))).toEqual(["prompt:중복 테스트"]);
		expect(daemon.store.listDeliveries({ originKey: rootOrigin(x) }).map((d) => [d.threadRef, d.body])).toEqual([
			[ref(x), "ECHO 중복 테스트"],
		]);
		expect(transport.posts((text) => text.startsWith("ECHO 중복 테스트"))).toHaveLength(1);
	});

	test("AC-7: root commands stay on the channel origin; a lane trigger root starts a lane", async () => {
		await boot(() => false);
		const model = channelMessage(tsAt(10), "!model fake/beta");
		await transport.emitMessage(model);
		await transport.waitForPosts((text) => text.includes("fake/beta"));
		expect(daemon.store.getInbound(ref(model.id))?.originKey).toBe(CHANNEL_ORIGIN);

		// A lane starts only inside a git repository (it works in its own worktree beside it).
		const repo = makeRepo([], "ompbot-root-iso-lane-");
		try {
			const lane = channelMessage(tsAt(20), `작업: 루트 격리 레인 @${repo}`);
			await transport.emitMessage(lane);
			await transport.waitForPosts((text) => text.startsWith("🔄 작업 레인"));
			const row = daemon.store.getInbound(ref(lane.id));
			expect(row?.opRef).toBe(`lane:${ref(lane.id)}`);
			expect(
				daemon.store.listDeliveries({ originKey: row?.originKey ?? "" }).map((d) => [d.threadRef, d.opRef]),
			).toEqual([[ref(lane.id), `lane:${ref(lane.id)}`]]);
			// The trigger text is never an omp prompt of a conversation session.
			for (const [origin, driver] of drivers) {
				if (origin.startsWith("discord/"))
					expect(driver.calls.some((c) => c.includes("작업: 루트 격리 레인"))).toBe(false);
			}
		} finally {
			removeRepoAndWorktrees(repo);
		}
	});

	test("AC-8: a root session inherits the channel's model and thinking; its first prompt carries no context block", async () => {
		await boot(() => false);
		await transport.emitMessage(channelMessage(tsAt(10), "!model fake/beta"));
		await transport.waitForPosts((text) => text.includes("fake/beta"));
		await transport.emitMessage(channelMessage(tsAt(20), "!thinking high"));
		await transport.waitForPosts((text) => text.includes("high"));

		const x = tsAt(100);
		await transport.emitMessage(channelMessage(x, "새 루트 질문"));
		await transport.waitForPosts((text) => text.startsWith("ECHO 새 루트 질문"));
		const origin = daemon.store.getOrigin(rootOrigin(x));
		expect(origin).toMatchObject({ model: null, thinking: null });
		const calls = driverOf(rootOrigin(x)).calls;
		expect(calls).toContain("setModel:fake/beta");
		expect(calls).toContain("setThinking:high");
		const prompts = calls.filter((call) => call.startsWith("prompt:"));
		expect(prompts).toEqual(["prompt:새 루트 질문"]);
		expect(prompts[0]).not.toContain(THREAD_CONTEXT_HEADER);
	});

	test("D1-4 (AC-3): the daemon's own dispatch tool binds a [TASK] root's taskSpec to that root's thread and origin", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		await twoRootsInFlight(a, b, "[TASK] 새 작업 등록해줘");
		// Fixture: the ledger's register records what the real tool path hands it. The repo is a plain directory, so
		// the run stops at `git worktree add` — before any herdr agent or chat post — and the registration is undone.
		const posts = transport.count("createMessage");
		const ledger = daemon.store.tasks;
		const register = ledger.register.bind(ledger);
		const registered: Array<{ originKey: string; threadRef: string }> = [];
		ledger.register = (input) => {
			registered.push({ originKey: input.originKey, threadRef: input.threadRef });
			return register(input);
		};
		const repo = mkdtempSync(join(tmpdir(), "ompbot-root-iso-task-"));
		try {
			const dispatch = (origin: string) => {
				const tool = daemon.hostToolsFor(origin).find((t) => t.name === "ompbot_dispatch");
				if (!tool) throw new Error(`dispatch tool missing for ${origin}`);
				const taskSpec = { title: "루트 격리", risk: "L1", goal: "g", acceptance: ["a"], repo };
				return tool.execute({ task: "구현", taskSpec }, { signal: new AbortController().signal });
			};
			// Both turns are still running: the supplier answers from each origin's own running turn.
			expect(daemon.store.getInbound(ref(b))?.state).toBe("dispatched");
			expect(await dispatch(rootOrigin(b))).toStartWith("시작 실패: git worktree add failed");
			expect(await dispatch(rootOrigin(a))).toStartWith("시작 실패: git worktree add failed");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
		expect(registered).toEqual([
			{ originKey: rootOrigin(b), threadRef: ref(b) },
			{ originKey: rootOrigin(a), threadRef: ref(a) },
		]);
		// Stopped before the task card: no registration post.
		expect(transport.count("createMessage")).toBe(posts);
	});

	test("D1-5 (AC-6): a daemon restart (stop → new Daemon.start on the same home) notifies each in-flight root's own thread", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		const sessions = new FakeSessionStore();
		await boot(() => true, sessions);
		await transport.emitMessage(channelMessage(a, "inferhub 질문"));
		await transport.emitMessage(channelMessage(b, "ego 질문"));
		await logs.waitFor(() => turnStarts() >= 2, "both root turns running");
		// The process goes down mid-turn: the children stop without a final, the ledger keeps both rows `dispatched`.
		await daemon.stop();
		const dead = transport;
		expect(dead.posts((text) => text === INTERRUPTED_NOTICE)).toEqual([]);

		const recoveries = logs.count(/event=recovery_done /);
		await boot(() => false, sessions);
		await logs.waitFor(() => logs.count(/event=recovery_done /) > recoveries, "restart recovery");
		expect(logs.lines.filter((line) => /event=recovery_done /.test(line)).at(-1)).toMatch(
			/ answered=0 interrupted=2 continued=0$/,
		);
		await transport.waitForPosts((text) => text === INTERRUPTED_NOTICE, 2);
		expect(
			daemon.store
				.listDeliveries()
				.filter((d) => d.body === INTERRUPTED_NOTICE)
				.map((d) => [d.originKey, d.threadRef]),
		).toEqual([
			[rootOrigin(a), ref(a)],
			[rootOrigin(b), ref(b)],
		]);
		expect(
			transport
				.posts((text) => text === INTERRUPTED_NOTICE)
				.map((p) => [p.channelId, p.messageReference?.messageId])
				.sort(),
		).toEqual([
			[CH, a],
			[CH, b],
		]);
		expect(daemon.store.getInbound(ref(a))?.state).toBe("failed_notified");
		expect(daemon.store.getInbound(ref(b))?.state).toBe("failed_notified");
	});

	function rowsOf(ts: string) {
		return daemon.store.listInbound().filter((row) => row.platformMessageId === ref(ts));
	}

	/** A gateway Ready of a new session: the adapter runs a missed-message pass. */
	function reconnect(): void {
		transport.emitReady({ resumed: false });
	}

	test("a channel's missed root — older than the live one — is recovered on reconnect as its own root", async () => {
		await boot(() => false);
		const missed = tsAt(200);
		const live = tsAt(300);
		await transport.emitMessage(channelMessage(live, "라이브 루트"));
		await transport.waitForPosts((text) => text.startsWith("ECHO 라이브 루트"));
		expect(daemon.store.getOrigin(CHANNEL_ORIGIN)).toBeUndefined();

		// The missed root never reached the socket: it is only in the channel history, above the channel's watermark
		// (without one a pass looks back only a short window from now, and these ids are older).
		daemon.store.setCursor(`dc:${CH}`, tsAt(50));
		transport.history.set(CH, [channelMessage(live, "라이브 루트"), channelMessage(missed, "놓친 루트")]);
		reconnect();
		await transport.waitForPosts((text) => text.startsWith("ECHO 놓친 루트"));

		expect(rowsOf(missed).map((row) => [row.originKey, row.threadRef])).toEqual([[rootOrigin(missed), ref(missed)]]);
		expect(turnCalls(rootOrigin(missed))).toEqual(["prompt:놓친 루트"]);
		expect(daemon.store.listDeliveries({ originKey: rootOrigin(missed) }).map((d) => [d.threadRef, d.body])).toEqual([
			[ref(missed), "ECHO 놓친 루트"],
		]);
		// The recovered root's thread channel (the root's own id) got the answer.
		expect(transport.posts((text) => text.startsWith("ECHO 놓친 루트")).map((p) => p.channelId)).toEqual([missed]);
		// Root isolation holds: recovery made no channel-wide origin row and the live root kept its own answer.
		expect(daemon.store.getOrigin(CHANNEL_ORIGIN)).toBeUndefined();
		expect(rowsOf(live).map((row) => row.originKey)).toEqual([rootOrigin(live)]);
		expect(turnCalls(rootOrigin(live))).toEqual(["prompt:라이브 루트"]);
	});

	test("after gc removes a quiet channel's only root origin, its dc: watermark alone keeps the channel a backfill target", async () => {
		await boot(() => false);
		const old = tsAt(100);
		await transport.emitMessage(channelMessage(old, "오래된 루트"));
		await transport.waitForPosts((text) => text.startsWith("ECHO 오래된 루트"));
		// A pass while the root origin exists stores the channel's watermark; set directly to keep the test event-driven.
		daemon.store.setCursor(`dc:${CH}`, old);
		await daemon.stop();

		// The fake omp writes no session files: lay one down so gc sees a fresh origin first, then a 40-day-quiet one.
		const sessionDir = sessionDirFor(join(home.dir, "sessions"), rootOrigin(old), 1);
		const originDir = dirname(sessionDir);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "session.jsonl"), "{}\n");
		const fresh = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now(), dryRun: true });
		expect(fresh.threadOriginsRemoved).toEqual([]);
		ageTree(originDir, (Date.now() - 40 * DAY_MS) / 1000);
		const gc = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now() });
		expect(gc.threadOriginsRemoved).toEqual([rootOrigin(old)]);
		expect(existsSync(originDir)).toBe(false);

		await boot(() => false);
		expect(daemon.store.listOrigins("discord").filter((origin) => origin.startsWith(CHANNEL_ORIGIN))).toEqual([]);
		expect(daemon.store.getCursor(`dc:${CH}`)).toBe(old);

		// While the bot was down, a new root arrived in the now origin-less channel.
		const missed = tsAt(200);
		transport.history.set(CH, [channelMessage(missed, "놓친 루트"), channelMessage(old, "오래된 루트")]);
		reconnect();
		await transport.waitForPosts((text) => text.startsWith("ECHO 놓친 루트"));
		expect(transport.calls.some((c) => c.method === "listMessages" && c.channelId === CH)).toBe(true);
		expect(rowsOf(missed).map((row) => [row.originKey, row.threadRef])).toEqual([[rootOrigin(missed), ref(missed)]]);
		expect(turnCalls(rootOrigin(missed))).toEqual(["prompt:놓친 루트"]);
		// No channel-wide origin was made to get there, and the gc'd root stays gone.
		expect(daemon.store.getOrigin(CHANNEL_ORIGIN)).toBeUndefined();
		expect(daemon.store.getOrigin(rootOrigin(old))).toBeUndefined();
	});
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sets the access and modification time of a directory tree (gc measures origin activity by newest mtime). */
function ageTree(path: string, seconds: number): void {
	if (statSync(path).isDirectory()) for (const name of readdirSync(path)) ageTree(join(path, name), seconds);
	utimesSync(path, seconds, seconds);
}

describe("router: taskSpec thread binding and restart recovery of two roots", () => {
	let dir: string;
	let store: Store;
	let router: OriginRouter;
	let sessions: FakeSessionStore;
	const clock = { now: () => 1_000_000 };
	const log = createLogger({ sink: () => undefined, clock, redact });

	/** The record the Discord adapter hands the daemon for an owner root message in channel CH. */
	function rootRecord(ts: string, text: string): InboundRecord {
		const result = normalizeInbound({
			userId: OWNER,
			botUserId: "500000000000000000",
			ownerUserId: OWNER,
			text,
			quoted: [],
			channel: CH,
			ts,
			channelType: "channel",
			platform: "discord",
		});
		if (!result.accept) throw new Error(`root ${ts} rejected: ${result.reason}`);
		return result.inbound;
	}

	/** Same expression as the daemon's taskSpec `threadRef` provider (daemon.ts hostToolsFor). */
	const taskThreadRef = (originKey: string) =>
		router.mailbox(originKey).state.threadRef ?? store.latestInboundThread(originKey);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-root-iso-router-"));
		store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
		sessions = new FakeSessionStore();
		router = new OriginRouter({
			timezone: "Asia/Seoul",
			store,
			clock,
			sessionsRoot: join(dir, "sessions"),
			log,
			statusProvider: () => "status: ok",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true }),
		});
	});

	afterEach(async () => {
		await router.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("AC-3: a [TASK] root arriving during root A's turn binds its taskSpec to its own thread", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		const recordA = rootRecord(a, "inferhub 질문");
		const recordB = rootRecord(b, "[TASK] 새 작업 등록해줘");
		await router.route(recordA);
		await router.route(recordB);
		expect(router.mailbox(recordB.originKey).state.busy).toBe(true);
		expect(taskThreadRef(recordB.originKey)).toBe(ref(b));
		expect(taskThreadRef(recordA.originKey)).toBe(ref(a));
	});

	test("AC-6: restart recovery of two in-flight roots notifies each root's own thread", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		const recordA = rootRecord(a, "inferhub 질문");
		const recordB = rootRecord(b, "ego 질문");
		await router.route(recordA);
		await router.route(recordB);
		expect(store.listInbound({ state: "dispatched" }).map((row) => row.platformMessageId)).toEqual([ref(a), ref(b)]);
		// The process dies: children stop without a final; the ledger keeps both rows `dispatched`.
		await router.close();

		const result = await recoverDispatched({
			store,
			log,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		expect(result).toEqual({ answered: 0, interrupted: 2, continued: 0 });
		const notices = store
			.listDeliveries()
			.filter((d) => d.body === INTERRUPTED_NOTICE)
			.map((d) => [d.originKey, d.threadRef]);
		expect(notices).toEqual([
			[recordA.originKey, ref(a)],
			[recordB.originKey, ref(b)],
		]);
		expect(recordA.originKey).not.toBe(recordB.originKey);
	});
});
