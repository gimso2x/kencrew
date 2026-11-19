import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { planReload, RESTART_FIELDS } from "../src/daemon/reload";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import {
	BOT,
	CHANNEL,
	discordBinding,
	GUILD,
	makeHome,
	OWNER,
	OWNER_DM,
	ownerMessage,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { killSpawned, runMain, spawnDaemon } from "./helpers/daemon-process";
import { ROOMY_STATFS } from "./helpers/disk";

let home: TestHome;
let daemon: Daemon | undefined;

beforeEach(() => {
	home = makeHome("ompbot-reload-");
	daemon = undefined;
});

afterEach(async () => {
	killSpawned();
	await daemon?.stop();
	home.remove();
});

/** Rewrites config.json with `patch` merged over what makeHome wrote. */
function patchConfig(patch: Record<string, unknown>): void {
	const path = join(home.dir, "config.json");
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }), { mode: 0o600 });
}

describe("planReload", () => {
	test("live fields follow the file (a removed one is removed); restart-bound and CLI fields are only reported", () => {
		const current = { ...home.config, recallEnabled: false, skillReviewTurns: 10 };
		const fresh = {
			...home.config,
			costCap: { dailyUsd: 300 },
			skillReviewTurns: 10,
			model: "p/m",
			sessionRetentionDays: 7,
		};
		const plan = planReload(current, fresh);
		expect(plan.changed).toEqual(["recallEnabled", "costCap"]);
		expect(plan.restartRequired).toEqual(["model"]);
		expect(plan.cli).toEqual(["sessionRetentionDays"]);
		expect(plan.next.costCap).toEqual({ dailyUsd: 300 });
		expect("recallEnabled" in plan.next).toBe(false);
		expect(plan.next.model).toBeUndefined();
	});

	test("herdr is restart-bound: reported, never applied live", () => {
		const plan = planReload({ ...home.config }, { ...home.config, herdr: {} });
		expect(plan.changed).toEqual([]);
		expect(plan.restartRequired).toEqual(["herdr"]);
		expect(plan.next.herdr).toBeUndefined();
	});

	test("ompConfigOverlay is restart-bound: set, changed or removed, it is reported and never applied live", () => {
		const glm = join(home.dir, "glm.omp.yml");
		for (const [current, fresh] of [
			[undefined, glm],
			[glm, join(home.dir, "other.omp.yml")],
			[glm, undefined],
		] as const) {
			const plan = planReload(
				{ ...home.config, ...(current === undefined ? {} : { ompConfigOverlay: current }) },
				{ ...home.config, ...(fresh === undefined ? {} : { ompConfigOverlay: fresh }) },
			);
			expect(plan.changed).toEqual([]);
			expect(plan.restartRequired).toEqual(["ompConfigOverlay"]);
			expect(plan.next.ompConfigOverlay).toBe(current);
		}
		expect(RESTART_FIELDS).toContain("ompConfigOverlay");
	});

	test("channels is restart-bound: a changed owner is reported and the running one kept", () => {
		expect(RESTART_FIELDS).toContain("channels");
		const discord = home.config.channels.discord;
		if (discord === undefined) throw new Error("expected channels.discord");
		const changed = planReload(
			{ ...home.config },
			{ ...home.config, channels: { discord: { ...discord, ownerUserId: "100000000000000009" } } },
		);
		expect(changed.restartRequired).toEqual(["channels"]);
		expect(changed.next.channels.discord?.ownerUserId).toBe(OWNER);
	});

	test("recallEnabled applies live", () => {
		const plan = planReload({ ...home.config }, { ...home.config, recallEnabled: false });
		expect(plan.changed).toEqual(["recallEnabled"]);
		expect(plan.restartRequired).toEqual([]);
		expect(plan.next.recallEnabled).toBe(false);
	});

	test("costCap applies live: a new ceiling is taken without a restart, a removed one is dropped", () => {
		const added = planReload({ ...home.config }, { ...home.config, costCap: { turnUsd: 20, dailyUsd: 300 } });
		expect(added.changed).toEqual(["costCap"]);
		expect(added.restartRequired).toEqual([]);
		expect(added.next.costCap).toEqual({ turnUsd: 20, dailyUsd: 300 });
		const removed = planReload({ ...home.config, costCap: { dailyUsd: 300 } }, { ...home.config });
		expect(removed.changed).toEqual(["costCap"]);
		expect(removed.next.costCap).toBeUndefined();
	});
});

