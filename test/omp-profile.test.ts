import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, loadConfig, type OmpbotConfig } from "../src/config";
import { RESTART_FIELDS } from "../src/daemon/reload";
import { botRpcEnv, rpcOverlayFor, teamsGroupOverlayPath } from "../src/daemon/run";
import { dispatchEnv, type RunProcessOptions, runOmpPrint } from "../src/dispatch/omp";
import { buildDispatchTool } from "../src/dispatch/tool";
import { buildChildEnv } from "../src/omp/env";
import { REQUIRED_RPC_METHODS, RpcOmpDriver, type RpcOmpDriverOptions } from "../src/omp/rpc-driver";
import { teamsAlias } from "../src/teams/types";

/** A parent env with every key the profile wiring touches: an inherited agent dir and bot secrets (fake values). */
const BASE = {
	PATH: "/usr/bin:/bin",
	HOME: "/home/u",
	PI_CODING_AGENT_DIR: "/custom/agent",
	SLACK_BOT_TOKEN: "xoxb-TEST-0",
	OMPBOT_HOME: "/home/u/.ompbot",
	FOO: "1",
};

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** RpcClient stand-in: every method `missingRpcMethods` checks; `start()` spawns the child once through `options.spawn`. */
function fakeClientSource(): string {
	const generic = REQUIRED_RPC_METHODS.filter(
		(name) => !["start", "stop", "onEvent", "onSessionEvent", "onPromptResult"].includes(name),
	).map((name) => `\t${name}() { return Promise.resolve({}); }`);
	return [
		"export class RpcClient {",
		"\tconstructor(options) { this.options = options; }",
		// Like omp's own client: `--mode rpc` then the driver's `args` (`--no-title`, `--config …`, extra args).
		'\tstart() { this.options.spawn(["--mode", "rpc", ...(this.options.args ?? [])]); return Promise.resolve(); }',
		"\tstop() { return Promise.resolve(); }",
		"\tonEvent() { return () => {}; }",
		"\tonSessionEvent() { return () => {}; }",
		"\tonPromptResult() { return () => {}; }",
		...generic,
		"}",
		"",
	].join("\n");
}

/**
 * A fake omp install that `RpcOmpDriver.start()` accepts; its `ptree.spawn` records the argv and env of the child the
 * driver would start (the real ones: built by the driver itself) and returns a child that never exits.
 */
