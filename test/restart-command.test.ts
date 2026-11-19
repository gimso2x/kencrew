// `!restart` (doc/plans/owner-restart-command.md): the launcher's guards, preflight and unit, the report target, and
// the daemon paths around it (drain, IPC `notify`, the ⏳ status of a running turn). No real systemd-run: a fake runner.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESTART_DRAINING_TEXT } from "../src/core/types";
import { Daemon } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import {
	RESTART_LAUNCH_GUARD_MS,
	RestartLauncher,
	type RestartLauncherDeps,
	reportTargetOf,
} from "../src/daemon/restart";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import {
	APPLY_LOCK_FILE,
	detachedApplyCommand,
	isReportOrigin,
	type RunResult,
	reportThreadPattern,
} from "../src/ops/apply";
import { redact } from "../src/redact";
import {
	discordBinding,
	makeHome,
	OWNER_DM,
	ownerMessage,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";

const BUN = "/h/.bun/bin/bun";
const PATH_ENV = "/h/.bun/bin:/usr/bin";
const DISCORD_CH = "111111111111111111"; // gitleaks:allow (fake snowflake)
const DISCORD_ROOT = "222222222222222222"; // gitleaks:allow (fake snowflake)
const DM_ORIGIN = `discord/dm/${OWNER_DM}`;
/** A message id: `ts(1)` is the first, `ts(2)` the second (17 digits, like a snowflake). */
const ts = (n: number): string => `7000000000000000${n}`;
/** The thread ref of a DM message `n`. */
const dmRef = (n: number): string => `${OWNER_DM}:${ts(n)}`;

/** What the fake git/systemctl/systemd-run answer; every command is recorded. */
interface Host {
	branch: string;
	srcStatus: string;
	listUnits: string;
	listUnitsRc: number;
	systemdRunRc: number;
	commands: string[][];
}

const makeHost = (): Host => ({
	branch: "main",
	srcStatus: "",
	listUnits: "",
	listUnitsRc: 0,
	systemdRunRc: 0,
	commands: [],
});

function fakeRun(host: Host) {
	return async (cmd: string[]): Promise<RunResult> => {
		host.commands.push(cmd);
		const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
		if (cmd[0] === "git") {
			const sub = cmd.slice(3);
			if (sub[0] === "branch") return ok(`${host.branch}\n`);
			if (sub[0] === "rev-parse" && sub.at(-1) === "--absolute-git-dir") return ok("/nonexistent-git-dir\n");
			if (sub[0] === "rev-parse") return ok(`${"a".repeat(40)}\n`);
			if (sub[0] === "status") return ok(host.srcStatus);
		}
		if (cmd[0] === "systemctl" && cmd[2] === "list-units")
			return { code: host.listUnitsRc, stdout: host.listUnits, stderr: host.listUnitsRc === 0 ? "" : "no bus" };
		if (cmd[0] === "systemd-run")
			return { code: host.systemdRunRc, stdout: "", stderr: host.systemdRunRc === 0 ? "" : "Unit already exists" };
		throw new Error(`unexpected command ${cmd.join(" ")}`);
	};
}

const spawns = (host: Host) => host.commands.filter((cmd) => cmd[0] === "systemd-run");

describe("reportTargetOf (AC-3b)", () => {
	const passes = (target: { origin: string; thread?: string } | undefined) =>
		target !== undefined &&
		isReportOrigin(target.origin) &&
		(target.thread === undefined || reportThreadPattern().test(target.thread));

	test("Discord channel threads, DMs and a lane resolve to a report origin and root apply accepts", () => {
		const cases: Array<[string, string, { origin: string; thread?: string }]> = [
			[
				`discord/ch/${DISCORD_CH}/t/${DISCORD_ROOT}`,
				`${DISCORD_CH}:${DISCORD_ROOT}`,
				{ origin: `discord/ch/${DISCORD_CH}`, thread: DISCORD_ROOT },
			],
			[DM_ORIGIN, dmRef(1), { origin: DM_ORIGIN, thread: ts(1) }],
			["ompbot/work/fix-b", dmRef(2), { origin: `discord/ch/${OWNER_DM}`, thread: ts(2) }],
			[
				"ompbot/work/fix-c",
				`${DISCORD_CH}:${DISCORD_ROOT}`,
				{ origin: `discord/ch/${DISCORD_CH}`, thread: DISCORD_ROOT },
			],
			// A command at the top level of a channel: the report goes to that channel's top level.
			[`discord/ch/${DISCORD_CH}`, `${DISCORD_CH}:-`, { origin: `discord/ch/${DISCORD_CH}` }],
		];
		for (const [origin, threadRef, expected] of cases) {
			const target = reportTargetOf(origin, threadRef);
			expect(target).toEqual(expected);
			expect(passes(target)).toBe(true);
		}
	});

	test("Teams, monitors, a ref of another conversation and a malformed root resolve to nothing", () => {
		for (const [origin, threadRef] of [
			["teams/dm/t0123456789abcdef", "t0123456789abcdef:act1"],
			["monitor/self-retro", `${DISCORD_CH}:-`],
			[`discord/ch/${DISCORD_CH}/t/${DISCORD_ROOT}`, `${OWNER_DM}:${DISCORD_ROOT}`],
			[DM_ORIGIN, `${OWNER_DM}:not-a-ts`],
			["ompbot/work/fix-a", "t0123456789abcdef:act1"],
			["ompbot/work/fix-a", "garbage"],
			["slack/dm/D1", "D1:1700.000001"],
		] as const) {
			expect(reportTargetOf(origin, threadRef)).toBeUndefined();
		}
	});
});

describe("RestartLauncher (AC-3, fake spawnRunner)", () => {
	let home: string;
	let host: Host;
	let now: number;
	let alive: boolean;
	let turns: boolean;

	const launcher = (over: Partial<RestartLauncherDeps> = {}) =>
		new RestartLauncher({
			homeDir: home,
			repoDir: "/r",
			pathEnv: PATH_ENV,
			run: fakeRun(host),
			isAlive: () => alive,
			isExecutable: (path) => path === BUN,
			now: () => now,
			turnsRunning: () => turns,
			log: createLogger({ sink: () => undefined, clock: { now: () => now }, redact }),
			...over,
		});

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "ompbot-restart-"));
		host = makeHost();
		now = new Date(2026, 10, 14, 19, 15, 0).getTime();
		alive = true;
		turns = false;
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	test("launches apply with the normalized report flags through the same builder as apply --detach", async () => {
		const answer = await launcher().request(
			`discord/ch/${DISCORD_CH}/t/${DISCORD_ROOT}`,
			`${DISCORD_CH}:${DISCORD_ROOT}`,
		);
		expect(answer).toBe("🔄 재시작을 접수했습니다(apply-20261114-191500). 결과는 이 스레드에 알립니다.");
		const [argv] = spawns(host);
		const childArgs = [
			"apply",
			"--stamp",
			"20261114-191500",
			"--report-origin",
			`discord/ch/${DISCORD_CH}`,
			"--report-thread",
			DISCORD_ROOT,
			"--report-plain",
		];
		const unit = /^--unit=(ompbot-apply-20261114-191500-[0-9a-f]{4})$/.exec(argv?.[3] ?? "")?.[1];
		expect(unit).toBeDefined();
		const built = detachedApplyCommand({
			bun: BUN,
			repoDir: "/r",
			pathEnv: PATH_ENV,
			stamp: "20261114-191500",
			childArgs,
		});
		expect(argv).toEqual(built.argv.map((arg) => (arg === `--unit=${built.unit}` ? `--unit=${unit}` : arg)));
	});

	test("while a turn runs the answer says the drain waits and how not to wait (!stop)", async () => {
		turns = true;
		const answer = await launcher().request(DM_ORIGIN, dmRef(1));
		expect(answer).toContain("돌고 있는 턴은 최대 5분 기다린 뒤 끊고 재시작 뒤 이어갑니다.");
		expect(answer).toContain("기다리지 않으려면 먼저 `!stop`을 보내세요.");
	});

	test("this process's own launch: a second !restart (also two at once) spawns nothing more", async () => {
		const restart = launcher();
		const [a, b] = await Promise.all([restart.request(DM_ORIGIN, dmRef(1)), restart.request(DM_ORIGIN, dmRef(2))]);
		expect(a).toStartWith("🔄 재시작을 접수했습니다");
		expect(b).toBe("이미 재시작이 진행 중입니다(접수 중)");
		const again = await restart.request(DM_ORIGIN, dmRef(3));
		expect(again).toMatch(/^이미 재시작이 진행 중입니다\(ompbot-apply-20261114-191500-[0-9a-f]{4}\)$/);
		expect(spawns(host)).toHaveLength(1);
		// Past the guard the unit list and the apply lock speak for a restart still going; none here, so it launches.
		now += RESTART_LAUNCH_GUARD_MS;
		expect(await restart.request(DM_ORIGIN, dmRef(4))).toStartWith("🔄 재시작을 접수했습니다");
		expect(spawns(host)).toHaveLength(2);
	});

	test("a live apply holding apply.lock answers in progress; a dead holder's lock does not", async () => {
		writeFileSync(
			join(home, APPLY_LOCK_FILE),
			JSON.stringify({ pid: 4242, stamp: "20261114-190000", startedAt: "2026-11-14T10:00:00.000Z" }),
		);
		expect(await launcher().request(DM_ORIGIN, dmRef(1))).toBe("이미 재시작이 진행 중입니다(apply-20261114-190000)");
		expect(spawns(host)).toHaveLength(0);
		alive = false;
		expect(await launcher().request(DM_ORIGIN, dmRef(1))).toStartWith("🔄 재시작을 접수했습니다");
	});

	test("an active ompbot-apply-* unit answers in progress with its name", async () => {
		host.listUnits = "ompbot-apply-20261114-190000-ab12.service loaded active running /h/.bun/bin/bun …\n";
		expect(await launcher().request(DM_ORIGIN, dmRef(1))).toBe(
			"이미 재시작이 진행 중입니다(ompbot-apply-20261114-190000-ab12)",
		);
		const list = host.commands.find((cmd) => cmd[2] === "list-units");
		expect(list?.at(-1)).toBe("ompbot-apply-*");
		expect(spawns(host)).toHaveLength(0);
	});

	test("a checkout apply would SKIP is refused up front with the reason and what to do by hand", async () => {
		host.branch = "task/x";
		const notMain = await launcher().request(DM_ORIGIN, dmRef(1));
		expect(notMain).toStartWith('⚠️ 재시작하지 않았습니다: checkout is on branch "task/x", not main');
		expect(notMain).toContain("다시 `!restart`");
		host.branch = "main";
		host.srcStatus = " M src/daemon/daemon.ts\n";
		expect(await launcher().request(DM_ORIGIN, dmRef(1))).toContain("uncommitted changes under src: 1 file(s)");
		expect(spawns(host)).toHaveLength(0);
	});

	test("an origin with no report target is refused without a spawn", async () => {
		const answer = await launcher().request("ompbot/work/fix-a", "garbage");
		expect(answer).toStartWith("⚠️ 재시작하지 않았습니다: 결과를 알릴 곳");
		expect(spawns(host)).toHaveLength(0);
	});

	test("a failed systemd-run answers the reason and leaves the next !restart free to try", async () => {
		host.systemdRunRc = 1;
		const restart = launcher();
		expect(await restart.request(DM_ORIGIN, dmRef(1))).toBe(
			"⚠️ 재시작을 시작하지 못했습니다: systemd-run rc=1 Unit already exists",
		);
		host.systemdRunRc = 0;
		expect(await restart.request(DM_ORIGIN, dmRef(1))).toStartWith("🔄 재시작을 접수했습니다");
		expect(spawns(host)).toHaveLength(2);
	});
});

