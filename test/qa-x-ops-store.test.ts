import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import { openMonitorLedger } from "../src/monitors/ledger";
import { exportMonitors } from "../src/monitors/portable";
import { parseMonitorSpec } from "../src/monitors/spec";
import { writeFreeze } from "../src/ops/freeze";
import { gcSessions } from "../src/ops/gc";
import { runRestore } from "../src/ops/restore";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { killSpawned, runMain } from "./helpers/daemon-process";

const cleanups: Array<() => void> = [];

afterEach(() => {
	killSpawned();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function home(prefix: string): TestHome {
	const h = makeHome(prefix);
	cleanups.push(h.remove);
	return h;
}

describe("qa-x #9: freeze with a FIFO at FROZEN.tmp", () => {
	test("freeze completes instead of blocking on the FIFO", async () => {
		const h = home("qa-x-freeze-");
		const fifo = join(h.dir, "FROZEN.tmp");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		// A blocked open never returns, so the write runs in a child with a hard timeout.
		const script = `import { writeFreeze } from ${JSON.stringify(join(import.meta.dir, "../src/ops/freeze.ts"))};
writeFreeze(${JSON.stringify(h.dir)}, { reason: "x", by: "cli", now: 0 });`;
		const child = Bun.spawnSync(["bun", "-e", script], { timeout: 15_000, killSignal: "SIGKILL" });
		expect(child.exitCode).toBe(0);
		expect(JSON.parse(readFileSync(join(h.dir, "FROZEN"), "utf8")).reason).toBe("x");
		expect(existsSync(fifo)).toBe(false);
	}, 30_000);

	test("a directory at FROZEN.tmp is a clear error and left alone", () => {
		const h = home("qa-x-freeze-dir-");
		mkdirSync(join(h.dir, "FROZEN.tmp"));
		writeFileSync(join(h.dir, "FROZEN.tmp", "keep"), "x");
		expect(() => writeFreeze(h.dir, { by: "cli", now: 0 })).toThrow("FROZEN.tmp is not a regular file");
		expect(existsSync(join(h.dir, "FROZEN.tmp", "keep"))).toBe(true);
		expect(existsSync(join(h.dir, "FROZEN"))).toBe(false);
	});
});

describe("qa-x #10: status without a database", () => {
	test("a frozen home without ompbot.db still shows FROZEN (rc stays 1)", async () => {
		const h = home("qa-x-status-");
		writeFreeze(h.dir, { reason: "점검", by: "cli", now: Date.parse("2026-11-20T00:00:00Z") });
		const result = await runMain(h.dir, ["status"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no database");
		expect(result.stdout).toContain("FROZEN · 2026-11-20T00:00:00.000Z · cli · 점검");
	});

	test("--json carries the frozen field", async () => {
		const h = home("qa-x-status-json-");
		writeFreeze(h.dir, { reason: "r", by: "cli", now: 0 });
		const result = await runMain(h.dir, ["status", "--json"]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout).frozen).toMatchObject({ by: "cli", reason: "r" });
	});
});

describe("qa-x #11: restore picks up a -wal that appears before the lock", () => {
	test("the -wal born while the daemon probe runs moves aside with the db", async () => {
		const h = home("qa-x-restore-");
		const dbPath = join(h.dir, "ompbot.db");
		const seed = () => {
			const db = new Database(dbPath, { create: true, strict: true });
			for (const table of ["origins", "inbound", "deliveries"]) db.run(`CREATE TABLE IF NOT EXISTS ${table} (id)`);
			db.close();
		};
		seed();
		const backup = join(h.dir, "backup.db");
		writeFileSync(backup, readFileSync(dbPath));
		const result = await runRestore({
			homeDir: h.dir,
			source: backup,
			yes: true,
			probeDaemon: async () => {
				writeFileSync(`${dbPath}-wal`, "late wal");
				throw new Error("nothing listening");
			},
		});
		expect(result.applied).toBe(true);
		expect(existsSync(`${dbPath}-wal`)).toBe(false);
		const pre = join(result.plan.preRestoreDir, "ompbot.db-wal");
		expect(readFileSync(pre, "utf8")).toBe("late wal");
	});
});

describe("qa-x #12: gc checks the schema before deleting", () => {
	test("a newer-schema ledger aborts gc with the old epoch directory still there", () => {
		const h = home("qa-x-gc-");
		const root = join(h.dir, "sessions");
		const origin = "discord/dm/200000000000000001";
		const store = openBotStore(join(h.dir, "ompbot.db"), { now: () => Date.now() }, "Asia/Seoul");
		store.ensureOrigin(origin, sessionDirFor(root, origin, 1));
		store.newEpoch(origin, sessionDirFor(root, origin, 2));
		store.close();
		const old = sessionDirFor(root, origin, 1);
		mkdirSync(old, { recursive: true });
		writeFileSync(join(old, "session.jsonl"), "{}\n");
		const past = new Date(Date.now() - 90 * 86_400_000);
		utimesSync(join(old, "session.jsonl"), past, past);
		utimesSync(old, past, past);
		const db = new Database(join(h.dir, "ompbot.db"));
		db.run("PRAGMA user_version = 9999");
		db.close();
		expect(() => gcSessions({ homeDir: h.dir, retentionDays: 30, now: Date.now() })).toThrow("newer_schema");
		expect(existsSync(old)).toBe(true);
		expect(readdirSync(dirname(old))).toContain("e1");
	});
});

describe("qa-x #40: monitor name length counts characters", () => {
	const ctx = { scriptsRoot: "/tmp", workspaceDir: "/tmp", defaultTimezone: "Asia/Seoul" };
	const spec = (name: string) => ({ name, trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "x" });

	test("80 emoji are accepted, 81 are refused", () => {
		expect(parseMonitorSpec(spec("😀".repeat(80)), ctx).name).toBe("😀".repeat(80));
		expect(() => parseMonitorSpec(spec("😀".repeat(81)), ctx)).toThrow("1-80 characters");
	});
});

describe("qa-x #41/#76: monitors add on an uninitialised home", () => {
	test("one line, no raw SQLiteError", async () => {
		const missing = join(tempDir("qa-x-nohome-"), "absent");
		const result = await runMain(missing, [
			"monitors",
			"add",
			"--json",
			JSON.stringify({ name: "m", trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "x" }),
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("monitors: home not initialized\n");
	});
});

describe("qa-x #75: monitors export --dir keeps non-spec json", () => {
	test("config.json stays, a stale exported spec goes", () => {
		const h = home("qa-x-export-");
		mkdirSync(join(h.dir, "scripts"));
		const ctx = {
			scriptsRoot: join(h.dir, "scripts"),
			workspaceDir: h.config.workspaceDir,
			defaultTimezone: "Asia/Seoul",
		};
		const ledger = openMonitorLedger(join(h.dir, "ompbot.db"));
		cleanups.push(() => ledger.close());
		ledger.addMonitor(
			parseMonitorSpec({ name: "live", trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "x" }, ctx),
		);
		const out = tempDir("qa-x-export-out-");
		const stale = { name: "gone", trigger: { kind: "cron", schedule: "0 8 * * *" }, instruction: "y" };
		writeFileSync(join(out, "gone.json"), JSON.stringify(stale));
		writeFileSync(join(out, "config.json"), JSON.stringify({ keep: true }));
		writeFileSync(join(out, "broken.json"), "{not json");
		const result = exportMonitors(ledger, out, ctx, {});
		expect(result.removed).toBe(1);
		expect(readdirSync(out).sort()).toEqual(["broken.json", "config.json", "live.json"]);
	});
});

describe("qa-x #78: trailing whitespace output stays bounded", () => {
	test("a long whitespace tail hashes like the trimmed text and does not pile up in memory", () => {
		const dir = tempDir("qa-x-script-");
		const scripts = join(dir, "scripts");
		mkdirSync(scripts);
		const script = join(scripts, "ws.js");
		writeFileSync(
			script,
			`#!/usr/bin/env bun
const chunk = " ".repeat(1 << 20);
process.stdout.write("a");
for (let i = 0; i < 8; i++) process.stdout.write(chunk);
process.stdout.write("b");
for (let i = 0; i < 400; i++) process.stdout.write(chunk);
`,
			{ mode: 0o755 },
		);
		const runner = `import { runScript } from ${JSON.stringify(join(import.meta.dir, "../src/monitors/script.ts"))};
const r = await runScript([${JSON.stringify(script)}], { scriptsRoot: ${JSON.stringify(scripts)}, cwd: ${JSON.stringify(dir)}, timeoutMs: 60000 });
console.log(JSON.stringify({ hash: r.outputHash, rssMb: process.resourceUsage().maxRSS / 1024 }));`;
		const child = Bun.spawnSync(["bun", "-e", runner], { timeout: 90_000, killSignal: "SIGKILL" });
		expect(child.exitCode).toBe(0);
		const { hash, rssMb } = JSON.parse(child.stdout.toString()) as { hash: string; rssMb: number };
		const want = new Bun.CryptoHasher("sha256");
		want.update(`a${" ".repeat(8 << 20)}b`);
		expect(hash).toBe(want.digest("hex"));
		// 400 MB of trailing spaces held as pending text would put the peak far above this.
		expect(rssMb).toBeLessThan(300);
	}, 120_000);
});
