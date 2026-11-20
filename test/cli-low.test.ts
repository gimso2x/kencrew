import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorCommand } from "../src/cli/index";
import { openBotStore } from "../src/core/origin";
import { startIpcServer } from "../src/daemon/ipc";
import type { ProcessRunner } from "../src/dispatch/omp";
import { acceptanceItems } from "../src/tasks/docs";
import { openTaskLedger } from "../src/tasks/ledger";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

import { makeHome, type TestHome } from "./helpers/bot-home";
import { runCliCapture, runMain } from "./helpers/daemon-process";

let home: TestHome;
beforeEach(() => {
	home = makeHome("ompbot-cli-low-");
});
afterEach(() => home.remove());

/** A usage error: exit 2, one stderr line naming the command, nothing on stdout. */
function expectUsageLine(result: { code: number; stdout: string; stderr: string }, command: string): void {
	expect(result.code, result.stderr).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr.startsWith(`${command}: `)).toBe(true);
	expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
	expect(result.stderr).not.toContain("TypeError");
}

describe("CLI argument errors are usage errors (exit 2, one line)", () => {
	test("unknown options, missing values and dash-leading values of every parser", async () => {
		const runs = await Promise.all([
			runMain(home.dir, ["drain", "--bogus"]),
			runMain(home.dir, ["drain", "--help"]),
			runMain(home.dir, ["drain", "--timeout"]),
			runMain(home.dir, ["backup", "--keep", "-1"]),
			runMain(home.dir, ["inject", "--bogus"]),
			runMain(home.dir, ["inject", "--origin", "discord/dm/200000000000000001", "--as-owner", "--text"]),
		]);
		const commands = ["drain", "drain", "drain", "backup", "inject", "inject"];
		for (const [i, run] of runs.entries()) expectUsageLine(run, commands[i] ?? "");
	});

	test("the retired feedback command is unknown: usage text, exit 2", async () => {
		const run = await runMain(home.dir, ["feedback"]);
		expect(run.code).toBe(2);
		expect(run.stderr.startsWith("usage: ompbot <command>")).toBe(true);
		expect(run.stderr).not.toMatch(/^\s+feedback\b/m);
	});

	test("the retired briefing, offsite and tasks flow commands are unknown: usage text, exit 2", async () => {
		const [briefing, offsite, flow] = await Promise.all([
			runMain(home.dir, ["briefing", "--out", join(home.dir, "b.png")]),
			runMain(home.dir, ["offsite"]),
			runMain(home.dir, ["tasks", "flow", "--out", join(home.dir, "flow")]),
		]);
		for (const run of [briefing, offsite]) {
			expect(run.code).toBe(2);
			expect(run.stderr.startsWith("usage: ompbot <command>")).toBe(true);
			expect(run.stderr).not.toMatch(/briefing|offsite \[|tasks flow/);
		}
		expect(flow.code).toBe(2);
		expect(flow.stderr.startsWith("usage: ompbot tasks <list|show|check|close|pause|resume>")).toBe(true);
	});

	test("drain --timeout '' is refused instead of meaning 0 minutes", async () => {
		const run = await runMain(home.dir, ["drain", "--wait", "--timeout", ""]);
		expect(run.code).toBe(2);
		expect(run.stderr).toContain("drain: --timeout must be");
	});

	test("inject --text '' or blanks is refused before the daemon is asked", async () => {
		for (const text of ["", "   \n"]) {
			const run = await runMain(home.dir, [
				"inject",
				"--origin",
				"discord/dm/200000000000000001",
				"--as-owner",
				"--text",
				text,
			]);
			expect(run.code).toBe(2);
			expect(run.stderr).toContain("--text is empty");
			expect(run.stderr).not.toContain("daemon not reachable");
		}
	});
});

describe("CLI commands without a daemon", () => {
	test("reload says the daemon is not reachable, exit 1", async () => {
		const run = await runMain(home.dir, ["reload"]);
		expect(run.code).toBe(1);
		expect(run.stderr).toStartWith("reload: daemon not reachable (");
		expect(run.stderr).not.toContain("Error:");
	});

	test("reload refuses a daemon answer of the wrong shape instead of a TypeError (qa-l #4)", async () => {
		const answers: unknown[] = [
			{ ok: true },
			{ ok: true, changed: ["a"], restartRequired: "model", cli: [] },
			{ ok: true, changed: [1], restartRequired: [], cli: [] },
			null,
		];
		for (const answer of answers) {
			const server = startIpcServer(join(home.dir, "ompbot.sock"), async () => answer);
			try {
				const run = await runCliCapture(home.dir, ["reload"]);
				expect(run.code).toBe(1);
				expect(run.stdout).toBe("");
				expect(run.stderr).toBe("reload: unexpected daemon answer\n");
			} finally {
				server.stop();
			}
		}
		const good = startIpcServer(join(home.dir, "ompbot.sock"), async () => ({
			ok: true,
			changed: ["mentionFreeChannels"],
			restartRequired: [],
			cli: ["x", "y"],
		}));
		try {
			const run = await runCliCapture(home.dir, ["reload"]);
			expect(run.code, run.stderr).toBe(0);
			expect(run.stdout).toBe("config_reloaded changed=mentionFreeChannels restart_required=- cli=x,y\n");
		} finally {
			good.stop();
		}
	});

	test("status falls back to the database without reading the bot token, and works on a db-only home", async () => {
		openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() }, "Asia/Seoul").close();
		chmodSync(join(home.dir, "secrets", "discord-bot-token"), 0o644);
		const loose = await runMain(home.dir, ["status", "--json"]);
		expect(loose.code, loose.stderr).toBe(0);
		expect(JSON.parse(loose.stdout).ompVersion).toBe("omp/0.0.0-stub");

		rmSync(join(home.dir, "config.json"));
		const dbOnly = await runMain(home.dir, ["status", "--json"]);
		expect(dbOnly.code, dbOnly.stderr).toBe(0);
		expect(JSON.parse(dbOnly.stdout).ompVersion).toBe("unknown");
	});
});

