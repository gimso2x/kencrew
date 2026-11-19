import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config";
import { LIVE_FIELDS, planReload } from "../src/daemon/reload";

// `wikiNotes` (doc/plans/wiki-work-outcome-notes.md B): absent = off, checked at load, applied by a reload.

let home: string;

const write = (extra: Record<string, unknown>): void => {
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			schemaVersion: 1,
			channels: {
				discord: {
					ownerUserId: "100000000000000001",
					botTokenFile: "secrets/bot.token",
					applicationId: "600000000000000000",
				},
			},
			ompExecutable: "/usr/local/bin/omp",
			workspaceDir: "workspace",
			...extra,
		}),
	);
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-wiki-cfg-"));
	chmodSync(home, 0o700);
	mkdirSync(join(home, "secrets"), { mode: 0o700 });
	writeFileSync(join(home, "secrets", "bot.token"), "TEST-discord-0\n");
	chmodSync(join(home, "secrets", "bot.token"), 0o600);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("wikiNotes config", () => {
	test("AC-4: absent means off; present is read with ~ expanded", () => {
		write({});
		expect(loadConfig(home).wikiNotes).toBeUndefined();
		write({ wikiNotes: { client: "~/.local/share/wiki-client", repos: ["/r/one"] } });
		expect(loadConfig(home).wikiNotes).toEqual({
			client: join(homedir(), ".local/share/wiki-client"),
			repos: ["/r/one"],
		});
	});

	test("AC-4: unknown keys and wrong types are config_invalid", () => {
		for (const bad of [{ client: "" }, { client: "/c", extra: 1 }, { client: "/c", repos: "x" }, "yes"]) {
			write({ wikiNotes: bad });
			try {
				loadConfig(home);
				throw new Error("expected ConfigError");
			} catch (error) {
				expect(error).toBeInstanceOf(ConfigError);
				expect((error as ConfigError).message).toContain("field=wikiNotes");
			}
		}
	});

	test("AC-4: a reload turns the notes on and off (wikiNotes is a live field)", () => {
		expect(LIVE_FIELDS).toContain("wikiNotes");
		write({});
		const off = loadConfig(home);
		write({ wikiNotes: { client: "/c" } });
		const on = loadConfig(home);
		const enabled = planReload(off, on);
		expect(enabled.changed).toContain("wikiNotes");
		expect(enabled.next.wikiNotes).toEqual({ client: "/c" });
		const disabled = planReload(enabled.next, off);
		expect(disabled.changed).toContain("wikiNotes");
		expect(disabled.next.wikiNotes).toBeUndefined();
	});
});