test("ompbot reload applies a live field and refreshes last-good; an invalid file keeps the running config", async () => {
	const transport = new WaitingDiscordTransport();
	const clock = { now: () => Date.now() };
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: home.config,
		channels: [discordBinding(transport)],
		clock,
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot-reload",
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
	// boot: daemon_ready recorded the config it started with
	expect(JSON.parse(readFileSync(join(home.dir, "config.json.last-good"), "utf8")).channels.discord.ownerUserId).toBe(
		OWNER,
	);

	patchConfig({ recallEnabled: false, model: "p/m" });
	const reloaded = await runMain(home.dir, ["reload"]);
	expect(reloaded.code).toBe(0);
	expect(reloaded.stdout).toBe("config_reloaded changed=recallEnabled restart_required=model cli=-\n");

	const lastGood = join(home.dir, "config.json.last-good");
	// model is restart-bound and was never booted on: this file is not a rollback target yet
	expect(JSON.parse(readFileSync(lastGood, "utf8")).model).toBeUndefined();
	patchConfig({ model: undefined });
	const liveOnly = await runMain(home.dir, ["reload"]);
	expect(liveOnly.stdout).toContain("restart_required=-");
	expect(JSON.parse(readFileSync(lastGood, "utf8")).recallEnabled).toBe(false); // fully applied: refreshed
	expect(statSync(lastGood).mode & 0o777).toBe(0o600);
	writeFileSync(join(home.dir, "config.json"), "{ not json", { mode: 0o600 });
	const broken = await runMain(home.dir, ["reload"]);
	expect(broken.code).toBe(1);
	expect(broken.stderr).toContain("reload failed, config unchanged: config_invalid_json");
	expect(readFileSync(lastGood, "utf8")).not.toContain("not json"); // a failed reload never becomes the rollback target
});

