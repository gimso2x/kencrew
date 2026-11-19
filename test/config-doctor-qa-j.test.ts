import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCommand } from "../src/cli/index";
import { renderUnit, unitsCommand } from "../src/cli/units";
import { loadConfig } from "../src/config";
import { checkBackupBundle } from "../src/daemon/doctor";
import type { ProcessRunner } from "../src/dispatch/omp";
import { runBackup, STAMP_FILE } from "../src/ops/backup";
import { collectGates } from "../src/ops/gates";
import { seedDb } from "./helpers/backup-fixtures";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { runBounded } from "./helpers/bounded-child";

const SRC = join(import.meta.dir, "..", "src");
const mod = (path: string): string => JSON.stringify(join(SRC, path));
/**
 * A FIFO read would block the child for good, so it runs bounded (`runBounded`'s default limit). The test's own
 * timeout sits above that limit: a child started on a machine busy with the parallel full suite needs more than 5s.
 */
const CHILD_TEST_MS = 30_000;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-qa-j-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function mkfifo(path: string): void {
	expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
}

describe("secret and journal reads refuse a FIFO (qa-j #2 #10)", () => {
	test(
		"#2 a FIFO in a token file's place is a config error, not a hang",
		async () => {
			const home = makeHome("ompbot-qa-j-secret-");
			try {
				const token = join(home.dir, "secrets", "discord-bot-token");
				rmSync(token);
				mkfifo(token);
				chmodSync(token, 0o600);
				const result = await runBounded(
					`const { loadConfig } = await import(${mod("config.ts")});
				 try { loadConfig(${JSON.stringify(home.dir)}); console.log("loaded"); } catch (e) { console.log(e.code); }`,
				);
				expect(result.timedOut).toBe(false);
				expect(result.stdout.trim()).toBe("secret_missing");
			} finally {
				home.remove();
			}
		},
		CHILD_TEST_MS,
	);

	test(
		"#10 a FIFO in the rollback journal's place is an unreadable journal, not a hang",
		async () => {
			const { CODE_ROLLBACK_JOURNAL } = await import("../src/ops/apply");
			mkfifo(join(dir, CODE_ROLLBACK_JOURNAL));
			const result = await runBounded(
				`const { readCodeRollbackJournal } = await import(${mod("ops/apply.ts")});
			 try { readCodeRollbackJournal(${JSON.stringify(dir)}); console.log("read"); } catch (e) { console.log("threw " + e.message); }`,
			);
			expect(result.timedOut).toBe(false);
			expect(result.stdout).toContain("threw");
		},
		CHILD_TEST_MS,
	);
});

describe("gate stamps (qa-j #17 #18)", () => {
	test(
		"#17 a FIFO in the place of a heartbeat, herdr-health, unfrozen-at or FROZEN never blocks",
		async () => {
			for (const name of ["sweep-heartbeat", "herdr-health", "unfrozen-at", "FROZEN"]) mkfifo(join(dir, name));
			const result = await runBounded(
				`const { readSweepHeartbeat } = await import(${mod("daemon/heartbeat.ts")});
			 const { readHerdrHealth } = await import(${mod("ops/herdr-health.ts")});
			 const { readUnfrozenAt, readFreeze } = await import(${mod("ops/freeze.ts")});
			 const home = ${JSON.stringify(dir)};
			 console.log(JSON.stringify([readSweepHeartbeat(home) ?? null, readHerdrHealth(home) ?? null, readUnfrozenAt(home) ?? null, readFreeze(home)?.reason]));`,
			);
			expect(result.timedOut).toBe(false);
			expect(JSON.parse(result.stdout.trim())).toEqual([null, null, null, "FROZEN unreadable"]);
		},
		CHILD_TEST_MS,
	);

	test("#18 monitors_stalled without any heartbeat stamp is unknown (stamp=missing), not closed heartbeat=old", () => {
		const db = new Database(join(dir, "ompbot.db"), { create: true, strict: true });
		db.run("CREATE TABLE inbound (platform_message_id TEXT, state TEXT, dispatched_at INTEGER)");
		db.run("CREATE TABLE deliveries (state TEXT, next_at INTEGER)");
		db.close();
		const gate = collectGates({ homeDir: dir, now: Date.now(), diskPaths: [] }).find(
			(g) => g.name === "monitors_stalled",
		);
		expect(gate).toEqual({ name: "monitors_stalled", state: "unknown", detail: "stamp=missing" });
	});
});

