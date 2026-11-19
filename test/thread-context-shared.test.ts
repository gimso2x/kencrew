// Shared thread context (`OriginMailbox.#threadContext`) through a Discord thread source: the owner's first reply in a
// thread that this bot's post opened carries that post even when it is steered into a turn that is already running —
// the thread's later replies no longer qualify, so the steer is its only chance.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THREAD_CONTEXT_HEADER, type ThreadMessage } from "../src/core/mailbox";
import { OriginRouter, openBotStore } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

const BOT = "500000000000000000";
const DM = "200000000000000001";
const ORIGIN = `discord/dm/${DM}`;
const ROOT_ID = "1300000000000000000";
const clock = { now: () => Date.now() };

let dir: string;
let store: Store;
let router: OriginRouter;
let drivers: FakeOmpDriver[];
let roots: Map<string, ThreadMessage[]>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-thread-ctx-"));
	store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
	drivers = [];
	roots = new Map();
	const sessions = new FakeSessionStore();
	router = new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		log: createLogger({ sink: () => undefined, clock, redact }),
		statusProvider: () => "status",
		threadSource: new Map([
			[
				"discord" as const,
				{
					botUserId: () => BOT,
					replies: async (_channel: string, threadTs: string) => roots.get(threadTs) ?? [],
					mentionUser: (userId: string) => `<@${userId}>`,
				},
			],
		]),
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true });
			drivers.push(driver);
			return driver;
		},
	});
});

afterEach(async () => {
	for (const driver of drivers) driver.release();
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function msg(text: string, threadRef: string): InboundRecord {
	const id = `${DM}:${1_400_000_000_000_000_000n + BigInt(++counter)}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef };
}

test("a first owner reply steered into a running turn still carries the bot-posted root", async () => {
	roots.set(ROOT_ID, [
		{ ts: ROOT_ID, text: "⏰ ROOTPOST 오늘의 질문은 무엇인가요?", user: BOT, at: 1_700_000_000_000 },
	]);
	await router.route(msg("LONGTASK 긴 작업", `${DM}:1300000000000000099`));
	const driver = drivers[0];
	expect(driver?.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:LONGTASK 긴 작업"]);
	await router.route(msg("STEERREPLY 답입니다", `${DM}:${ROOT_ID}`));
	const steer = driver?.calls.find((c) => c.startsWith("steer:")) ?? "";
	expect(steer).toContain(THREAD_CONTEXT_HEADER);
	expect(steer).toContain("ROOTPOST 오늘의 질문은 무엇인가요?");
	expect(steer.endsWith("[현재 요청]\nSTEERREPLY 답입니다")).toBe(true);
});
