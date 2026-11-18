// One daemon with Slack and Discord side by side (doc/plans/discord-channel.md TASK 4): each platform's question is
// answered on its own platform only, the ledger tells them apart by thread_ref, and a fatal Discord gateway leaves
// Slack running.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChannelBinding } from "../src/channel/adapter";
import type { OmpbotConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { DiscordGatewayFatalError, type DiscordHandlers } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import {
	DISCORD_OWNER,
	makeHome,
	OWNER,
	PendingDiscordTransport,
	type TestHome,
	WaitingDiscordTransport,
	WaitingTransport,
	withDiscord,
} from "./helpers/bot-home";

const DISCORD_DM = "123456789012345678"; // gitleaks:allow (fake snowflake)
const QUESTION = "700000000000000001";
const SLACK_DM = "D1";
const clock = { now: () => Date.now() };

/** A Discord transport whose gateway closes with 4014 (Message Content Intent off) before Ready. */
class FatalDiscordTransport extends WaitingDiscordTransport {
	override async start(_handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
		throw new DiscordGatewayFatalError(4014, "Disallowed intent(s)");
	}
}

let home: TestHome;
let daemon: Daemon | undefined;
let slack: WaitingTransport;
let logs: string[];

const logWaiters = new Set<() => void>();

/** Resolves once a log line holds `needle` (bounded, no polling). */
function waitForLog(needle: string, timeoutMs = 10_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const check = (): void => {
		if (!logs.some((line) => line.includes(needle))) return;
		clearTimeout(timer);
		logWaiters.delete(check);
		resolve();
	};
	const timer = setTimeout(() => {
		logWaiters.delete(check);
		reject(new Error(`timed out waiting for log ${needle}`));
	}, timeoutMs);
	logWaiters.add(check);
	check();
	return promise;
}

const logged = (needle: string): boolean => logs.some((line) => line.includes(needle));

async function boot(
	config: OmpbotConfig,
	discord: WaitingDiscordTransport | undefined,
	discordOptions: { startWaitMs?: number } = {},
): Promise<void> {
	slack = new WaitingTransport();
	const sessions = new FakeSessionStore();
	const channels: ChannelBinding[] = [new SlackBinding(new SlackChannel(slack))];
	if (discord !== undefined) {
		channels.push(new DiscordBinding(new DiscordChannel(discord, { ownerUserId: DISCORD_OWNER }), discordOptions));
	}
	daemon = new Daemon({
		config,
		channels,
		log: createLogger({
			sink: (line) => {
				logs.push(line);
				for (const waiter of [...logWaiters]) waiter();
			},
			clock,
			redact,
		}),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
}

function slackQuestion(text: string, ts: string): Promise<void> {
	return slack.emitMessage({ type: "message", channel: SLACK_DM, channel_type: "im", user: OWNER, text, ts });
}

beforeEach(() => {
	home = makeHome("ompbot-discord-daemon-");
	logs = [];
});

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	home.remove();
});

describe("Slack and Discord in one daemon", () => {
	test("a Discord DM is answered on Discord only, a Slack DM on Slack only; thread_ref tells the rows apart", async () => {
		const discord = new WaitingDiscordTransport();
		await boot(withDiscord(home), discord);
		expect(logs.some((line) => line.includes("event=daemon_ready") && line.includes("discord=on"))).toBe(true);

		const slackBefore = slack.calls.length;
		await discord.emitMessage({
			id: QUESTION,
			channel_id: DISCORD_DM,
			author: { id: DISCORD_OWNER },
			content: "디스코드 질문",
			type: 0,
		});
		await discord.waitForPosts((text) => text.includes("ECHO 디스코드 질문"));
		// The pump in flight also finishes the Discord status (delete ⏳, 👀 → ✅) before the next snapshot.
		await daemon?.pump();
		const answer = discord.posts((text) => text.includes("ECHO 디스코드 질문"))[0];
		expect(answer?.channelId).toBe(DISCORD_DM);
		expect(answer?.messageReference).toEqual({ messageId: QUESTION });
		expect(slack.calls.slice(slackBefore)).toHaveLength(0);

		const discordBefore = discord.calls.length;
		await slackQuestion("슬랙 질문", "1700.000001");
		await slack.waitForPosts((text) => text.includes("ECHO 슬랙 질문"));
		await daemon?.pump();
		expect(discord.calls.slice(discordBefore)).toHaveLength(0);
		expect(discord.calls.map((call) => call.method)).toContain("addReaction");

		const rows = daemon?.store.listDeliveries().map((row) => [row.originKey, row.threadRef, row.state]);
		expect(rows).toContainEqual([`discord/dm/${DISCORD_DM}`, `${DISCORD_DM}:${QUESTION}`, "confirmed"]);
		expect(rows).toContainEqual([`slack/dm/${SLACK_DM}`, `${SLACK_DM}:1700.000001`, "confirmed"]);
	});

	test("a fatal gateway close (4014) stops Discord only: the daemon starts and Slack keeps answering", async () => {
		await boot(withDiscord(home), new FatalDiscordTransport());
		expect(logs.some((line) => line.includes("event=discord_start_failed") && line.includes("4014"))).toBe(true);
		await slackQuestion("디스코드가 죽어도", "1700.000002");
		await slack.waitForPosts((text) => text.includes("ECHO 디스코드가 죽어도"));
	});

	test("a gateway that never reaches Ready does not hold the daemon: pending, Slack answers, silence armed after the late Ready (qa-q #19)", async () => {
		const discord = new PendingDiscordTransport();
		await boot(withDiscord(home), discord, { startWaitMs: 10 });
		expect(logged("event=discord_start_pending")).toBe(true);
		expect(logged("event=daemon_ready")).toBe(true);
		expect(logged("event=peer_silence_armed")).toBe(false);
		await slackQuestion("디스코드 대기 중", "1700.000003");
		await slack.waitForPosts((text) => text.includes("ECHO 디스코드 대기 중"));
		expect(logged("event=peer_silence_armed")).toBe(false);

		discord.release();
		await waitForLog("event=peer_silence_armed");
		const ready = logs.findIndex((line) => line.includes("event=discord_ready"));
		expect(ready).toBeGreaterThanOrEqual(0);
		expect(logs.findIndex((line) => line.includes("event=peer_silence_armed"))).toBeGreaterThan(ready);
		expect(logs[ready]).toContain("500000000000000000");
	});

	test("a fatal close (4004) after Ready drops Discord: the pump claims no more Discord rows and none turns undelivered (qa-q #20)", async () => {
		const discord = new WaitingDiscordTransport();
		await boot(withDiscord(home), discord);
		discord.emitFatal(new DiscordGatewayFatalError(4004, "Authentication failed"));
		await waitForLog("event=adapter_detached");

		const row = daemon?.store.recordAnswer({
			originKey: `discord/dm/${DISCORD_DM}`,
			opRef: "op-after-fatal",
			threadRef: `${DISCORD_DM}:${QUESTION}`,
			parts: ["늦은 답"],
		});
		expect(row).toHaveLength(1);
		const before = discord.calls.length;
		await daemon?.pump();
		expect(discord.calls.slice(before)).toHaveLength(0);
		const state = daemon?.store.listDeliveries().find((r) => r.opRef === "op-after-fatal")?.state;
		expect(state).toBe("pending");
		await slackQuestion("슬랙은 계속", "1700.000004");
		await slack.waitForPosts((text) => text.includes("ECHO 슬랙은 계속"));
	});

	test("a fatal close (4004) on the first connection leaves the daemon running on Slack", async () => {
		class AuthFailedTransport extends WaitingDiscordTransport {
			override async start(_handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
				throw new DiscordGatewayFatalError(4004, "Authentication failed");
			}
		}
		await boot(withDiscord(home), new AuthFailedTransport());
		expect(logged("event=adapter_start_failed")).toBe(true);
		expect(logged("event=adapter_detached")).toBe(false);
		await slackQuestion("첫 연결 4004", "1700.000005");
		await slack.waitForPosts((text) => text.includes("ECHO 첫 연결 4004"));
	});

	test("without channels.discord the daemon logs discord=off", async () => {
		await boot(home.config, undefined);
		expect(logs.some((line) => line.includes("event=daemon_ready") && line.includes("discord=off"))).toBe(true);
	});
});
