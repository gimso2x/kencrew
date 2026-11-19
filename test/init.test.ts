import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const OWNER = "100000000000000001"; // gitleaks:allow (fake snowflake)
const APP = "100000000000000002"; // gitleaks:allow (fake snowflake)

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** `ompbot init` in a child process whose HOME and OMPBOT_HOME both point into a temp dir. */
function init(args: string[], home: string, path = ""): { code: number; out: string; err: string } {
	const run = Bun.spawnSync([process.execPath, MAIN, "init", ...args], {
		env: { HOME: join(home, ".."), OMPBOT_HOME: home, PATH: path },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

const mode = (path: string): number => statSync(path).mode & 0o777;

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

function freshHome(): string {
	return join(tempDir("ompbot-init-"), ".ompbot");
}

describe("ompbot init: the printed next-step commands", () => {
	test("a home with a space and a quote still parses in bash and unquotes to the same paths", () => {
		const home = join(tempDir("ompbot-init-"), "a b", "it's");
		const run = init(["--owner", OWNER, "--app-id", APP, "--omp", process.execPath], home);
		expect(run.code, run.err).toBe(0);
		const commands = run.out.split("\n").filter((line) => line.startsWith("  cat >") || line.includes("OMPBOT_HOME="));
		expect(commands.length).toBe(2);
		const script = commands
			.map((line) =>
				line.replace("cat >", "printf '%s\\n'").replace("bun src/main.ts doctor", "/usr/bin/printenv OMPBOT_HOME"),
			)
			.join("\n");
		const syntax = Bun.spawnSync(["bash", "-n", "-c", script], { stderr: "pipe" });
		expect(syntax.stderr.toString()).toBe("");
		expect(syntax.exitCode).toBe(0);
		const unquoted = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
		expect(unquoted.stdout.toString().split("\n")).toEqual([join(home, "secrets", "discord-bot-token"), home, ""]);
	});
});

describe("ompbot init", () => {
	test("AC-1: creates home, secrets, workspace, config.json; loadConfig accepts it once tokens exist", () => {
		const home = freshHome();
		const run = init(["--owner", OWNER, "--app-id", APP, "--omp", process.execPath], home);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(mode(home)).toBe(0o700);
		expect(mode(join(home, "secrets"))).toBe(0o700);
		expect(statSync(join(home, "workspace")).isDirectory()).toBe(true);
		expect(mode(join(home, "config.json"))).toBe(0o600);
		expect(run.out).toContain(join(home, "secrets", "discord-bot-token"));
		expect(run.out).toContain("doctor");

		writeFileSync(join(home, "secrets", "discord-bot-token"), "fake-discord-token\n", { mode: 0o600 });
		const config = loadConfig(home);
		expect(config.channels.discord?.ownerUserId).toBe(OWNER);
		expect(config.channels.discord?.applicationId).toBe(APP);
		const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
		expect(raw.channels).toEqual({
			discord: { ownerUserId: OWNER, botTokenFile: "secrets/discord-bot-token", applicationId: APP },
		});
		expect(config.ompExecutable).toBe(process.execPath);
		expect(config.workspaceDir).toBe(join(home, "workspace"));
		expect(config.channels.discord?.botTokenFile).toBe(join(home, "secrets", "discord-bot-token"));
		expect(config.sessionRetentionDays).toBe(30);
	});

	test("--platform discord writes a Discord-only config that loads once the bot token file exists", () => {
		const home = freshHome();
		const owner = OWNER;
		const app = APP;
		const run = init(["--platform", "discord", "--owner", owner, "--app-id", app, "--omp", process.execPath], home);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out).toContain(join(home, "secrets", "discord-bot-token"));
		const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
		expect(raw.channels).toEqual({
			discord: { ownerUserId: owner, botTokenFile: "secrets/discord-bot-token", applicationId: app },
		});
		writeFileSync(join(home, "secrets", "discord-bot-token"), "fake-discord-token\n", { mode: 0o600 });
		const config = loadConfig(home);
		expect(config.channels.discord?.ownerUserId).toBe(owner);
	});

	test("--platform discord without a Discord id for --owner or --app-id exits 2 and creates nothing", () => {
		for (const args of [
			["--owner", "U0123456789", "--app-id", APP],
			["--owner", OWNER],
		]) {
			const home = freshHome();
			const run = init(["--platform", "discord", ...args, "--omp", process.execPath], home);
			expect(run.code).toBe(2);
			expect(run.err).toContain("must be a Discord id");
			expect(existsSync(home)).toBe(false);
		}
	});

	test("AC-1: --workspace is used as an absolute workspaceDir; --omp falls back to omp on PATH", () => {
		const home = freshHome();
		const bin = tempDir("ompbot-init-bin-");
		const omp = join(bin, "omp");
		writeFileSync(omp, "#!/bin/sh\n");
		chmodSync(omp, 0o755);
		const workspace = join(tempDir("ompbot-init-ws-"), "work");
		const run = init(["--owner", OWNER, "--app-id", APP, "--workspace", workspace], home, bin);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
		expect(raw.ompExecutable).toBe(omp);
		expect(raw.workspaceDir).toBe(workspace);
		expect(statSync(workspace).isDirectory()).toBe(true);
	});

	test("AC-2: an existing config.json is left byte-identical and init exits 2", () => {
		const home = freshHome();
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const before = '{"schemaVersion": 1, "mine": true}\n';
		writeFileSync(join(home, "config.json"), before, { mode: 0o600 });
		const run = init(["--owner", OWNER, "--app-id", APP, "--omp", process.execPath], home);
		expect(run.code).toBe(2);
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
		expect(readdirSync(home)).toEqual(["config.json"]);
	});

	for (const [name, args] of [
		["missing --owner", ["--app-id", APP, "--omp", process.execPath]],
		["missing --app-id", ["--owner", OWNER, "--omp", process.execPath]],
		["non-numeric owner", ["--owner", "u0123456789", "--app-id", APP, "--omp", process.execPath]],
		["too short owner", ["--owner", "1000001", "--app-id", APP, "--omp", process.execPath]],
	] as Array<[string, string[]]>) {
		test(`AC-2: ${name} exits 2 and creates nothing`, () => {
			const home = freshHome();
			const run = init(args, home);
			expect(run.code).toBe(2);
			expect(run.err).not.toBe("");
			expect(existsSync(home)).toBe(false);
		});
	}

	test("a non-executable --omp exits 2 and creates nothing", () => {
		const home = freshHome();
		const omp = join(tempDir("ompbot-init-omp-"), "omp");
		writeFileSync(omp, "#!/bin/sh\n", { mode: 0o644 });
		const run = init(["--owner", OWNER, "--app-id", APP, "--omp", omp], home);
		expect(run.code).toBe(2);
		expect(run.err).toContain("is not executable");
		expect(existsSync(home)).toBe(false);
	});

	test("a file where the home, the workspace or one of their parents goes exits 2 and creates nothing", () => {
		const root = tempDir("ompbot-init-files-");
		const file = join(root, "plain-file");
		writeFileSync(file, "x");
		const workspaceCases = [file, join(file, "ws")];
		for (const workspace of workspaceCases) {
			const home = join(root, "home");
			const run = init(["--owner", OWNER, "--app-id", APP, "--omp", process.execPath, "--workspace", workspace], home);
			expect(run.code).toBe(2);
			expect(run.err).toContain(`--workspace ${workspace}`);
			expect(run.err).not.toContain("Error:");
			expect(existsSync(home)).toBe(false);
		}
		for (const home of [file, join(file, ".ompbot")]) {
			const run = init(["--owner", OWNER, "--app-id", APP, "--omp", process.execPath], home);
			expect(run.code).toBe(2);
			expect(run.err).toContain(`home ${home}`);
			expect(run.err).not.toContain("Error:");
		}
		// HOME is `root` here; `.bun` is the child bun's own cache, not something init made.
		expect(readdirSync(root).filter((name) => name !== ".bun")).toEqual(["plain-file"]);
	});

	test("an empty OMPBOT_HOME is unset: the home is ~/.ompbot, nothing lands in the current directory", () => {
		const cwd = tempDir("ompbot-init-cwd-");
		const userHome = tempDir("ompbot-init-home-");
		const empty = Bun.spawnSync(
			[process.execPath, MAIN, "init", "--owner", OWNER, "--app-id", APP, "--omp", process.execPath],
			{
				env: { HOME: userHome, OMPBOT_HOME: "", PATH: "" },
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(empty.stderr.toString()).toBe("");
		expect(empty.exitCode).toBe(0);
		expect(existsSync(join(userHome, ".ompbot", "config.json"))).toBe(true);
		expect(empty.stdout.toString()).not.toContain("OMPBOT_HOME=");
		expect(readdirSync(cwd)).toEqual([]);
	});

	test("a directory as --omp and an empty --omp or --workspace exit 2 and create nothing", () => {
		const home = freshHome();
		const cases: Array<[string[], string]> = [
			[["--owner", OWNER, "--app-id", APP, "--omp", tempDir("ompbot-init-dir-")], "is a directory"],
			[["--owner", OWNER, "--app-id", APP, "--omp", ""], "--omp is empty"],
			[["--owner", OWNER, "--app-id", APP, "--omp", process.execPath, "--workspace", ""], "--workspace is empty"],
		];
		for (const [args, message] of cases) {
			const run = init(args, home);
			expect(run.code).toBe(2);
			expect(run.err).toContain(message);
			expect(existsSync(home)).toBe(false);
		}
	});

	test("--help prints the usage and exits 0", () => {
		const home = freshHome();
		const run = init(["--help"], home);
		expect(run.code).toBe(0);
		expect(run.out).toContain("init [--platform discord] --owner <Discord user id>");
		expect(existsSync(home)).toBe(false);
	});

	test("no omp on PATH and no --omp exits 2 and creates nothing", () => {
		const home = freshHome();
		const run = init(["--owner", OWNER, "--app-id", APP], home, tempDir("ompbot-init-empty-path-"));
		expect(run.code).toBe(2);
		expect(run.err).toContain("omp");
		expect(existsSync(home)).toBe(false);
	});

	test("AC-3: secrets stays empty and no file under the home holds a token", () => {
		const home = freshHome();
		expect(init(["--owner", OWNER, "--app-id", APP, "--omp", process.execPath], home).code).toBe(0);
		expect(readdirSync(join(home, "secrets"))).toEqual([]);
		const files = filesUnder(home);
		expect(files).toContain(join(home, "config.json"));
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			expect(text).not.toMatch(/[\w-]{24}\.[\w-]{6}\.[\w-]{27,}/);
		}
	});

	test("qa-l #5: a secrets symlink is refused and its target keeps its mode", () => {
		const home = freshHome();
		const outside = join(tempDir("ompbot-init-outside-"), "shared");
		mkdirSync(outside, { mode: 0o755 });
		chmodSync(outside, 0o755);
		mkdirSync(home, { recursive: true, mode: 0o700 });
		symlinkSync(outside, join(home, "secrets"));
		const run = init(["--owner", OWNER, "--app-id", APP, "--omp", process.execPath], home);
		expect(run.code).toBe(2);
		expect(run.err).toContain("secrets");
		expect(mode(outside)).toBe(0o755);
		expect(existsSync(join(home, "config.json"))).toBe(false);
	});
});