describe("ompbot skills rollback", () => {
	test("an empty OMPBOT_SKILLS_DIR is unset: the agent skills root, never the current directory", () => {
		const cwd = join(home.dir, "cwd");
		mkdirSync(join(cwd, "foo", "revisions"), { recursive: true });
		writeFileSync(join(cwd, "foo", "SKILL.md"), "current\n");
		writeFileSync(join(cwd, "foo", "revisions", "20260101-000000.md"), "old\n");
		const run = Bun.spawnSync([process.execPath, MAIN, "skills", "rollback", "foo"], {
			env: { HOME: home.dir, PATH: "/usr/bin:/bin", OMPBOT_TEST_HOOKS: "1", OMPBOT_SKILLS_DIR: "" },
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toContain(join(home.dir, ".omp", "agent", "managed-skills", "foo"));
		expect(readFileSync(join(cwd, "foo", "SKILL.md"), "utf8")).toBe("current\n");
	});
});

describe("ompbot doctor dispatch host names", () => {
	test("a control character in a dispatchHosts name cannot forge a doctor line", async () => {
		const path = join(home.dir, "config.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(
			path,
			JSON.stringify({ ...config, herdr: {}, dispatchHosts: { "evil\nok forged": { ssh: "wsl" } } }),
			{ mode: 0o600 },
		);
		const run: ProcessRunner = async () => ({ code: 0, stdout: "omp: current (v10)\n", stderr: "", timedOut: false });
		const lines: string[] = [];
		await doctorCommand(home.dir, (line) => lines.push(line), { doctor: async () => 0, run });
		const hostLines = lines.filter((line) => line.includes("evil"));
		expect(hostLines).toEqual([
			"ok dispatch host evil\\u000aok forged: ssh wsl",
			"ok herdr omp integration on evil\\u000aok forged: omp: current (v10)",
		]);
		for (const line of lines) expect(line).not.toContain("\n");
		expect(existsSync(path)).toBe(true);
	});
});

describe("tasks CLI reads (qa-l low B)", () => {
	const dbPath = () => join(home.dir, "ompbot.db");
	function registerTask(title: string): string {
		const ledger = openTaskLedger(dbPath(), "Asia/Seoul");
		const row = ledger.register({
			title,
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

	// qa-l #45: a title with a terminal escape must not forge a row or move the cursor.
	test("tasks list escapes control characters of ledger text", async () => {
		registerTask("real\u001b[2K\nforged  working  L0");
		const list = await runCliCapture(home.dir, ["tasks", "list"]);
		expect(list.code, list.stderr).toBe(0);
		expect(list.stdout).not.toContain("\u001b");
		expect(list.stdout).toContain("\\u001b[2K\\u000aforged");
		expect(list.stdout.trimEnd().split("\n")).toHaveLength(1);
	});

	// qa-l #40: an owner-paused task reads as paused in the text list and the json.
	test("tasks list marks a paused task in text and json", async () => {
		const id = registerTask("pausable");
		const ledger = openTaskLedger(dbPath(), "Asia/Seoul");
		ledger.pauseTask(id);
		ledger.close();
		expect((await runCliCapture(home.dir, ["tasks", "list"])).stdout).toContain("(멈춤)");
		const json = JSON.parse((await runCliCapture(home.dir, ["tasks", "list", "--json"])).stdout) as {
			tasks: Array<{ paused: boolean }>;
		};
		expect(json.tasks.map((task) => task.paused)).toEqual([true]);
	});

	// qa-l #44: a ledger from before task_transitions existed shows its task with an empty history.
	test("tasks show on a ledger without task_transitions is not a raw SQLiteError", async () => {
		const id = registerTask("old ledger");
		const db = new Database(dbPath(), { strict: true });
		db.run("DROP TABLE task_transitions");
		db.close();
		const show = await runCliCapture(home.dir, ["tasks", "show", id]);
		expect(show.stderr).not.toContain("SQLiteError");
		expect(JSON.parse(show.stdout.trim().split("\n")[0] ?? "{}").history).toEqual([]);
	});

	// qa-l #43: a WAL ledger on a read-only directory cannot create -shm/-wal; it is still read (immutable).
	test("tasks list and show read a WAL ledger in a read-only directory", async () => {
		const id = registerTask("on a read-only medium");
		expect(existsSync(`${dbPath()}-wal`)).toBe(false);
		chmodSync(home.dir, 0o555);
		try {
			const list = await runCliCapture(home.dir, ["tasks", "list", "--json"]);
			expect(list.code, list.stderr).toBe(0);
			expect(JSON.parse(list.stdout).tasks).toHaveLength(1);
			const show = await runCliCapture(home.dir, ["tasks", "show", id]);
			expect(show.stderr).not.toContain("SQLiteError");
		} finally {
			chmodSync(home.dir, 0o755);
		}
	});
});
