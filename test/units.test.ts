import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderUnit } from "../src/cli/units";
import { runCliCapture } from "./helpers/daemon-process";
import { isRoot } from "./helpers/privileges";

const REPO = resolve(import.meta.dir, "..");
const MAIN = join(REPO, "src", "main.ts");
const UNITS = [
	"ompbot-backup.service",
	"ompbot-backup.timer",
	"ompbot-dashboard.service",
	"ompbot-gc.service",
	"ompbot-gc.timer",
	"ompbot.service",
];
const SERVICES = UNITS.filter((name) => name.endsWith(".service"));

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** `ompbot units render …` in-process with HOME in a temp dir; OMPBOT_HOME only when given. */
async function render(
	args: string[],
	home: string,
	ompbotHome?: string,
): Promise<{ code: number; out: string; err: string }> {
	const run = await runCliCapture(ompbotHome, ["units", "render", ...args], { HOME: home });
	return { code: run.code, out: run.stdout, err: run.stderr };
}

/** Dry-run output split back into `# <file>` sections. */
function sections(out: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const chunk of out.split(/^# (?=\S+\.(?:service|timer)$)/m).slice(1)) {
		const newline = chunk.indexOf("\n");
		result.set(chunk.slice(0, newline), chunk.slice(newline + 1));
	}
	return result;
}

describe("ompbot units render --dry-run", () => {
	test("AC-4: placeholders and owner paths are gone; ExecStart is this bun and this checkout", async () => {
		const home = tempDir("ompbot-units-home-");
		const run = await render(["--dry-run"], home);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out).not.toMatch(/@[A-Z_]+@/);
		// The renderer's own inputs (this bun, this checkout, the temp HOME) may live under a user's /home;
		// no other home path (a hardcoded owner path) may appear in the output.
		const scrubbed = run.out
			.replaceAll(process.execPath, "<bun>")
			.replaceAll(REPO, "<repo>")
			.replaceAll(dirname(process.execPath), "<bun-dir>")
			.replaceAll(home, "<home>");
		expect(scrubbed).not.toContain("/home/");

		const units = sections(run.out);
		expect([...units.keys()].sort()).toEqual(UNITS);
		for (const [name, command] of [
			["ompbot.service", "daemon"],
			["ompbot-backup.service", "backup"],
			["ompbot-gc.service", "gc"],
			["ompbot-dashboard.service", "dashboard"],
		] as const) {
			expect(units.get(name)).toContain(`\nExecStart=${process.execPath} ${join(REPO, "src", "main.ts")} ${command}\n`);
		}
		expect(units.get("ompbot.service")?.split("\n")).toEqual(
			expect.arrayContaining(["KillMode=mixed", "TimeoutStopSec=90"]),
		);
		const path =
			units
				.get("ompbot.service")
				?.split("\n")
				.find((line) => line.startsWith("Environment=PATH="))
				?.slice("Environment=PATH=".length)
				.split(":") ?? [];
		expect(path[0]).toBe(dirname(process.execPath));
		expect(path).toContain(join(home, ".local", "bin"));
		expect(path).toContain(join(home, ".bun", "bin"));
		expect(path.slice(-3)).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);
		expect(new Set(path).size).toBe(path.length);
		expect(run.out).not.toContain("Environment=OMPBOT_HOME=");
	});

	test("AC-4: OMPBOT_HOME adds one Environment=OMPBOT_HOME= line to every .service and none to timers", async () => {
		const home = tempDir("ompbot-units-home-");
		const ompbotHome = join(home, "bot-home");
		const run = await render(["--dry-run"], home, ompbotHome);
		expect(run.code).toBe(0);
		const units = sections(run.out);
		for (const name of UNITS) {
			const lines = units.get(name)?.split("\n") ?? [];
			const env = lines.filter((line) => line.startsWith("Environment=OMPBOT_HOME="));
			expect(env).toEqual(SERVICES.includes(name) ? [`Environment=OMPBOT_HOME=${ompbotHome}`] : []);
		}
	});
});

