// The top-bar test chip (doc/plans/heavy-run-gate.md): read fresh from heavy-run's state files, no config needed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDashboardMain } from "../src/dashboard/html";
import { buildSnapshot, type SnapshotDeps } from "../src/dashboard/snapshot";
import { type HeavyRunState, heavyRunPaths, writeHeavyRunState } from "../src/heavy-run";

/** 2026-11-19 12:00 KST. */
const NOW = Date.parse("2026-11-19T03:00:00Z");

let home: string;
let stateDir: string;
const saved = process.env.OMPBOT_HEAVY_RUN_DIR;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-heavy-dash-"));
	stateDir = mkdtempSync(join(tmpdir(), "ompbot-heavy-state-"));
	process.env.OMPBOT_HEAVY_RUN_DIR = stateDir;
});
afterEach(() => {
	if (saved === undefined) delete process.env.OMPBOT_HEAVY_RUN_DIR;
	else process.env.OMPBOT_HEAVY_RUN_DIR = saved;
	rmSync(home, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

function deps(): SnapshotDeps {
	return {
		homeDir: home,
		repoDir: "/srv/ompbot",
		timezone: "Asia/Seoul",
		config: undefined,
		now: () => NOW,
		callDaemon: async () => {
			throw new Error("no daemon");
		},
		run: async () => ({ code: 0, stdout: "", timedOut: false }),
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => {
			throw new Error("no hosts");
		},
		collectGates: () => [],
	};
}

const state = (pid: number, label: string, kind: "waiting" | "running", agoMs: number): HeavyRunState => ({
	pid,
	cwd: `/srv/work/${label}`,
	argv: ["bun", "test"],
	label,
	state: kind,
	since: NOW - agoMs,
	...(kind === "running" ? { lockedPid: pid } : {}),
});

describe("heavy-run chip", () => {
	test("one running, two waiting and a dead pid: the chip reads `<label> … · 대기 2`, with no opsStatus configured", async () => {
		const paths = heavyRunPaths();
		writeHeavyRunState(paths, state(process.pid, "ompbot-t-run", "running", 125_000));
		writeHeavyRunState(paths, state(process.ppid, "ompbot-t-wait-a", "waiting", 60_000));
		writeHeavyRunState(paths, state(1, "ompbot-t-wait-b", "waiting", 30_000));
		writeHeavyRunState(paths, state(2 ** 22 + 99, "ompbot-t-dead", "waiting", 10_000));

		const snapshot = await buildSnapshot(deps());
		expect(snapshot.hostChecks).toBeUndefined();
		expect(snapshot.heavyRun?.ok && snapshot.heavyRun.waiting.map((w) => w.label)).toEqual([
			"ompbot-t-wait-a",
			"ompbot-t-wait-b",
		]);

		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "inbox" });
		expect(html).toContain("🧪 ompbot-t-run");
		expect(html).toMatch(/🧪 ompbot-t-run [^<]*· 대기 2</);
		expect(html).toContain("ompbot-t-wait-a");
		expect(html).not.toContain("ompbot-t-dead");
	});

	test("nothing running or waiting: no chip", async () => {
		const snapshot = await buildSnapshot(deps());
		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "inbox" });
		expect(html).not.toContain("heavy-pop");
	});
});
