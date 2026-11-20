import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCommand, gatesCommand } from "../src/cli/index";
import { ConfigError, loadConfig } from "../src/config";
import { countOmpModels } from "../src/daemon/doctor";
import type { ProcessRunner } from "../src/dispatch/omp";
import { checkOmpRuntimeSync } from "../src/omp/runtime-check";
import { writeFreeze } from "../src/ops/freeze";
import { collectGates, ORIGIN_SILENT_MS } from "../src/ops/gates";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";

let home: string;

const OWNER_ID = "123456789012345678"; // gitleaks:allow (fake snowflake)
const APP_ID = "234567890123456789"; // gitleaks:allow (fake snowflake)
const TEAMS_GUID = "0aaaaaaa-1111-2222-3333-444444444444";

function writeSecret(rel: string, content: string, mode = 0o600): void {
	const p = join(home, rel);
	writeFileSync(p, content);
	chmodSync(p, mode);
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		channels: {
			discord: { ownerUserId: OWNER_ID, botTokenFile: "secrets/discord.token", applicationId: APP_ID },
		},
		ompExecutable: "/usr/local/bin/omp",
		workspaceDir: "workspace",
		...overrides,
	};
}

function writeConfig(obj: unknown): void {
	writeFileSync(join(home, "config.json"), JSON.stringify(obj));
}

function loadError(): ConfigError {
	try {
		loadConfig(home);
	} catch (error) {
		if (error instanceof ConfigError) return error;
		throw error;
	}
	throw new Error("expected ConfigError");
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-qa-x-ops-"));
	chmodSync(home, 0o700);
	mkdirSync(join(home, "secrets"), { mode: 0o700 });
	writeSecret("secrets/discord.token", "TEST-discord-token\n");
	writeConfig(baseConfig());
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("qa-x #1: nested config blocks refuse unknown keys", () => {
	const cases: Array<[string, Record<string, unknown>, string]> = [
		[
			"dispatchHosts.<h>",
			{ herdr: {}, dispatchHosts: { wsl: { ssh: "wsl", workdir: "/x" } } },
			"dispatchHosts.wsl.workdir",
		],
		["offsite", { offsite: { ssh: "box", remoteDir: "~/b", keepp: 3 } }, "offsite.keepp"],
		["herdrBoard", { herdr: {}, herdrBoard: { url: "https://x.test/", apii: "https://x.test/" } }, "herdrBoard.apii"],
		["herdr", { herdr: { binn: "/usr/bin/herdr" } }, "herdr.binn"],
	];
	for (const [name, overrides, field] of cases) {
		test(`${name}: a typo is config_invalid`, () => {
			writeConfig(baseConfig(overrides));
			const error = loadError();
			expect(error.code).toBe("config_invalid");
			expect(error.message).toContain(`field=${field}`);
		});
	}

	test("the known keys of every block still load", () => {
		writeConfig(
			baseConfig({
				herdr: { bin: "/usr/bin/herdr" },
				dispatchHosts: { wsl: { ssh: "wsl", workDir: "/x", herdrBin: "/b/herdr", ompArgs: ["--x"] } },
				offsite: { ssh: "box", remoteDir: "~/b", keep: 3 },
				herdrBoard: { url: "https://x.test/", api: "https://x.test/api" },
			}),
		);
		expect(loadConfig(home).dispatchHosts?.wsl?.workDir).toBe("/x");
	});
});

describe("qa-x #2: listeners may not share a host and port", () => {
	const teams = (listen?: string) => ({
		discord: { ownerUserId: OWNER_ID, botTokenFile: "secrets/discord.token", applicationId: APP_ID },
		teams: {
			appId: TEAMS_GUID,
			tenantId: TEAMS_GUID,
			clientSecretFile: "secrets/teams.secret",
			ownerAadObjectId: TEAMS_GUID,
			...(listen === undefined ? {} : { listen }),
		},
	});

	test("webhook.port equal to the default teams listen port is config_invalid", () => {
		writeSecret("secrets/teams.secret", "TEST-teams-secret\n");
		writeConfig(baseConfig({ channels: teams(), webhook: { port: 3978 } }));
		expect(loadError().message).toContain("field=webhook.port");
	});

	test("webhook and dashboard on the same address are config_invalid; different hosts or ports load", () => {
		writeConfig(baseConfig({ webhook: { port: 8090 }, dashboard: { port: 8090 } }));
		expect(loadError().message).toContain("field=dashboard.port");
		writeConfig(baseConfig({ webhook: { port: 8090 }, dashboard: { port: 8090, bind: "::1" } }));
		expect(loadConfig(home).dashboard?.port).toBe(8090);
		writeConfig(baseConfig({ webhook: { port: 8090 }, dashboard: { port: 8091 } }));
		expect(loadConfig(home).dashboard?.port).toBe(8091);
	});

	test("without channels.teams the default teams listen port is free for the webhook", () => {
		writeConfig(baseConfig({ webhook: { port: 3978 } }));
		expect(loadConfig(home).webhook?.port).toBe(3978);
	});

	test("an explicit teams listen collides with the dashboard; another port does not", () => {
		writeSecret("secrets/teams.secret", "TEST-teams-secret\n");
		writeConfig(baseConfig({ channels: teams("127.0.0.1:4100"), dashboard: { port: 4100 } }));
		expect(loadError().message).toContain("field=dashboard.port");
		writeConfig(baseConfig({ channels: teams("127.0.0.1:4100"), dashboard: { port: 4101 } }));
		expect(loadConfig(home).dashboard?.port).toBe(4101);
	});
});

describe("qa-x #3: wikiNotes ~user paths", () => {
	test("~other/x is config_invalid; ~ and ~/x expand to the home", () => {
		writeConfig(baseConfig({ wikiNotes: { client: "c", agentDir: "~other/x" } }));
		expect(loadError().message).toContain("field=wikiNotes.agentDir");
		writeConfig(baseConfig({ wikiNotes: { client: "c", agentDir: "~/x", repos: ["~"] } }));
		const notes = loadConfig(home).wikiNotes;
		expect(notes?.agentDir?.endsWith("/x")).toBe(true);
		expect(notes?.agentDir?.includes("~")).toBe(false);
		expect(notes?.repos?.[0]?.includes("~")).toBe(false);
	});
});

describe("qa-x #5: doctor keeps checking herdr when a token file is broken", () => {
	test("a missing token file does not hide the herdr line", async () => {
		writeConfig(baseConfig({ herdr: {} }));
		rmSync(join(home, "secrets", "discord.token"));
		const run: ProcessRunner = async (cmd) => ({
			code: 0,
			stdout: cmd.includes("--version") ? "herdr 1.0\n" : "omp: current\n",
			timedOut: false,
		});
		const lines: string[] = [];
		await doctorCommand(home, (line) => lines.push(line), { doctor: async () => 0, run });
		expect(lines.some((line) => line.startsWith("ok herdr:"))).toBe(true);
	});
});

describe("qa-x #6/#7: the omp probes enforce their time limit against a stubborn launcher", () => {
	/** A launcher that ignores SIGTERM and leaves a grandchild holding the stdout pipe. */
	function stubbornOmp(): string {
		const path = join(home, "stubborn-omp");
		writeFileSync(path, "#!/bin/sh\ntrap '' TERM\n(sleep 20) &\nsleep 20\n");
		chmodSync(path, 0o755);
		return path;
	}

	test("countOmpModels gives up at its timeout", async () => {
		const started = Date.now();
		expect(await countOmpModels(stubbornOmp(), 300)).toBe("timeout after 0.3s");
		expect(Date.now() - started).toBeLessThan(4000);
	});

	test("checkOmpRuntimeSync reports a timeout instead of waiting for the launcher", () => {
		const started = Date.now();
		const problem = checkOmpRuntimeSync(stubbornOmp(), {}, 300);
		expect(problem?.detail).toContain("error=timeout");
		expect(Date.now() - started).toBeLessThan(4000);
	});
});

describe("qa-x #8: gates reports an unreadable config instead of dying silently", () => {
	const calm = {
		statfs: () => ({ bavail: 50 * 262_144, blocks: 100 * 262_144, bsize: 4096 }),
		hostLoad: IDLE_HOST_LOAD,
	};
	function runGates(args: string[]): { code: number; out: string } {
		const out: string[] = [];
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			return { code: gatesCommand(args, home, calm), out: out.join("") };
		} finally {
			process.stdout.write = write;
		}
	}

	test("text: the last line is gates_done with the error, exit 2 (not a gate-open 1)", () => {
		writeFileSync(join(home, "config.json"), "{ not json");
		const run = runGates([]);
		expect(run.code).toBe(2);
		expect(run.out.trimEnd().split("\n").pop()).toMatch(/^gates_done error=config_invalid_json\b/);
	});

	test("--json carries the error", () => {
		writeFileSync(join(home, "config.json"), "{ not json");
		const run = runGates(["--json"]);
		expect(run.code).toBe(2);
		expect(JSON.parse(run.out)).toMatchObject({ error: "config_invalid_json" });
	});
});

