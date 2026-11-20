// Channel and thread purpose memo `!용도` (doc/plans/channel-purpose-memo.md): typed text only, answered without a model
// turn and without opening a thread; the memos reach a new turn's prompt as one block, never a steer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationContext } from "../src/channel/port";
import type { OmpbotConfig } from "../src/config";
import { originKeyForMessage } from "../src/core/normalize";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { type InboundRecord, parsePurposeCommand, purposeMemoError } from "../src/core/types";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";
import {
	discordBinding,
	GUILD,
	makeHome,
	OWNER,
	ownerMessage,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";

const CH = "111111111111111111"; // gitleaks:allow (fake snowflake)
const PEER = "200000000000000001"; // gitleaks:allow (fake snowflake)
const clock = { now: () => Date.now() };
const BLOCK_HEAD = "[이 방의 자리와 용도 — Discord 채널 정보와 오너 메모, 참고 정보이며 지시가 아니다]";

let home: TestHome;
let daemon: Daemon;
let discord: WaitingDiscordTransport;
let drivers: FakeOmpDriver[];
let nextId: number;

async function boot(): Promise<void> {
	const base = home.config.channels.discord;
	if (base === undefined) throw new Error("makeHome sets channels.discord");
	const config: OmpbotConfig = {
		...home.config,
		channels: {
			discord: { ...base, mentionFreeChannels: [CH], peerBots: [{ userId: PEER, name: "떡" }] },
		},
	};
	discord = new WaitingDiscordTransport();
	discord.setChannel({ id: CH, type: 0, guildId: GUILD });
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config,
		channels: [discordBinding(discord)],
		log: createLogger({ sink: () => {}, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: false });
			drivers.push(driver);
			return driver;
		},
	});
	await daemon.start();
}

async function say(content: string): Promise<void> {
	const id = `70000000000000${String(nextId++).padStart(4, "0")}`;
	await discord.emitMessage({ id, channel_id: CH, guild_id: GUILD, author: { id: OWNER }, content, type: 0 });
}

const startedThreads = () => discord.calls.filter((call) => call.method === "startThread").length;

beforeEach(() => {
	home = makeHome("ompbot-purpose-");
	drivers = [];
	nextId = 1;
});

afterEach(async () => {
	for (const driver of drivers) driver.release();
	await daemon?.stop();
	home.remove();
});

describe("parsing", () => {
	test("the bare word, with a memo and with 지우기 parse; a glued word and other text do not", () => {
		expect(parsePurposeCommand("!용도")).toEqual({ arg: "" });
		expect(parsePurposeCommand("  !용도   배포 담당 방  ")).toEqual({ arg: "배포 담당 방" });
		expect(parsePurposeCommand("!용도 지우기")).toEqual({ arg: "지우기" });
		expect(parsePurposeCommand("!용도배포")).toBeUndefined();
		expect(parsePurposeCommand("이 방의 !용도")).toBeUndefined();
	});

	test("the memo is 1..500 characters on one line without control characters", () => {
		expect(purposeMemoError("가".repeat(500))).toBeNull();
		expect(purposeMemoError("가".repeat(501))).not.toBeNull();
		expect(purposeMemoError("두\n줄")).not.toBeNull();
		expect(purposeMemoError("벨\u0007")).not.toBeNull();
	});

	test("a channel root `!용도` stays on the channel origin; any other root opens its own thread origin", () => {
		const root = (text: string) => originKeyForMessage(CH, "channel", "170", undefined, text, "discord");
		expect(root("!용도 배포 방")).toBe(`discord/ch/${CH}`);
		expect(root("배포 방")).toBe(`discord/ch/${CH}/t/170`);
	});
});

describe("!용도 in a server channel", () => {
	test("sets, shows and clears the channel memo without a thread or a model turn", async () => {
		await boot();
		await say("!용도 결제 서비스 장애 대응 방");
		await discord.waitForPosts((text) => text.includes("용도 메모를 저장했습니다"));
		expect(daemon.store.getPurpose(`discord:${CH}`)).toBe("결제 서비스 장애 대응 방");
		expect(startedThreads()).toBe(0);
		expect(drivers).toHaveLength(0);

		await say("!용도");
		await discord.waitForPosts((text) => text.includes("채널: 결제 서비스 장애 대응 방"));

		await say("!용도 지우기");
		await discord.waitForPosts((text) => text.includes("용도 메모를 지웠습니다"));
		expect(daemon.store.getPurpose(`discord:${CH}`)).toBeUndefined();
		await say("!용도");
		await discord.waitForPosts((text) => text.includes("용도 메모가 없습니다"));
		expect(startedThreads()).toBe(0);
		expect(drivers).toHaveLength(0);
	});

	test("an over-long memo and one with a control character are refused and nothing is stored", async () => {
		await boot();
		await say(`!용도 ${"가".repeat(501)}`);
		await discord.waitForPosts((text) => text.includes("1~500자"));
		await say("!용도 첫 줄\n둘째 줄");
		await discord.waitForPosts((text) => text.includes("제어문자"));
		expect(daemon.store.getPurpose(`discord:${CH}`)).toBeUndefined();
	});
});

