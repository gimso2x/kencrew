import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import { Daemon } from "../src/daemon/daemon";
import { startIpcServer } from "../src/daemon/ipc";
import { readStatusFromDb } from "../src/daemon/status";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import { acceptanceItems } from "../src/tasks/docs";
import { openTaskLedger, TaskLedger } from "../src/tasks/ledger";
import { discordBinding, makeHome, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { runCliCapture } from "./helpers/daemon-process";

let home: TestHome;
const stops: Array<() => void> = [];

beforeEach(() => {
	home = makeHome("ompbot-cli-qa-j-");
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	home.remove();
});

/** A socket that reads the request and closes without answering: the daemon "took it but gave no answer". */
function silentDaemon(): void {
	const server = Bun.listen({
		unix: join(home.dir, "ompbot.sock"),
		socket: {
			data(socket) {
				socket.end();
			},
		},
	});
	stops.push(() => server.stop(true));
}

function registerTask(dbPath: string): string {
	const ledger = openTaskLedger(dbPath, "Asia/Seoul");
	const row = ledger.register({
		title: "t",
		risk: "L2",
		originKey: "discord/dm/200000000000000001/t/700000000000000001",
		threadRef: "200000000000000001:700000000000000001",
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["a"]),
	});
	ledger.close();
	return row.taskId;
}

