// One daemon on Discord (doc/plans/discord-channel.md TASK 4): a question is answered on Discord, the ledger keeps its
// thread_ref, and a fatal or late Discord gateway never takes the daemon down.
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
import { makeHome, OWNER, PendingDiscordTransport, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";

const DISCORD_DM = "123456789012345678"; // gitleaks:allow (fake snowflake)
const QUESTION = "700000000000000001";
const clock = { now: () => Date.now() };

/** A Discord transport whose gateway closes with 4014 (Message Content Intent off) before Ready. */
class FatalDiscordTransport extends WaitingDiscordTransport {
	override async start(_handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
		throw new DiscordGatewayFatalError(4014, "Disallowed intent(s)");
	}
}

let home: TestHome;
let daemon: Daemon | undefined;
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
	const sessions = new FakeSessionStore();
	const channels: ChannelBinding[] = [];
	if (discord !== undefined) {
		channels.push(new DiscordBinding(new DiscordChannel(discord, { ownerUserId: OWNER }), discordOptions));
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

beforeEach(() => {
	home = makeHome("ompbot-discord-daemon-");
	logs = [];
});

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	home.remove();
});

describe("Discord in one daemon", () => {
	test("a Discord DM is answered on Discord; the ledger row keeps its thread_ref", async () => {
		const discord = new WaitingDiscordTransport();
		await boot(home.config, discord);
		expect(logs.some((line) => line.includes("event=daemon_ready") && line.includes("discord=on"))).toBe(true);

		await discord.emitMessage({
			id: QUESTION,
			channel_id: DISCORD_DM,
			author: { id: OWNER },
			content: "디스코드 질문",
			type: 0,
		});
		await discord.waitForPosts((text) => text.includes("ECHO 디스코드 질문"));
		// The pump in flight also finishes the Discord status (delete ⏳, 👀 → ✅) before the next snapshot.
		await daemon?.pump();
		const answer = discord.posts((text) => text.includes("ECHO 디스코드 질문"))[0];
		expect(answer?.channelId).toBe(DISCORD_DM);
		expect(answer?.messageReference).toEqual({ messageId: QUESTION });
		expect(discord.calls.map((call) => call.method)).toContain("addReaction");

		const rows = daemon?.store.listDeliveries().map((row) => [row.originKey, row.threadRef, row.state]);
		expect(rows).toContainEqual([`discord/dm/${DISCORD_DM}`, `${DISCORD_DM}:${QUESTION}`, "confirmed"]);
	});

	test("a fatal gateway close (4014) is logged and, with no other adapter, refuses the start", async () => {
		await expect(boot(home.config, new FatalDiscordTransport())).rejects.toThrow(
			"every chat adapter failed to start: discord",
		);
		expect(logs.some((line) => line.includes("event=discord_start_failed") && line.includes("4014"))).toBe(true);
		expect(logged("event=daemon_ready")).toBe(false);
	});

	test("a gateway that never reaches Ready does not hold the daemon: pending, silence armed after the late Ready (qa-q #19)", async () => {
		const discord = new PendingDiscordTransport();
		await boot(home.config, discord, { startWaitMs: 10 });
		expect(logged("event=discord_start_pending")).toBe(true);
		expect(logged("event=daemon_ready")).toBe(true);
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
		await boot(home.config, discord);
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
	});

	test("a fatal close (4004) on the first connection is a failed adapter start, not a detach", async () => {
		class AuthFailedTransport extends WaitingDiscordTransport {
			override async start(_handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
				throw new DiscordGatewayFatalError(4004, "Authentication failed");
			}
		}
		await expect(boot(home.config, new AuthFailedTransport())).rejects.toThrow(
			"every chat adapter failed to start: discord",
		);
		expect(logged("event=adapter_start_failed")).toBe(true);
		expect(logged("event=adapter_detached")).toBe(false);
	});

	test("without channels.discord the daemon logs discord=off", async () => {
		await boot(home.config, undefined);
		expect(logs.some((line) => line.includes("event=daemon_ready") && line.includes("discord=off"))).toBe(true);
	});
});