describe("ompbot units render --instance", () => {
	const INSTANCE_UNITS = [
		"ompbot-tteok-backup.service",
		"ompbot-tteok-backup.timer",
		"ompbot-tteok-gc.service",
		"ompbot-tteok-gc.timer",
		"ompbot-tteok.service",
	];

	test("renames every unit, drops the dashboard and keeps the instance's OMPBOT_HOME", async () => {
		const home = tempDir("ompbot-units-home-");
		const ompbotHome = join(home, "tteok-home");
		const run = await render(["--instance", "tteok", "--dry-run"], home, ompbotHome);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out).toContain("# ompbot-tteok.service\n");
		expect(run.out).not.toContain("ompbot-dashboard");
		const units = sections(run.out);
		expect([...units.keys()].sort()).toEqual(INSTANCE_UNITS);
		for (const name of INSTANCE_UNITS.filter((unit) => unit.endsWith(".service"))) {
			expect(units.get(name)?.split("\n")).toContain(`Environment=OMPBOT_HOME=${ompbotHome}`);
		}
		expect(units.get("ompbot-tteok.service")).toContain("Description=ompbot-tteok (chat bot");
		expect(units.get("ompbot-tteok-gc.service")).toContain("\nAfter=ompbot-tteok-backup.service\n");
		expect(units.get("ompbot-tteok-backup.timer")).toContain("Description=ompbot-tteok daily backup timer");
	});

	test("without --instance the rendered units are the unchanged ones", async () => {
		const home = tempDir("ompbot-units-home-");
		const plain = await render(["--dry-run"], home, join(home, "h"));
		expect([...sections(plain.out).keys()].sort()).toEqual(UNITS);
		expect(plain.out).not.toContain("ompbot-tteok");
	});

	test("rejects a missing OMPBOT_HOME and a bad name with exit 2", async () => {
		const home = tempDir("ompbot-units-home-");
		expect((await render(["--instance", "tteok", "--dry-run"], home)).code).toBe(2);
		for (const bad of ["Tteok", "1a", "a_b", "a".repeat(25), "", "backup", "gc", "dashboard"]) {
			const run = await render(["--instance", bad, "--dry-run"], home, join(home, "h"));
			expect(run.code).toBe(2);
			expect(run.out).toBe("");
		}
		// An empty OMPBOT_HOME is unset (config.ts): the default install's units, and no second install.
		const empty = await render(["--dry-run"], home, "");
		expect(empty.err).toBe("");
		expect(empty.code).toBe(0);
		expect([...sections(empty.out).keys()].sort()).toEqual(UNITS);
		expect(empty.out).not.toContain("Environment=OMPBOT_HOME");
		const emptyInstance = await render(["--instance", "tteok", "--dry-run"], home, "");
		expect(emptyInstance.code).toBe(2);
		expect(emptyInstance.err).toContain("--instance needs OMPBOT_HOME");
	});

	test("an instance named like another install's backup/gc/dashboard unit is refused by name", async () => {
		const home = tempDir("ompbot-units-home-");
		for (const bad of ["a-backup", "a-gc", "a-dashboard"]) {
			const run = await render(["--instance", bad, "--dry-run"], home, join(home, "h"));
			expect(run.code).toBe(2);
			expect(run.out).toBe("");
			expect(run.err).toContain(`ends in -${bad.split("-")[1]}`);
		}
	});

	test("--out writes the instance files", async () => {
		const home = tempDir("ompbot-units-home-");
		const out = join(tempDir("ompbot-units-out-"), "user");
		const run = await render(["--instance", "tteok", "--out", out], home, join(home, "h"));
		expect(run.code).toBe(0);
		expect(readdirSync(out).sort()).toEqual(INSTANCE_UNITS);
		expect(run.out).toContain("enable --now ompbot-tteok-backup.timer ompbot-tteok-gc.timer");
	});

	test("the peer manifest is the shipped one without slash commands", async () => {
		const read = (file: string) => JSON.parse(readFileSync(join(REPO, "packaging", file), "utf8"));
		const base = read("slack-manifest.json");
		const peer = read("slack-manifest-peer.json");
		expect(peer.features.slash_commands).toBeUndefined();
		expect([peer.display_information.name, peer.features.bot_user.display_name]).toEqual([
			"ompbot-peer",
			"ompbot-peer",
		]);
		expect(peer.oauth_config).toEqual(base.oauth_config);
		expect(peer.settings).toEqual(base.settings);
	});
});