describe("inject and tasks against a silent daemon (qa-j n24, n59)", () => {
	test("inject says the request may have been delivered, not that the daemon is unreachable", async () => {
		silentDaemon();
		const result = await runCliCapture(home.dir, [
			"inject",
			"--origin",
			"discord/dm/200000000000000001",
			"--as-owner",
			"--text",
			"hi",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no daemon answer");
		expect(result.stderr).not.toContain("not reachable");
	});

	test("tasks close, pause and resume do not report an unanswered request as unreachable", async () => {
		const id = registerTask(join(home.dir, "ompbot.db"));
		silentDaemon();
		const close = await runCliCapture(home.dir, ["tasks", "close", id, "--as", "cancelled"]);
		expect(close.code).toBe(0);
		expect(close.stderr).toContain("no daemon answer");
		expect(close.stderr).not.toContain("not reachable");
		const ledger = openTaskLedger(join(home.dir, "ompbot.db"), "Asia/Seoul");
		const second = ledger.register({
			title: "t2",
			risk: "L2",
			originKey: "discord/dm/200000000000000001/t/700000000000000002",
			threadRef: "200000000000000001:700000000000000002",
			host: null,
			repo: "/r/repo",
			acceptance: acceptanceItems(["a"]),
		});
		ledger.close();
		for (const sub of ["pause", "resume"]) {
			const result = await runCliCapture(home.dir, ["tasks", sub, second.taskId]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("no daemon answer");
			expect(result.stderr).not.toContain("not reachable");
		}
		const check = openTaskLedger(join(home.dir, "ompbot.db"), "Asia/Seoul");
		expect(check.isPaused(check.get(second.taskId) as never)).toBe(false);
		check.close();
	});
});

describe("tasks CLI (qa-j n58, n122)", () => {
	test("tasks list and show read a ledger that cannot be written", async () => {
		const dbPath = join(home.dir, "ompbot.db");
		// A plain (non-WAL) file: the old write-mode open had to switch it to WAL and failed on a read-only one.
		const db = new Database(dbPath, { create: true, strict: true });
		db.close();
		const id = registerPlainLedgerTask(dbPath);
		chmodSync(dbPath, 0o444);
		const list = await runCliCapture(home.dir, ["tasks", "list", "--json"]);
		expect(list.code, list.stderr).toBe(0);
		expect(JSON.parse(list.stdout).tasks).toHaveLength(1);
		const show = await runCliCapture(home.dir, ["tasks", "show", id]);
		expect(show.stderr).not.toContain("SQLiteError");
	});

	test("tasks list on a ledger without a tasks table is empty and creates nothing", async () => {
		const dbPath = join(home.dir, "ompbot.db");
		new Database(dbPath, { create: true, strict: true }).close();
		const list = await runCliCapture(home.dir, ["tasks", "list"]);
		expect(list.code, list.stderr).toBe(0);
		expect(list.stdout).toBe("no tasks\n");
	});

	test("resume without a daemon on a TASK that was never paused says so and does not claim a resume", async () => {
		const id = registerTask(join(home.dir, "ompbot.db"));
		const result = await runCliCapture(home.dir, ["tasks", "resume", id]);
		expect(result.code).toBe(0);
		const out = JSON.parse(result.stdout) as { ok: boolean; resumed: boolean; paused: boolean; note: string };
		expect(out.resumed).toBe(false);
		expect(out.paused).toBe(false);
		expect(out.note).toContain("멈춘 상태가 아닙니다");
	});
});

/** One task in a plain (journal_mode=delete) ledger file. */
function registerPlainLedgerTask(dbPath: string): string {
	const db = new Database(dbPath, { strict: true });
	const ledger = new TaskLedger(db, { clock: { now: () => Date.now() }, timezone: "Asia/Seoul" });
	const row = ledger.register({
		title: "t",
		risk: "L2",
		originKey: "discord/dm/200000000000000001/t/700000000000000001",
		threadRef: "200000000000000001:700000000000000001",
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["a"]),
	});
	ledger.close();
	return row.taskId;
}

describe("status (qa-j n15, n16)", () => {
	test("a monitor row that does not parse does not blank the counts or open ledger_unreadable", () => {
		const dbPath = join(home.dir, "ompbot.db");
		const store = openBotStore(dbPath, { now: () => Date.now() }, "Asia/Seoul");
		store.close();
		const db = new Database(dbPath, { strict: true });
		db.run(
			`INSERT INTO monitors (id, name, trigger_json, instruction, cursor_at, created_at, updated_at)
			 VALUES ('m1', 'bad', 'not json', 'x', 0, 0, 0)`,
		);
		db.close();
		const report = readStatusFromDb(dbPath, "v", "Asia/Seoul", {}, IDLE_HOST_LOAD);
		expect(report.openGates.map((gate) => gate.name)).not.toContain("ledger_unreadable");
		expect(report.monitors.count).toBe(1);
		expect(report.monitors.next).toBeNull();
	});

	test("a daemon reply that is not a status report falls back to the database report", async () => {
		const dbPath = join(home.dir, "ompbot.db");
		openBotStore(dbPath, { now: () => Date.now() }, "Asia/Seoul").close();
		const server = startIpcServer(join(home.dir, "ompbot.sock"), async () => ({ ok: true, status: {} }));
		stops.push(() => server.stop());
		const result = await runCliCapture(home.dir, ["status", "--json"]);
		expect(result.code, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout) as { daemonRunning: boolean; origins: unknown[] };
		expect(report.daemonRunning).toBe(false);
		expect(Array.isArray(report.origins)).toBe(true);
	});
});

describe("inject origin ids (qa-j n26)", () => {
	let daemon: Daemon;
	let ownerHome: TestHome;
	beforeEach(async () => {
		ownerHome = makeHome("ompbot-inject-ids-");
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: ownerHome.config,
			channels: [discordBinding(new WaitingDiscordTransport())],
			clock: { now: () => Date.now() },
			log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact: (text) => text }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: () => new FakeOmpDriver({ sessionDir: join(ownerHome.dir, "s"), store: sessions }),
		});
		await daemon.start();
	});
	afterEach(async () => {
		await daemon.stop();
		ownerHome.remove();
	});

	test("an origin whose id is not a snowflake, or whose platform is removed, is refused", async () => {
		for (const origin of ["discord/dm/U0123456789", "discord/ch/D0123456789", "slack/dm/D0123456789"]) {
			await expect(daemon.inject({ origin, asOwner: true, text: "hi" })).rejects.toThrow(
				"inject origin must be discord/dm/<id> or discord/ch/<id>",
			);
		}
		const ok = await daemon.inject({ origin: "discord/dm/200000000000000001", asOwner: true, text: "hi" });
		expect(ok.nonce).not.toBe("");
	});
});