describe("peer bot policy reload", () => {
	const PEER = "200000000000000001";
	const THREAD = "700000000000000001";

	test("peerHopLimit is a live field", () => {
		const plan = planReload({ ...home.config }, { ...home.config, peerHopLimit: { turns: 1, windowMinutes: 5 } });
		expect(plan.changed).toEqual(["peerHopLimit"]);
		expect(plan.restartRequired).toEqual([]);
		expect(plan.next.peerHopLimit).toEqual({ turns: 1, windowMinutes: 5 });
	});

	test("a reload reaches the running Discord adapter: the hop limit applies to the next peer message", async () => {
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		transport.setChannel({ id: THREAD, type: 11, parentId: CHANNEL, guildId: GUILD });
		const clock = { now: () => Date.now() };
		const sessions = new FakeSessionStore();
		const discord = home.config.channels.discord;
		if (discord === undefined) throw new Error("home without channels.discord");
		daemon = new Daemon({
			config: { ...home.config, channels: { discord: { ...discord, peerBots: [{ userId: PEER, name: "떡" }] } } },
			channels: [discordBinding(transport, { peerBots: [{ userId: PEER, name: "떡" }] })],
			clock,
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot-reload-peer",
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		let seq = 0n;
		const peerPost = async (): Promise<string> => {
			seq += 1n;
			const id = String(710_000_000_000_000_000n + seq);
			await transport.emitMessage({
				id,
				channel_id: THREAD,
				guild_id: GUILD,
				author: { id: PEER, bot: true },
				content: `<@${BOT}> 검토 부탁`,
				type: 0,
			});
			return `${CHANNEL}:${id}`;
		};
		const row = (key: string) => daemon?.store.getInbound(key);
		const peerBots = [{ userId: PEER, name: "떡" }];
		// peerBots lives under channels.discord (restart-bound): the file keeps the same list, only the cap changes.
		const path = join(home.dir, "config.json");
		const writeFile = (top: Record<string, unknown>) => {
			const base = JSON.parse(readFileSync(path, "utf8"));
			base.channels.discord.peerBots = peerBots;
			delete base.peerHopLimit;
			writeFileSync(path, JSON.stringify({ ...base, ...top }), { mode: 0o600 });
		};

		expect(row(await peerPost())?.peerUserId).toBe(PEER); // default cap: 3 turns

		writeFile({ peerHopLimit: { turns: 1, windowMinutes: 30 } });
		expect(daemon.reloadConfig("ipc")).toMatchObject({ ok: true, changed: ["peerHopLimit"] });
		expect(row(await peerPost())).toBeUndefined(); // the reloaded limit (1 turn) caps the thread

		writeFile({});
		expect(daemon.reloadConfig("ipc")).toMatchObject({ ok: true, changed: ["peerHopLimit"] });
		expect(row(await peerPost())?.peerUserId).toBe(PEER); // limit removed: back to the default
	});
});

test("reloading a config that turns herdr on answers restartRequired with herdr", async () => {
	const clock = { now: () => Date.now() };
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: home.config,
		channels: [discordBinding(new WaitingDiscordTransport())],
		clock,
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot-reload-herdr",
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
	patchConfig({ herdr: {} });
	const result = daemon.reloadConfig("ipc");
	expect(result).toMatchObject({ ok: true, restartRequired: ["herdr"] });
});

describe("boot last-good", () => {
	async function boot(bootConfigText: string | undefined): Promise<string[]> {
		const lines: string[] = [];
		const clock = { now: () => Date.now() };
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: home.config,
			bootConfigText,
			channels: [discordBinding(new WaitingDiscordTransport())],
			clock,
			log: createLogger({ sink: (line) => void lines.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot-last-good",
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		return lines;
	}
	const lastGood = () => join(home.dir, "config.json.last-good");

	test("records exactly the text loadConfig read; a file changed after loadConfig is never recorded", async () => {
		const loaded = readFileSync(join(home.dir, "config.json"), "utf8");
		patchConfig({ model: "p/unvalidated" }); // edited between loadConfig and Daemon.start
		const lines = await boot(loaded);
		expect(existsSync(lastGood())).toBe(false);
		expect(lines.some((l) => l.includes("event=last_good_config_skipped reason=config_changed_since_boot"))).toBe(true);
		await daemon?.stop();
		writeFileSync(join(home.dir, "config.json"), loaded, { mode: 0o600 });
		await boot(loaded);
		expect(readFileSync(lastGood(), "utf8")).toBe(loaded);
	});

	test("without the text loadConfig read the reason is config_unreadable and nothing is recorded", async () => {
		const lines = await boot(undefined);
		expect(existsSync(lastGood())).toBe(false);
		expect(lines.some((l) => l.includes("event=last_good_config_skipped reason=config_unreadable"))).toBe(true);
	});
});

test("real daemon process: SIGHUP reloads config.json instead of stopping", async () => {
	const spawned = spawnDaemon(home.dir, join(home.dir, "transport.jsonl"));
	await spawned.waitLog(/event=daemon_ready/);
	patchConfig({ recallEnabled: false, watcherRoots: [home.dir] });
	spawned.signal("SIGHUP");
	const line = await spawned.waitLog(/event=config_reloaded/);
	expect(line).toContain("trigger=sighup");
	expect(line).toContain("changed=recallEnabled");
	expect(line).toContain("restart_required=watcherRoots");
	expect(JSON.parse((await runMain(home.dir, ["status", "--json"])).stdout)).toMatchObject({ daemonRunning: true });
	spawned.signal("SIGTERM");
	expect(await spawned.exited).toBe(0);
});

test("AC-9 (T-20261115-03): a reloaded lanes.models.middle reaches the next [TASK] through the running daemon's dispatch tool", async () => {
	const transport = new WaitingDiscordTransport();
	const clock = { now: () => Date.now() };
	const sessions = new FakeSessionStore();
	const live = { herdr: {} };
	patchConfig({ ...live, lanes: { models: { middle: "a/one" } } });
	daemon = new Daemon({
		config: { ...home.config, ...live, lanes: { models: { middle: "a/one" } } },
		channels: [discordBinding(transport)],
		clock,
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot-reload-tier",
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		statfs: ROOMY_STATFS, // the [TASK] start's disk check never depends on this machine's free space
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
	const running = daemon;
	await transport.emitMessage(ownerMessage("600000000000000001", "[TASK] 등록해줘"));
	await transport.waitForPosts((text) => text.includes("ECHO [TASK] 등록해줘"));
	// Fixture: the ledger records the worker model the real tool path hands it. The repo is a plain directory, so the
	// start stops at `git worktree add` (before any herdr call) and the registration is undone.
	const ledger = running.store.tasks;
	const register = ledger.register.bind(ledger);
	const models: Array<string | null | undefined> = [];
	ledger.register = (input) => {
		models.push(input.worker?.model);
		return register(input);
	};
	// The tool is taken once, before the reload: only a per-call read of the config can see the new model.
	const tool = running.hostToolsFor(`discord/dm/${OWNER_DM}`).find((t) => t.name === "ompbot_dispatch");
	if (tool === undefined) throw new Error("dispatch tool missing");
	const repo = mkdtempSync(join(tmpdir(), "ompbot-reload-tier-"));
	try {
		const register1 = () =>
			tool.execute(
				{ task: "구현", taskSpec: { title: "t", risk: "L2", goal: "g", acceptance: ["a"], repo } },
				{ signal: new AbortController().signal },
			);
		expect(await register1()).toStartWith("시작 실패: git worktree add failed");
		patchConfig({ ...live, lanes: { models: { middle: "b/two" } } });
		expect(running.reloadConfig("ipc")).toMatchObject({ ok: true, changed: ["lanes"] });
		expect(await register1()).toStartWith("시작 실패: git worktree add failed");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
	expect(models).toEqual(["a/one", "b/two"]);
});