describe("doctor (qa-j #11 #12 #13 #107)", () => {
	let home: TestHome;
	beforeEach(() => {
		home = makeHome("ompbot-qa-j-doctor-");
	});
	afterEach(() => home.remove());

	function writeHosts(entry: Record<string, unknown>): void {
		const path = join(home.dir, "config.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...config, herdr: {}, dispatchHosts: { h: { ssh: "h", ...entry } } }), {
			mode: 0o600,
		});
	}

	test("#11 #107 an empty or control-character herdrBin / workDir fails config validation", () => {
		for (const entry of [{ herdrBin: "" }, { workDir: "" }, { herdrBin: "he\u0000rdr" }, { workDir: "/a\u0000b" }]) {
			writeHosts(entry);
			const field = Object.keys(entry)[0];
			expect(() => loadConfig(home.dir), JSON.stringify(entry)).toThrow(`dispatchHosts.h.${field}`);
		}
		writeHosts({ herdrBin: "/opt/herdr", workDir: "~/w" });
		expect(loadConfig(home.dir).dispatchHosts?.h?.herdrBin).toBe("/opt/herdr");
	});

	test("#12 doctor's ssh and herdr children get no Slack, bot or git variables", async () => {
		writeHosts({});
		const seen: Array<Record<string, string> | undefined> = [];
		const run: ProcessRunner = async (_cmd, opts) => {
			seen.push(opts.env);
			return { code: 0, stdout: "", stderr: "", timedOut: false };
		};
		const saved = { SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN, OMPBOT_HOME: process.env.OMPBOT_HOME };
		process.env.SLACK_BOT_TOKEN = "xoxb-TEST-0";
		process.env.OMPBOT_HOME = home.dir;
		try {
			await doctorCommand(home.dir, () => {}, { doctor: async () => 0, run });
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		expect(seen.length).toBeGreaterThanOrEqual(3);
		for (const env of seen) {
			expect(env).toBeDefined();
			expect(Object.keys(env ?? {}).filter((key) => /^(SLACK_|OMPBOT_|GIT_)/.test(key))).toEqual([]);
		}
	});

	test("#13 a control character in the stamp's bundle name is escaped on the doctor line", () => {
		seedDb(home.dir);
		mkdirSync(join(home.dir, "backups"), { recursive: true });
		writeFileSync(
			join(home.dir, "backups", STAMP_FILE),
			`ts=${new Date().toISOString()} file=x bundle=ompbot\u001b[2Jbundle.tar.gz\n`,
		);
		const lines: string[] = [];
		checkBackupBundle(
			home.dir,
			(ok, name, detail) => lines.push(`${ok} ${name}: ${detail}`),
			() => {},
		);
		expect(lines.join("\n")).not.toContain("\u001b");
		expect(lines.join("\n")).toContain("\\u001b");
	});
});

describe("units (qa-j #7 #8)", () => {
	test("#7 a path with a space is quoted in PATH= and ExecStart=", () => {
		const template = readFileSync(join(import.meta.dir, "..", "packaging", "ompbot.service"), "utf8");
		const text = renderUnit("ompbot.service", template, {
			bun: "/opt/my bun/bin/bun",
			repoDir: "/srv/my repo",
			home: "/home/a b",
		});
		expect(text).toContain('ExecStart="/opt/my bun/bin/bun" "/srv/my repo/src/main.ts" daemon');
		expect(text).toMatch(/^Environment="PATH=\/opt\/my bun\/bin:\/home\/a b\/\.local\/bin:/m);
		const plain = renderUnit("ompbot.service", template, { bun: "/opt/bun", repoDir: "/srv/repo", home: "/home/a" });
		expect(plain).toContain("ExecStart=/opt/bun /srv/repo/src/main.ts daemon");
	});

	test("#8 a dangling symlink above --out is a usage error, not a raw ENOENT", () => {
		symlinkSync(join(dir, "missing"), join(dir, "link"));
		const errors: string[] = [];
		const write = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			errors.push(chunk);
			return true;
		}) as typeof process.stderr.write;
		let code: number;
		try {
			code = unitsCommand(["render", "--out", join(dir, "link", "sub")], { HOME: dir });
		} finally {
			process.stderr.write = write;
		}
		expect(code).toBe(2);
		expect(errors.join("")).toContain("symlink to a missing path");
	});
});

describe("backup symlink sources (qa-j #20 #21)", () => {
	test("#20 a sessions link to / is refused as around secrets/", () => {
		seedDb(dir);
		mkdirSync(join(dir, "secrets"), { mode: 0o700 });
		symlinkSync("/", join(dir, "sessions"));
		expect(() => runBackup({ homeDir: dir, now: new Date(2026, 9, 23, 4, 30, 0) })).toThrow(
			/links to or around secrets/,
		);
	});

	test("#21 a link source whose real path holds a backslash archives", () => {
		seedDb(dir);
		const real = join(dir, "real\\ndir");
		mkdirSync(real);
		writeFileSync(join(real, "a.txt"), "x");
		symlinkSync(real, join(dir, "sessions"));
		const result = runBackup({ homeDir: dir, now: new Date(2026, 9, 23, 4, 30, 0) });
		expect(result.bundle).toBeDefined();
	});
});
