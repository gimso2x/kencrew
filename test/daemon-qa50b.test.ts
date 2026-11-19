// qa50b lane I (doc/plans/qa50b-low-fixes.md): daemon items driven through the real daemon with fake transports.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import { Daemon } from "../src/daemon/daemon";
import {
	RESTART_NOTICE_FILE,
	RESTART_NOTICE_TEXT,
	takeRestartMarker,
	writeRestartMarker,
} from "../src/daemon/restart-notice";
import { fatalHandler } from "../src/daemon/run";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { createAggregatingLogger } from "../src/ops/log-hygiene";
import { redact } from "../src/redact";
import {
	CHANNEL,
	discordBinding,
	GUILD,
	makeHome,
	OWNER_DM,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";
import { isRoot } from "./helpers/privileges";

let home: TestHome;
let repos: string[];
let daemon: Daemon | undefined;
let transport: WaitingDiscordTransport;
let logLines: string[];
const DM_ORIGIN = `discord/dm/${OWNER_DM}`;
/** Lanes open from a server channel (a DM has no threads). */
const CH_ORIGIN = `discord/ch/${CHANNEL}`;

beforeEach(() => {
	home = makeHome("ompbot-qa50b-i-");
	repos = [];
	transport = new WaitingDiscordTransport();
	logLines = [];
	daemon = undefined;
});

afterEach(async () => {
	await daemon?.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

async function startDaemon(): Promise<Daemon> {
	const sessions = new FakeSessionStore();
	const clock = { now: () => Date.now() };
	transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
	daemon = new Daemon({
		config: home.config,
		channels: [discordBinding(transport)],
		log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
	return daemon;
}

describe("qa-r #16: the restart notice waits for the IPC server", () => {
	const backPosts = () => transport.posts((text) => text === RESTART_NOTICE_TEXT.back);

	test("a start that fails before the IPC server is up sends no 'back' notice and keeps the marker", async () => {
		writeRestartMarker(home.dir, { at: Date.now(), threads: [`${OWNER_DM}:700000000000000005`] });
		mkdirSync(join(home.dir, "ompbot.sock")); // the socket path is a directory: the IPC server cannot start
		await expect(startDaemon()).rejects.toThrow();
		expect(backPosts()).toHaveLength(0);
		expect(existsSync(join(home.dir, RESTART_NOTICE_FILE))).toBe(true);
	});

	test("a normal start sends one notice, consumes the marker, and says it before a recovered turn's answer", async () => {
		const seed = openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() }, "Asia/Seoul");
		seed.ensureOrigin(DM_ORIGIN, "sess/e1");
		seed.recordInbound({
			originKey: DM_ORIGIN,
			platformMessageId: `${OWNER_DM}:700000000000000005`,
			textRef: "left-pending",
			threadRef: `${OWNER_DM}:700000000000000005`,
		});
		seed.close();
		writeRestartMarker(home.dir, { at: Date.now(), threads: [`${OWNER_DM}:700000000000000005`] });
		await startDaemon();
		await transport.waitForPosts((text) => text.includes("ECHO left-pending"));
		await transport.waitForPosts((text) => text === RESTART_NOTICE_TEXT.back);
		expect(backPosts()).toHaveLength(1);
		expect(existsSync(join(home.dir, RESTART_NOTICE_FILE))).toBe(false);
		const texts = transport.posts().map((call) => call.content ?? "");
		expect(texts.indexOf(RESTART_NOTICE_TEXT.back)).toBeLessThan(
			texts.findIndex((text) => text.includes("ECHO left-pending")),
		);
	});
});

describe("I-8: a lane trigger during a restart drain", () => {
	test("starts no lane (no worktree, no lane row) and says to ask again after the restart", async () => {
		const repo = makeRepo(repos);
		const d = await startDaemon();
		d.setDraining(true);
		await d.inject({ origin: CH_ORIGIN, asOwner: true, text: `작업: ask @${repo}` });
		await transport.waitForPosts((text) => text.includes("작업 레인을 시작하지 않았습니다"));
		expect(d.store.getLane("ask")).toBeUndefined();
		expect(transport.posts((text) => text.includes("시작했습니다"))).toHaveLength(0);
	});
});

describe("a lane started by the 작업: message", () => {
	test("records the starting conversation as meta.parentOrigin", async () => {
		const repo = makeRepo(repos);
		const d = await startDaemon();
		const { threadRef } = await d.inject({ origin: CH_ORIGIN, asOwner: true, text: `작업: ask @${repo}` });
		await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore"));
		// The injected marker's thread is the starting conversation.
		expect(d.store.getLane("ask")?.meta.parentOrigin).toBe(`${CH_ORIGIN}/t/${threadRef.split(":")[1]}`);
	});
});

describe("I-14/I-15: inject arguments", () => {
	test("a --thread that is not a message id is refused before anything is posted", async () => {
		const d = await startDaemon();
		for (const thread of ["not-a-ts", "a:b", "1800000000"]) {
			await expect(d.inject({ origin: DM_ORIGIN, asOwner: true, text: "x", thread })).rejects.toThrow(
				"inject thread is not a message id",
			);
		}
		expect(transport.posts()).toHaveLength(0);
	});

	test("an origin of the removed Slack platform is refused before anything is posted", async () => {
		const d = await startDaemon();
		await expect(d.inject({ origin: "slack/dm/D1", asOwner: true, text: "x" })).rejects.toThrow(
			"inject origin must be discord/dm/<id> or discord/ch/<id>",
		);
		expect(transport.posts()).toHaveLength(0);
	});
});

describe("I-19: a lane whose worktree was deleted by hand", () => {
	test("is refused as the child's cwd instead of falling back to the live checkout", async () => {
		const repo = makeRepo(repos);
		const d = await startDaemon();
		await d.inject({ origin: CH_ORIGIN, asOwner: true, text: `작업: ask @${repo}` });
		await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore"));
		const lane = d.store.getLane("ask");
		expect(lane?.status).toBe("working");
		expect(d.cwdFor("ompbot/work/ask")).toBe(lane?.cwd ?? "");
		rmSync(lane?.cwd ?? "", { recursive: true, force: true });
		expect(() => d.cwdFor("ompbot/work/ask")).toThrow("lane_worktree_missing");
	});
});

describe("I-22: an unreadable restart marker", () => {
	// skipIf(isRoot): root reads a 0o000 marker, so no EACCES arises
	// biome-ignore format: keeps the reason link on the skip line
	test.skipIf(isRoot)("is removed and the drop has a reason", () => { // root ignores permission bits, so this setup cannot fail
		const path = join(home.dir, RESTART_NOTICE_FILE);
		writeFileSync(path, '{"at":1,"threads":[]}\n', { mode: 0o600 });
		chmodSync(path, 0o000);
		const reasons: string[] = [];
		expect(takeRestartMarker(home.dir, (reason) => reasons.push(reason))).toBeUndefined();
		expect(existsSync(path)).toBe(false);
		expect(reasons).toEqual(["EACCES"]);
	});

	test("the daemon logs restart_notice_dropped with the reason at start", async () => {
		const path = join(home.dir, RESTART_NOTICE_FILE);
		writeFileSync(path, "{torn", { mode: 0o600 });
		await startDaemon();
		expect(logLines.some((line) => line.includes("event=restart_notice_dropped") && line.includes("unparsable"))).toBe(
			true,
		);
		expect(existsSync(path)).toBe(false);
	});
});

describe("I-12: the crash exit path", () => {
	test("writes the folded counts (log_summary) before it exits", () => {
		const clock = { now: () => 0 };
		const lines: string[] = [];
		const sink = (line: string) => lines.push(line);
		const log = createAggregatingLogger(createLogger({ sink, clock, redact }), { clock, schedule: () => () => {} });
		log.info("inbound_dropped", { reason: "bot_message" });
		const exits: number[] = [];
		const fatal = fatalHandler(createLogger({ sink, clock, redact }), log, (code) => {
			exits.push(code);
		});
		fatal("uncaughtException", new Error("boom"));
		expect(exits).toEqual([1]);
		expect(
			lines.some((line) => line.includes("event=log_summary") && line.includes("inbound_dropped_bot_message=1")),
		).toBe(true);
		expect(lines.findIndex((line) => line.includes("daemon_fatal"))).toBeGreaterThanOrEqual(0);
	});
});