describe("!restart through the daemon", () => {
	let home: TestHome;
	let daemon: Daemon;
	let discord: WaitingDiscordTransport;
	let host: Host;
	let drivers: FakeOmpDriver[];
	const sessions = new FakeSessionStore();

	async function boot(holdTurns = false): Promise<Daemon> {
		discord = new WaitingDiscordTransport();
		const started = new Daemon({
			config: home.config,
			channels: [discordBinding(discord)],
			log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact }),
			ompVersion: "omp-test 0",
			bootId: `boot-${Math.random()}`,
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			stopDrainMs: 250,
			restart: { run: fakeRun(host), isExecutable: (path) => path === BUN, pathEnv: PATH_ENV, repoDir: "/r" },
			driverFactory: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns });
				drivers.push(driver);
				return driver;
			},
		});
		await started.start();
		return started;
	}

	beforeEach(() => {
		home = makeHome("ompbot-restart-daemon-");
		host = makeHost();
		drivers = [];
	});

	afterEach(async () => {
		await daemon.stop();
		home.remove();
	});

	const dm = (text: string, n: number) => discord.emitMessage(ownerMessage(ts(n), text));

	test("AC-3c: during a drain a !restart is answered at once, nothing pending", async () => {
		daemon = await boot();
		daemon.setDraining(true);
		await dm("!restart", 1);
		await discord.waitForPosts((text) => text === RESTART_DRAINING_TEXT);
		await dm("!restart", 2);
		await discord.waitForPosts((text) => text === RESTART_DRAINING_TEXT, 2);
		const rows = daemon.store.listInbound();
		expect(rows).toHaveLength(2);
		expect(rows.filter((row) => row.state === "pending")).toEqual([]);
		expect(daemon.store.listDeliveries({}).every((d) => d.opRef.startsWith("restart:"))).toBe(true);
		// The next process resumes whatever is pending: no !restart is among it, so nothing launches.
		await daemon.stop();
		daemon = await boot();
		daemon.setDraining(false);
		expect(spawns(host)).toHaveLength(0);
		expect(drivers).toHaveLength(0);
	});

	test("AC-3: outside a drain the !restart launches one unit and the answer lands in its thread", async () => {
		daemon = await boot();
		await dm("!restart", 1);
		await discord.waitForPosts((text) => text.startsWith("🔄 재시작을 접수했습니다"));
		const [argv] = spawns(host);
		expect(argv).toContain("--report-plain");
		expect(argv?.slice(argv.indexOf("--report-origin"), argv.indexOf("--report-origin") + 4)).toEqual([
			"--report-origin",
			DM_ORIGIN,
			"--report-thread",
			ts(1),
		]);
		expect(drivers).toHaveLength(0);
	});

	test("AC-5: IPC notify posts one delivery in the thread with no inbound row, turn or omp session; bad input is refused", async () => {
		daemon = await boot();
		const socket = join(home.dir, "ompbot.sock");
		expect(
			await callDaemon(socket, {
				op: "notify",
				origin: DM_ORIGIN,
				thread: ts(5),
				stamp: "20261114-191500",
				text: "✅ 재시작 완료 · aaaaaaa · gates 이상 없음\n영수증 /h/logs/apply-20261114-191500.json",
			}),
		).toEqual({ ok: true, opRef: "notify:20261114-191500" });
		await discord.waitForPosts((text) => text.startsWith("✅ 재시작 완료"));
		const post = discord.posts((text) => text.startsWith("✅ 재시작 완료"))[0];
		expect(post?.channelId).toBe(OWNER_DM);
		expect(post?.messageReference?.messageId).toBe(ts(5));
		expect(daemon.store.listDeliveries({}).map((d) => [d.opRef, d.threadRef])).toEqual([
			["notify:20261114-191500", dmRef(5)],
		]);
		expect(daemon.store.listInbound()).toEqual([]);
		expect(drivers).toHaveLength(0);
		for (const bad of [
			{ op: "notify", origin: `discord/ch/${DISCORD_CH}/t/${DISCORD_ROOT}`, text: "x" },
			{ op: "notify", origin: "teams/dm/t0123456789abcdef", text: "x" },
			{ op: "notify", origin: "slack/dm/D1", text: "x" },
			{ op: "notify", origin: DM_ORIGIN, text: "   " },
			{ op: "notify", origin: DM_ORIGIN },
			{ op: "notify", origin: DM_ORIGIN, thread: "not-a-ts", text: "x" },
		]) {
			expect(await callDaemon(socket, bad)).toMatchObject({ ok: false });
		}
		expect(daemon.store.listDeliveries({})).toHaveLength(1);
	});

	test("AC-3d: the restart answer and a notify line in a running turn's thread leave its ⏳ status and 👀 alone", async () => {
		daemon = await boot(true);
		await dm("긴 작업", 1);
		await discord.waitForPosts((text) => text.startsWith("⏳"));
		const statusId = discord.posts((text) => text.startsWith("⏳"))[0]?.id;
		await dm("!restart", 2);
		await discord.waitForPosts((text) => text.startsWith("🔄 재시작을 접수했습니다"));
		const accepted = discord.posts((text) => text.startsWith("🔄 재시작을 접수했습니다"))[0]?.content ?? "";
		expect(accepted).toContain("기다리지 않으려면 먼저 `!stop`");
		const thread = daemon.store.getInbound(dmRef(1))?.threadRef ?? "";
		const root = thread.slice(thread.indexOf(":") + 1);
		await callDaemon(join(home.dir, "ompbot.sock"), {
			op: "notify",
			origin: DM_ORIGIN,
			thread: root,
			text: "⚠️ 재시작 skipped · aaaaaaa",
		});
		await discord.waitForPosts((text) => text.startsWith("⚠️ 재시작 skipped"));
		await daemon.pump();
		expect(discord.calls.filter((c) => c.method === "deleteMessage")).toEqual([]);
		const statusUpdates = discord.calls.flatMap((c) =>
			c.method === "editMessage" && c.messageId === statusId ? [c.content ?? ""] : [],
		);
		expect(statusUpdates.filter((text) => !text.startsWith("⏳"))).toEqual([]);
		expect(discord.calls.filter((c) => c.method === "addReaction" && c.emoji === "✅")).toEqual([]);
		expect(daemon.store.getInbound(dmRef(1))?.state).toBe("dispatched");
	});

	test("AC-3d: a notify line in a thread with no running status is not stamped ✅ (finishUntracked)", async () => {
		daemon = await boot();
		await callDaemon(join(home.dir, "ompbot.sock"), {
			op: "notify",
			origin: DM_ORIGIN,
			thread: ts(9),
			text: "✅ 재시작 완료 · aaaaaaa · gates 이상 없음",
		});
		await discord.waitForPosts((text) => text.startsWith("✅ 재시작 완료"));
		await daemon.pump();
		expect(discord.calls.filter((c) => c.method === "addReaction")).toEqual([]);
	});
});