describe("qa-x #9: origin_silent ignores autonomous rows a freeze holds", () => {
	const now = Date.now();
	const DDL = `
CREATE TABLE inbound (
	inbound_id INTEGER PRIMARY KEY AUTOINCREMENT,
	platform_message_id TEXT NOT NULL UNIQUE,
	origin_key TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	text_ref TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending',
	created_at INTEGER NOT NULL,
	dispatched_at INTEGER,
	last_event_at INTEGER,
	peer_user_id TEXT
);
CREATE TABLE deliveries (
	delivery_id INTEGER PRIMARY KEY AUTOINCREMENT, origin_key TEXT NOT NULL, op_ref TEXT NOT NULL, part INTEGER NOT NULL,
	thread_ref TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
	next_at INTEGER NOT NULL, redelivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_error TEXT
);`;
	function seed(rows: Array<[string, string, string | null]>): void {
		const db = new Database(join(home, "ompbot.db"), { create: true, strict: true });
		db.run(DDL);
		for (const [id, origin, peer] of rows) {
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, peer_user_id) VALUES (?, ?, 1, 't', 'pending', ?, ?)",
				[id, origin, now - 2 * ORIGIN_SILENT_MS, peer],
			);
		}
		db.close();
	}
	const silent = () => collectGates({ homeDir: home, now }).find((g) => g.name === "origin_silent");

	test("frozen: peer and lane rows are not silence; an owner row still opens the gate", () => {
		seed([
			["lane:a:instruct:1", "discord/chan/1", null],
			["P:1", "discord/chan/2", "300000000000000001"],
		]);
		writeFreeze(home, { by: "test", now });
		expect(silent()).toEqual({ name: "origin_silent", state: "closed", detail: "waiting=0" });

		const db = new Database(join(home, "ompbot.db"), { strict: true });
		db.run(
			"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at) VALUES ('O:1', 'discord/dm/200000000000000001', 1, 't', 'pending', ?)",
			[now - 2 * ORIGIN_SILENT_MS],
		);
		db.close();
		expect(silent()).toMatchObject({ state: "open", detail: expect.stringContaining("waiting=1 origins=1") });
	});

	test("not frozen: the same autonomous rows still count", () => {
		seed([["lane:a:instruct:1", "discord/chan/1", null]]);
		expect(silent()).toMatchObject({ state: "open", detail: expect.stringContaining("waiting=1") });
	});
});