describe("ompbot units render --out", () => {
	test("AC-5: writes all units, a second run with the same content exits 0", async () => {
		const home = tempDir("ompbot-units-home-");
		const out = join(tempDir("ompbot-units-out-"), "user");
		const first = await render(["--out", out], home);
		expect(first.err).toBe("");
		expect(first.code).toBe(0);
		expect(readdirSync(out).sort()).toEqual(UNITS);
		const dry = sections((await render(["--dry-run"], home)).out);
		for (const name of UNITS) expect(readFileSync(join(out, name), "utf8")).toBe(dry.get(name) ?? "");
		expect(first.out).toContain("systemctl --user daemon-reload");

		const again = await render(["--out", out], home);
		expect(again.code).toBe(0);
	});

	test("AC-5: a different existing unit is not overwritten, nothing else is written, exit 2 names it", async () => {
		const home = tempDir("ompbot-units-home-");
		const out = tempDir("ompbot-units-out-");
		expect((await render(["--out", out], home)).code).toBe(0);
		const mine = "[Service]\nExecStart=/opt/my/bun /opt/my/ompbot/src/main.ts daemon\n";
		writeFileSync(join(out, "ompbot.service"), mine);
		rmSync(join(out, "ompbot-gc.timer"));

		const run = await render(["--out", out], home);
		expect(run.code).toBe(2);
		expect(run.err).toContain(join(out, "ompbot.service"));
		expect(readFileSync(join(out, "ompbot.service"), "utf8")).toBe(mine);
		expect(existsSync(join(out, "ompbot-gc.timer"))).toBe(false);
	});

	test("--out '' is a usage error and writes nothing into the current directory", async () => {
		const home = tempDir("ompbot-units-home-");
		const cwd = tempDir("ompbot-units-cwd-");
		const run = Bun.spawnSync([process.execPath, MAIN, "units", "render", "--out", ""], {
			env: { HOME: home, PATH: "/usr/bin:/bin" },
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(2);
		expect(run.stderr.toString()).toContain("--out is empty");
		expect(readdirSync(cwd)).toEqual([]);
	});

	test("an --out that is a file, or a unit path that is a directory, is a usage error naming it", async () => {
		const home = tempDir("ompbot-units-home-");
		const file = join(tempDir("ompbot-units-out-"), "plain-file");
		writeFileSync(file, "x");
		for (const out of [file, join(file, "user")]) {
			const run = await render(["--out", out], home);
			expect(run.code).toBe(2);
			expect(run.err).toContain(`--out ${out}`);
			expect(run.err).not.toContain("Error:");
		}
		const out = tempDir("ompbot-units-out-");
		mkdirSync(join(out, "ompbot.service"));
		const run = await render(["--out", out], home);
		expect(run.code).toBe(2);
		expect(run.err).toContain(`${join(out, "ompbot.service")} is not a file`);
		expect(readdirSync(out)).toEqual(["ompbot.service"]);
	});
});

describe("ompbot units render OMPBOT_HOME quoting", () => {
	test("a home with a space, quote, backslash or % is one quoted Environment= assignment", async () => {
		const home = tempDir("ompbot-units-home-");
		const ompbotHome = join(home, 'sp dir "q" \\b 100%');
		const run = await render(["--dry-run"], home, ompbotHome);
		expect(run.code).toBe(0);
		const line = sections(run.out)
			.get("ompbot.service")
			?.split("\n")
			.find((l) => l.startsWith("Environment="));
		expect(line).toBe(`Environment="OMPBOT_HOME=${home}/sp dir \\"q\\" \\\\b 100%%"`);
	});

	test("a home with a newline is refused", async () => {
		const home = tempDir("ompbot-units-home-");
		const run = await render(["--dry-run"], home, join(home, "a\n[Service]\nExecStartPre=/bin/false"));
		expect(run.code).toBe(2);
		expect(run.out).toBe("");
		expect(run.err).toContain("OMPBOT_HOME");
	});
});

describe("qa-l low units (#7 #8 #9)", () => {
	test("#7: a placeholder-looking path value is not substituted a second time", () => {
		const template =
			"[Service]\nEnvironment=PATH=@PATH@\nExecStart=@BUN@ @REPO_DIR@/src/main.ts daemon\nWorkingDirectory=@HOME@\n";
		const text = renderUnit("ompbot.service", template, {
			bun: "/opt/@REPO_DIR@/bun",
			repoDir: "/srv/@BUN@/repo",
			home: "/home/@PATH@",
		});
		expect(text).toContain("ExecStart=/opt/@REPO_DIR@/bun /srv/@BUN@/repo/src/main.ts daemon");
		expect(text).toContain("WorkingDirectory=/home/@PATH@");
		expect(text).toContain("Environment=PATH=/opt/@REPO_DIR@:/home/@PATH@/.local/bin:");
	});

	test("#8: a checkout path with a newline is refused like a HOME with one", async () => {
		const root = tempDir("ompbot-units-nl-");
		const dir = join(root, "a\nExecStartPre=/bin/false", "src", "cli");
		mkdirSync(dir, { recursive: true });
		const copy = join(dir, "units.ts");
		writeFileSync(copy, readFileSync(join(REPO, "src", "cli", "units.ts"), "utf8"));
		const mod = (await import(copy)) as typeof import("../src/cli/units");
		let err = "";
		const write = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			err += chunk;
			return true;
		}) as typeof process.stderr.write;
		let code: number;
		try {
			code = mod.unitsCommand(["render", "--dry-run"], { HOME: root });
		} finally {
			process.stderr.write = write;
		}
		expect(code).toBe(2);
		expect(err).toContain("checkout path");
	});

	test.skipIf(isRoot)("#9: an --out that cannot be written is a usage error naming the errno", async () => {
		// root writes into a 0o500 dir, so EACCES cannot be provoked
		const home = tempDir("ompbot-units-home-");
		const out = join(home, "ro");
		mkdirSync(out);
		chmodSync(out, 0o500);
		const run = await render(["--out", join(out, "sub")], home);
		chmodSync(out, 0o700);
		expect(run.code).toBe(2);
		expect(run.err).toContain("--out");
		expect(run.err).toContain("EACCES");
	});
});