function fakeOmpInstall(): { ompExecutable: string; utilsModule: string } {
	const dir = tempDir("ompbot-profile-rpc-");
	const bin = join(dir, "pkg", "bin");
	mkdirSync(bin, { recursive: true });
	const ompExecutable = join(bin, "omp");
	writeFileSync(ompExecutable, "#!/bin/sh\nexit 1\n");
	chmodSync(ompExecutable, 0o755);
	const root = dirname(dirname(realpathSync(ompExecutable)));
	const client = join(root, "src/modes/rpc/rpc-client.ts");
	mkdirSync(dirname(client), { recursive: true });
	writeFileSync(client, fakeClientSource());
	const utilsDir = join(root, "node_modules/@oh-my-pi/pi-utils");
	mkdirSync(utilsDir, { recursive: true });
	writeFileSync(
		join(utilsDir, "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "0.0.0-fake", type: "module", main: "index.js" }),
	);
	const utilsModule = join(utilsDir, "index.js");
	writeFileSync(
		utilsModule,
		[
			"export const spawned = [];",
			"export const ptree = { spawn(cmd, options) { spawned.push({ cmd, env: options.env }); return {",
			"  pid: 4242, stdin: { write() {} }, stdout: new ReadableStream({ start() {} }),",
			"  peekStderr: () => '', kill() {}, exited: new Promise(() => {}),",
			"}; } };",
			"",
		].join("\n"),
	);
	return { ompExecutable, utilsModule };
}

/** The argv and env of the child a real `RpcOmpDriver` starts with `options` (on a fake install). */
async function rpcChild(
	options: Omit<RpcOmpDriverOptions, "ompExecutable" | "cwd" | "sessionDir">,
): Promise<{ cmd: string[]; env: Record<string, string> }> {
	const install = fakeOmpInstall();
	const work = tempDir("ompbot-profile-cwd-");
	const driver = new RpcOmpDriver({
		ompExecutable: install.ompExecutable,
		cwd: join(work, "ws"),
		sessionDir: join(work, "s"),
		bunExecutable: process.execPath,
		...options,
	});
	await driver.start();
	try {
		// Runtime path: the fixture module is written into a fresh temp dir per call.
		const utils = (await import(install.utilsModule)) as {
			spawned: Array<{ cmd: string[]; env: Record<string, string> }>;
		};
		const child = utils.spawned.at(-1);
		if (child === undefined) throw new Error("the driver did not spawn a child");
		// The install path differs per call; the argv after it is what the comparison is about.
		return { cmd: child.cmd.slice(2), env: child.env };
	} finally {
		await driver.stop();
	}
}

/** Every `omp -p` call of a fake runner. */
function recordingRunner(): {
	calls: Array<{ cmd: string[]; opts: RunProcessOptions }>;
	run: (cmd: string[], opts: RunProcessOptions) => Promise<{ code: number; stdout: string; timedOut: boolean }>;
} {
	const calls: Array<{ cmd: string[]; opts: RunProcessOptions }> = [];
	return {
		calls,
		run: async (cmd, opts) => {
			calls.push({ cmd, opts });
			return { code: 0, stdout: "OK\n", timedOut: false };
		},
	};
}

const PRINT = { task: "요약", cwd: "/ws", systemPromptAppendix: "FLOORS", ompBin: "/bin/omp" };

describe("AC-1: without ompProfile the children are what they were", () => {
	test("the daemon's rpc options are the old literal and the spawned child env/argv match the old options", async () => {
		expect(botRpcEnv(undefined, BASE)).toEqual({ env: { OMP_WIKI_NOTE_DISABLE: "1" } });
		const before = await rpcChild({ model: "m", env: { OMP_WIKI_NOTE_DISABLE: "1" }, extraArgs: ["--x"] });
		const after = await rpcChild({ model: "m", ...botRpcEnv(undefined, BASE), extraArgs: ["--x"] });
		expect(after).toEqual(before);
		// No baseEnv: the child env is the daemon's own process env minus bot secrets, as before.
		expect(after.env).toEqual(buildChildEnv({ OMP_WIKI_NOTE_DISABLE: "1" }));
	});

	test("runOmpPrint keeps the inherited agent dir, adds no OMP_PROFILE and keeps its argv", async () => {
		const { calls, run } = recordingRunner();
		await runOmpPrint({ ...PRINT, inheritedEnv: BASE, run });
		expect(calls[0]?.opts.env).toEqual(dispatchEnv(BASE));
		expect(calls[0]?.opts.env?.PI_CODING_AGENT_DIR).toBe("/custom/agent");
		expect(calls[0]?.opts.env).not.toHaveProperty("OMP_PROFILE");
		expect(calls[0]?.cmd).toEqual(["/bin/omp", "-p", "--no-session", "--append-system-prompt", "FLOORS", "--", "요약"]);
	});
});

describe("AC-2: ompProfile reaches every bot omp child", () => {
	test("rpc driver (chat, lane and monitor turns): OMP_PROFILE set, PI_CODING_AGENT_DIR and bot secrets gone", async () => {
		const plain = await rpcChild({ ...botRpcEnv(undefined), baseEnv: BASE });
		const child = await rpcChild(botRpcEnv("ompbot", BASE));
		expect(child.env.OMP_PROFILE).toBe("ompbot");
		expect(child.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
		expect(child.env).not.toHaveProperty("SLACK_BOT_TOKEN");
		expect(child.env).not.toHaveProperty("OMPBOT_HOME");
		expect(child.env).toMatchObject({ OMP_WIKI_NOTE_DISABLE: "1", FOO: "1", PATH: BASE.PATH });
		expect(child.cmd).toEqual(plain.cmd);
	});

	test("runOmpPrint with ompProfile: OMP_PROFILE set, PI_CODING_AGENT_DIR dropped, argv unchanged", async () => {
		const { calls, run } = recordingRunner();
		await runOmpPrint({ ...PRINT, inheritedEnv: BASE, run, ompProfile: "ompbot" });
		await runOmpPrint({ ...PRINT, inheritedEnv: BASE, run });
		expect(calls[0]?.opts.env?.OMP_PROFILE).toBe("ompbot");
		expect(calls[0]?.opts.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
		expect(calls[0]?.cmd).toEqual(calls[1]?.cmd as string[]);
	});

	test("an explicit env (Teams guest's own agent dir) still wins over the profile", async () => {
		const { calls, run } = recordingRunner();
		await runOmpPrint({ ...PRINT, inheritedEnv: BASE, run, ompProfile: "ompbot", env: { PI_CODING_AGENT_DIR: "/qa" } });
		expect(calls[0]?.opts.env?.PI_CODING_AGENT_DIR).toBe("/qa");
	});

	test("simple dispatch (ompbot_dispatch omp -p) runs with the configured profile", async () => {
		const { calls, run } = recordingRunner();
		const built = buildDispatchTool({
			originKey: "slack/dm/D0123456789",
			ompExecutable: "omp",
			ompProfile: "ompbot",
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			log: { info() {}, warn() {} },
			run,
		});
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/custom/agent";
		try {
			await built.execute({ task: "빌드 상태 요약" }, { signal: new AbortController().signal });
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]?.opts.env?.OMP_PROFILE).toBe("ompbot");
		expect(calls[0]?.opts.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
	});
});

describe("AC-3: ompProfile follows omp's profile name rule", () => {
	function homeWith(extra: Record<string, unknown>): string {
		const home = tempDir("ompbot-profile-cfg-");
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: { slack: { ownerUserId: "UOWNER0" } },
				slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" },
				ompExecutable: "/usr/local/bin/omp",
				workspaceDir: "workspace",
				...extra,
			}),
		);
		return home;
	}
	const load = (home: string) => loadConfig(home, { checkTokens: false });

	test.each([["Ompbot"], [".ompbot"], ["-x"], ["omp bot"], ["a/b"], [""], ["x".repeat(65)], [7]])(
		"%p is refused naming ompProfile",
		(value) => {
			let error: unknown;
			try {
				load(homeWith({ ompProfile: value }));
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(ConfigError);
			expect((error as ConfigError).message).toContain("ompProfile");
		},
	);

	test("a valid name loads, absent stays undefined, and changing it needs a restart", () => {
		expect(load(homeWith({ ompProfile: "ompbot" })).ompProfile).toBe("ompbot");
		expect(load(homeWith({ ompProfile: "a1._-z" })).ompProfile).toBe("a1._-z");
		expect(load(homeWith({ ompProfile: "x".repeat(64) })).ompProfile).toBe("x".repeat(64));
		expect(load(homeWith({})).ompProfile).toBeUndefined();
		expect(load(homeWith({})).warnings).toBeUndefined();
		expect(RESTART_FIELDS).toContain("ompProfile");
	});
});

describe("ompConfigOverlay: one --config for every omp child of the install", () => {
	const ORIGINS = ["slack/dm/D0123456789", "discord/ch/123456/t/789", "monitor/daily", "lane/L-20261115-01"];
	const GROUP = `teams/ch/${teamsAlias("19:abcdef0123456789@thread.v2")}`;
	const OLD_PRINT_ARGV = ["omp", "-p", "--no-session", "--append-system-prompt"];

	/** A loaded config (tokens unchecked) whose home has `overlay` as `glm.omp.yml`, set as `ompConfigOverlay` unless `null`. */
	function loaded(overlay: string | null, extra: Record<string, unknown> = {}): OmpbotConfig {
		const home = tempDir("ompbot-overlay-cfg-");
		if (overlay !== null) writeFileSync(join(home, "glm.omp.yml"), overlay);
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: { slack: { ownerUserId: "UOWNER0" } },
				slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" },
				ompExecutable: "/usr/local/bin/omp",
				workspaceDir: "workspace",
				...(overlay === null ? {} : { ompConfigOverlay: "glm.omp.yml" }),
				...extra,
			}),
		);
		return loadConfig(home, { checkTokens: false });
	}

	/** `config` with Teams Graph chat tools on (the group memory-off overlay applies to `teams/ch/*`). */
	function withTeamsGraph(config: OmpbotConfig): OmpbotConfig {
		const teams = {
			appId: "3e1d5752-881a-4244-b653-9d0dacfb9013",
			tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
			clientSecretFile: join(config.homeDir, "secrets", "teams-client-secret"),
			ownerAadObjectId: "0f5f9a3c-7e8b-4b5e-9a0e-3c2d1b0a9f8e",
			listen: "127.0.0.1:3978",
			graph: { tokenFile: join(config.homeDir, "secrets", "teams-graph-token") },
		};
		return { ...config, channels: { teams } };
	}

	async function simpleDispatchArgv(ompConfigOverlay: string | undefined): Promise<string[]> {
		const { calls, run } = recordingRunner();
		const built = buildDispatchTool({
			originKey: "slack/dm/D0123456789",
			ompExecutable: "omp",
			...(ompConfigOverlay === undefined ? {} : { ompConfigOverlay }),
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			log: { info() {}, warn() {} },
			run,
		});
		await built.execute({ task: "빌드 상태 요약" }, { signal: new AbortController().signal });
		expect(calls).toHaveLength(1);
		return calls[0]?.cmd ?? [];
	}

	test("AC-1: chat, monitor and lane RPC children and the simple dispatch run get --config <overlay>", async () => {
		const config = loaded("modelRoles:\n  default: zai/glm-5.3-flash\n");
		const overlay = join(config.homeDir, "glm.omp.yml");
		expect(config.ompConfigOverlay).toBe(overlay);
		for (const origin of ORIGINS) expect(rpcOverlayFor(config, origin)).toBe(overlay);
		const child = await rpcChild({
			model: "m",
			...botRpcEnv(undefined, BASE),
			overlayConfig: overlay,
			extraArgs: ["--x"],
		});
		expect(child.cmd).toEqual(["--mode", "rpc", "--no-title", "--config", overlay, "--x"]);
		const argv = await simpleDispatchArgv(overlay);
		expect(argv.slice(0, 6)).toEqual(["omp", "-p", "--no-session", "--config", overlay, "--append-system-prompt"]);
		expect(argv.slice(-2)).toEqual(["--", "빌드 상태 요약"]);
	});

	test("AC-2: without the key the RPC child argv and the simple dispatch argv are byte for byte the old ones", async () => {
		const config = loaded(null);
		expect("ompConfigOverlay" in config).toBe(false);
		for (const origin of [...ORIGINS, GROUP]) expect(rpcOverlayFor(config, origin)).toBeUndefined();
		// The daemon spreads `rpcOverlayFor`'s result only when defined: the options are the old literal.
		const before = await rpcChild({ model: "m", env: { OMP_WIKI_NOTE_DISABLE: "1" }, extraArgs: ["--x"] });
		expect(before.cmd).toEqual(["--mode", "rpc", "--no-title", "--x"]);
		const argv = await simpleDispatchArgv(undefined);
		expect(argv.slice(0, 4)).toEqual(OLD_PRINT_ARGV);
		expect(argv).toHaveLength(7);
		expect(argv).not.toContain("--config");
		// A Teams group keeps exactly its memory-off file when the install has no overlay.
		const teams = withTeamsGraph(config);
		expect(rpcOverlayFor(teams, GROUP)).toBe(teamsGroupOverlayPath(config.homeDir));
		expect(rpcOverlayFor(teams, ORIGINS[0] as string)).toBeUndefined();
	});

	test("a Teams group child gets one merged file: the overlay with memory forced off, re-read for each new child", () => {
		const config = withTeamsGraph(loaded('memory:\n  backend: "local"\nmodelRoles:\n  default: zai/glm-5.3-flash\n'));
		const overlay = join(config.homeDir, "glm.omp.yml");
		expect(rpcOverlayFor(config, ORIGINS[0] as string)).toBe(overlay);
		const merged = rpcOverlayFor(config, GROUP) ?? "";
		expect(dirname(merged)).toBe(config.homeDir);
		expect(merged).toMatch(/\/rpc-overlay\.[0-9a-f]{16}\.omp\.yml$/);
		expect(statSync(merged).mode & 0o777).toBe(0o600);
		expect(Bun.YAML.parse(readFileSync(merged, "utf8"))).toEqual({
			memory: { backend: "off" },
			modelRoles: { default: "zai/glm-5.3-flash" },
		});
		writeFileSync(overlay, "modelRoles:\n  default: zai/glm-5.3\n");
		const next = rpcOverlayFor(config, GROUP) ?? "";
		expect(next).not.toBe(merged);
		expect(Bun.YAML.parse(readFileSync(next, "utf8"))).toEqual({
			modelRoles: { default: "zai/glm-5.3" },
			memory: { backend: "off" },
		});
	});
});

test("a child whose dialogs reach the owner runs as rpc-ui (omp's ask tool needs a UI session); others stay rpc", async () => {
	const headless = await rpcChild({ model: "m", extraArgs: ["--x"] });
	expect(headless.cmd).toEqual(["--mode", "rpc", "--no-title", "--x"]);
	const answered = await rpcChild({ model: "m", extraArgs: ["--x"], answerDialog: async () => ({ value: "x" }) });
	expect(answered.cmd).toEqual(["--mode", "rpc", "--mode", "rpc-ui", "--no-title", "--x"]);
});