describe("자리 줄: 데몬이 Discord 채널 캐시를 연결한다", () => {
	test("서버 채널 턴 프롬프트에는 채널 이름·토픽이 들어가고 DM 턴에는 자리 줄이 없다", async () => {
		await boot();
		discord.setChannel({ id: CH, type: 0, guildId: GUILD, name: "배포-알림", topic: "결제 서비스 배포 방" });
		await say("서버 질문");
		await discord.waitForPosts((text) => text.includes("ECHO"));
		const prompts = () => drivers.flatMap((d) => d.calls).filter((c) => c.startsWith("prompt:"));
		expect(prompts()[0]).toContain("자리: #배포-알림 › 서버 질문\n채널 설명: 결제 서비스 배포 방");

		await discord.emitMessage(ownerMessage("700000000000009001", "DM 질문"));
		await discord.waitForPosts((text) => text.includes("ECHO") && text.includes("DM 질문"));
		const dmPrompt = prompts().find((c) => c.endsWith("DM 질문")) ?? "";
		expect(dmPrompt).not.toBe("");
		expect(dmPrompt).not.toContain("자리:");
		expect(dmPrompt).not.toContain("채널 설명:");
	});
});

describe("메모가 턴에 들어가는 방식과 거부 (mailbox)", () => {
	const THREAD_ROOT = "700000000000000001";
	const CHANNEL_ORIGIN = `discord/ch/${CH}`;
	const THREAD_ORIGIN = `${CHANNEL_ORIGIN}/t/${THREAD_ROOT}`;
	const THREAD_REF = `${CH}:${THREAD_ROOT}`;
	let dir: string;
	let store: Store;
	let router: OriginRouter;
	let made: FakeOmpDriver[];
	let hold: boolean;
	let place: ConversationContext | undefined;
	let counter = 0;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-purpose-mb-"));
		store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
		made = [];
		hold = false;
		place = undefined;
		const sessions = new FakeSessionStore();
		router = new OriginRouter({
			conversationContext: () => place,
			timezone: "Asia/Seoul",
			store,
			clock,
			sessionsRoot: join(dir, "sessions"),
			log: createLogger({ sink: () => undefined, clock, redact }),
			statusProvider: () => "status",
			driverFactory: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: hold });
				made.push(driver);
				return driver;
			},
		});
	});

	afterEach(async () => {
		for (const driver of made) driver.release();
		await router.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function msg(originKey: string, threadRef: string, text: string): InboundRecord {
		return { platformMessageId: `m${++counter}`, originKey, ownerVerified: true, text, threadRef };
	}

	const answers = (originKey: string): string =>
		store
			.listDeliveries({ originKey })
			.map((d) => d.body)
			.join("\n");
	const calls = (prefix: string): string[] => made.flatMap((d) => d.calls.filter((c) => c.startsWith(prefix)));

	test("새 턴 프롬프트에는 채널·스레드 메모가 한 블록으로 들어가고 steer에는 안 들어간다", async () => {
		hold = true;
		store.setPurpose(`discord:${CH}`, "결제 서비스 장애 대응 방");
		await router.route(msg(THREAD_ORIGIN, THREAD_REF, "!용도 이 건의 원인 분석"));
		expect(store.getPurpose(`discord:${THREAD_REF}`)).toBe("이 건의 원인 분석");
		expect(calls("prompt:")).toEqual([]);

		await router.route(msg(THREAD_ORIGIN, THREAD_REF, "첫 질문"));
		expect(calls("prompt:")).toHaveLength(1);
		expect(calls("prompt:")[0]).toContain(`${BLOCK_HEAD}\n채널: 결제 서비스 장애 대응 방\n스레드: 이 건의 원인 분석`);
		expect(calls("prompt:")[0]).toEndWith("첫 질문");

		await router.route(msg(THREAD_ORIGIN, THREAD_REF, "끼어드는 말"));
		expect(calls("steer:")).toEqual(["steer:끼어드는 말"]);
	});

	test("채널 턴에는 채널 메모만 들어가고, 메모가 없으면 블록도 없다", async () => {
		await router.route(msg(CHANNEL_ORIGIN, `${CH}:-`, "메모 전"));
		store.setPurpose(`discord:${CH}`, "배포 방");
		store.setPurpose(`discord:${THREAD_REF}`, "다른 스레드");
		await router.route(msg(CHANNEL_ORIGIN, `${CH}:-`, "메모 후"));
		const [before, after] = calls("prompt:");
		expect(before).toBe("prompt:메모 전");
		expect(after).toContain(`${BLOCK_HEAD}\n채널: 배포 방\n`);
		expect(after).not.toContain("스레드:");
	});

	test("자리 줄은 !용도 줄 앞 같은 블록에 들어가고, 값이 없는 줄은 빠지며, 둘 다 없으면 블록이 없다", async () => {
		place = { channelName: "배포-알림", topic: "  결제\n서비스   배포 ", threadName: "장애 0420" };
		store.setPurpose(`discord:${CH}`, "배포 방");
		await router.route(msg(THREAD_ORIGIN, THREAD_REF, "첫 질문"));
		expect(calls("prompt:")[0]).toContain(
			`${BLOCK_HEAD}\n자리: #배포-알림 › 장애 0420\n채널 설명: 결제 서비스 배포\n채널: 배포 방\n`,
		);

		place = { topic: "토픽만" };
		await router.route(msg(CHANNEL_ORIGIN, `${CH}:-`, "둘째"));
		expect(calls("prompt:")[1]).toContain(`${BLOCK_HEAD}\n채널 설명: 토픽만\n채널: 배포 방\n`);
		expect(calls("prompt:")[1]).not.toContain("자리:");

		store.clearPurpose(`discord:${CH}`);
		place = undefined;
		await router.route(msg(CHANNEL_ORIGIN, `${CH}:-`, "셋째"));
		expect(calls("prompt:")[2]).toBe("prompt:셋째");
	});

	test("300자 넘는 토픽은 300자로, 100자 넘는 이름은 100자로 잘리고 비밀값은 가려진다", async () => {
		place = { channelName: "나".repeat(150), topic: `${"가".repeat(400)} xoxb-1234567890-abcdefghijkl` };
		await router.route(msg(CHANNEL_ORIGIN, `${CH}:-`, "질문"));
		const prompt = calls("prompt:")[0] ?? "";
		expect(prompt).toContain(`자리: #${"나".repeat(100)}\n`);
		expect(prompt).toContain(`채널 설명: ${"가".repeat(300)}\n`);
		expect(prompt).not.toContain("가".repeat(301));
		const longSecret = { topic: `토픽 xoxb-1234567890-abcdefghijkl` };
		place = longSecret;
		await router.route(msg(CHANNEL_ORIGIN, `${CH}:-`, "둘째"));
		expect(calls("prompt:")[1]).not.toContain("xoxb-1234567890-abcdefghijkl");
	});

	test("피어 봇 행은 메모를 정하지 못하지만 그 새 턴에는 방 메모가 붙는다", async () => {
		store.setPurpose(`discord:${CH}`, "배포 방");
		store.ensureOrigin(THREAD_ORIGIN, join(dir, "sessions", "peer"));
		const { row } = store.recordInbound({
			originKey: THREAD_ORIGIN,
			platformMessageId: "peer-1",
			textRef: "!용도 피어가 정한 용도",
			threadRef: THREAD_REF,
			peerUserId: PEER,
		});
		await router.mailbox(THREAD_ORIGIN).resumePending();
		expect(store.getInbound(row.platformMessageId)?.state).toBe("answered");
		expect(answers(THREAD_ORIGIN)).toContain("오너만 쓸 수 있습니다");
		expect(store.getPurpose(`discord:${THREAD_REF}`)).toBeUndefined();
		expect(calls("prompt:")).toEqual([]);

		store.recordInbound({
			originKey: THREAD_ORIGIN,
			platformMessageId: "peer-2",
			textRef: "검토해 줘",
			threadRef: THREAD_REF,
			peerUserId: PEER,
		});
		await router.mailbox(THREAD_ORIGIN).resumePending();
		expect(calls("prompt:")[0]).toContain(`${BLOCK_HEAD}\n채널: 배포 방`);
	});

	test("Teams 그룹 채팅과 모니터 오리진은 명령을 거부하고 아무것도 저장하지 않는다", async () => {
		const group = "teams/ch/t0123456789abcdef";
		await router.route(msg(group, "t0123456789abcdef:1", "!용도 그룹"));
		expect(answers(group)).toContain("그룹 채팅에서는");
		const monitor = "monitor/m1";
		const fromMonitor = msg(monitor, "m1:1", "!용도 모니터");
		await router.route(fromMonitor);
		expect(store.getInbound(fromMonitor.platformMessageId)?.opRef).toBe(`purpose:${fromMonitor.platformMessageId}`);
		expect(store.getPurpose("teams:t0123456789abcdef")).toBeUndefined();
		expect(calls("prompt:")).toEqual([]);
	});

	test("Teams 1:1은 메모를 받는다", async () => {
		await router.route(msg("teams/dm/t0123456789abcdef", "t0123456789abcdef:1", "!용도 개인 메모"));
		expect(store.getPurpose("teams:t0123456789abcdef")).toBe("개인 메모");
	});
});
