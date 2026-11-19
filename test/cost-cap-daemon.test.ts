// The daily ceiling at the daemon level: it only warns (one `cost_cap` gate notice), monitors keep firing, and
// `!budget` answers the totals; `!budget off` is not a command any more.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import type { OmpEvent } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { ledgerDay } from "../src/ops/cost-cap";
import { redact } from "../src/redact";
import { discordBinding, makeHome, OWNER_DM, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";

const ORIGIN = `discord/dm/${OWNER_DM}`;
const MINUTE = 60_000;
/** 2026-11-10 21:00 KST: the day is 20261110 and the next KST midnight is three hours of fake time away. */
const T0 = Date.parse("2026-11-10T12:00:00Z");

/** A fake driver whose `prompted` settles once omp accepted the turn's prompt: events are only priced after that. */
class PromptedDriver extends FakeOmpDriver {
	readonly #prompted = Promise.withResolvers<void>();
	readonly prompted: Promise<void> = this.#prompted.promise;

	override async prompt(text: string): Promise<string> {
		const answer = await super.prompt(text);
		this.#prompted.resolve();
		return answer;
	}
}

/** Waits (bounded macrotask hops, no clock) for a ledger state the daemon reaches right after a driver call returns. */
async function hopsUntil(done: () => boolean, hops = 200): Promise<void> {
	for (let hop = 0; hop < hops && !done(); hop += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	if (!done()) throw new Error("the daemon never reached the awaited state");
}

let home: TestHome;
let clock: { t: number; now(): number };
let lines: string[];
let transport: WaitingDiscordTransport;
let daemon: Daemon | undefined;
let drivers: PromptedDriver[];

beforeEach(() => {
	home = makeHome("ompbot-cost-cap-daemon-");
	clock = {
		t: T0,
		now() {
			return this.t;
		},
	};
	lines = [];
	transport = new WaitingDiscordTransport();
	daemon = undefined;
	drivers = [];
});

afterEach(async () => {
	for (const driver of drivers) driver.release();
	await daemon?.stop();
	home.remove();
});

/** A daemon over this home with the given ceilings; `sweepMs` is long so only explicit `sweep()` calls run (each one also runs the gate sweep). */
async function boot(costCap: { turnUsd?: number; dailyUsd?: number }, holdTurns = false): Promise<Daemon> {
	const sessions = new FakeSessionStore();
	const d = new Daemon({
		config: { ...home.config, costCap },
		channels: [discordBinding(transport)],
		clock,
		log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		sweepMs: 3_600_000,
		gateSweepMs: 1,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => {
			const driver = new PromptedDriver({ sessionDir, store: sessions, holdTurns });
			drivers.push(driver);
			return driver;
		},
	});
	daemon = d;
	await d.start();
	return d;
}

const gateNotices = (): string[] =>
	transport.posts((text) => text.includes("cost_cap")).map((post) => post.content ?? "");
const ownerNoticeCount = (): number => transport.posts((text) => text.includes("하루 상한")).length;

describe("daily cap: a warning, not a brake", () => {
	/** A daemon over `dailyUsd: 10` that already spent $12 today and has a per-minute monitor. */
	async function overCap(): Promise<{ daemon: Daemon; monitorId: string }> {
		const d = await boot({ dailyUsd: 10 });
		d.store.setOwnerHome({ platform: "discord", conversationId: OWNER_DM });
		d.store.addDailyUsage({ day: ledgerDay(clock.t, "Asia/Seoul"), originKey: ORIGIN, cost: 12, calls: 3 });
		const monitor = d.store.monitors.addMonitor({
			name: "watch",
			trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
			instruction: "check the thing",
			overlap: "queue",
			enabled: true,
		});
		return { daemon: d, monitorId: monitor.id };
	}

	const events = (d: Daemon, monitorId: string) =>
		d.store.monitors.listEvents().filter((event) => event.monitorId === monitorId);

	test("monitors keep firing over the cap and the owner hears the gate notice exactly once", async () => {
		const { daemon: d, monitorId } = await overCap();
		clock.t += 3 * MINUTE;
		await d.sweep();
		await transport.waitForPosts((text) => text.includes("cost_cap"));
		expect(events(d, monitorId).length).toBeGreaterThan(0);
		expect(events(d, monitorId).filter((event) => event.payload?.startsWith("budget") === true)).toHaveLength(0);
		expect(gateNotices()).toHaveLength(1);
		expect(gateNotices()[0]).toContain("today=12.00 cap=10.00");

		clock.t += MINUTE;
		await d.sweep();
		expect(gateNotices()).toHaveLength(1);
		expect(ownerNoticeCount()).toBe(0);
	});

	test("!budget answers today's total, its top origins and both ceilings", async () => {
		const d = await boot({ turnUsd: 20, dailyUsd: 300 });
		d.store.addDailyUsage({ day: ledgerDay(clock.t, "Asia/Seoul"), originKey: ORIGIN, cost: 12.5, calls: 3 });
		d.store.addDailyUsage({ day: ledgerDay(clock.t, "Asia/Seoul"), originKey: "monitor/daily", cost: 1.25, calls: 1 });

		await d.inject({ origin: ORIGIN, asOwner: true, text: "!budget" });
		await transport.waitForPosts((text) => text.includes("하루 $300.00"));
		const reply = transport.posts((text) => text.includes("하루 $300.00"))[0]?.content ?? "";
		expect(reply).toContain(`오늘(${ledgerDay(clock.t, "Asia/Seoul")}) 비용(정가 환산) $13.75`);
		expect(reply).toContain("턴 $20.00");
		expect(reply).toContain(`${ORIGIN} $12.50`);
		expect(reply).toContain("상한까지 $286.25 남았습니다");
	});

	/** A `message_end` carrying one assistant call's cost, as omp reports it inside a turn. */
	const usageEvent = (total: number): OmpEvent => ({
		type: "message_end",
		message: { role: "assistant", content: [], usage: { input: 10, output: 1, cost: { total } } },
	});

	test("a turn over turnUsd warns its own thread once; a monitor's turn only logs", async () => {
		const d = await boot({ turnUsd: 1 }, true);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "비싼 작업" });
		const chat = drivers.at(-1);
		if (chat === undefined) throw new Error("the owner turn started no driver");
		await chat.prompted;
		// The mailbox holds the running turn once its row is `dispatched`: events are priced from then on.
		await hopsUntil(() => d.store.listInbound({ originKey: ORIGIN }).every((row) => row.state === "dispatched"));
		chat.emitTestEvent(usageEvent(1.2));
		chat.emitTestEvent(usageEvent(0.5));
		await transport.waitForPosts((text) => text.includes("턴 상한 $1.00"));
		expect(transport.posts((text) => text.includes("턴 상한 $1.00"))).toHaveLength(1);
		chat.release();

		const monitor = d.store.monitors.addMonitor({
			name: "watch",
			trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
			instruction: "check the thing",
			overlap: "queue",
			enabled: true,
		});
		clock.t += MINUTE;
		await d.sweep();
		await hopsUntil(() => drivers.length > 1);
		const run = drivers.at(-1);
		if (run === undefined) throw new Error(`monitor ${monitor.id} started no driver`);
		await run.prompted;
		await hopsUntil(() => events(d, monitor.id).some((event) => event.stage === "dispatched"));
		// Events are priced once the monitor turn's own inbound row is `dispatched` (as for the owner turn above).
		await hopsUntil(() =>
			d.store.listInbound({ originKey: `monitor/${monitor.id}` }).every((row) => row.state === "dispatched"),
		);
		run.emitTestEvent(usageEvent(1.5));
		// The daemon prices the event (and writes the log line) a few hops after the emit: await the exact line.
		await hopsUntil(() =>
			lines.some((line) => line.includes("event=cost_cap_turn_soft") && line.includes("origin=monitor/")),
		);
		expect(transport.posts((text) => text.includes("턴 상한 $1.00"))).toHaveLength(1);
		run.release();
	});
});
