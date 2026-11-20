import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDashboardMain, renderDashboardPage, renderDetailTabs, renderItemDetail } from "../src/dashboard/html";
import { startDashboardServer } from "../src/dashboard/server";
import { buildSnapshot, type DashboardSnapshot, type JobInfo, type SnapshotDeps } from "../src/dashboard/snapshot";
import { readCardTrace, readCwdTrace, readJobTrace, readJobTraceByName, type TurnTrace } from "../src/dashboard/trace";
import { ompSessionDirFor } from "../src/omp/session-dir";
import { openStore } from "../src/store/db";

const NOW = Date.parse("2026-11-04T13:50:00Z");
const MINUTE = 60_000;
const LIVE_PID = 4242;

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-jobs-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A home with no database: only the `jobs` section is under test, every other section may fail. */
function deps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
	return {
		homeDir: home,
		repoDir: "/srv/ompbot",
		timezone: "Asia/Seoul",
		config: undefined,
		now: () => NOW,
		callDaemon: async () => {
			throw new Error("no daemon");
		},
		run: async (cmd) => ({ code: cmd[0] === "systemctl" ? 0 : 1, stdout: "", timedOut: false }),
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => {
			throw new Error("no hosts");
		},
		collectGates: () => [],
		isAlive: (pid) => pid === LIVE_PID,
		...overrides,
	};
}

const iso = (ms: number): string => new Date(ms).toISOString();

function writeJob(name: string, body: unknown): void {
	mkdirSync(join(home, "jobs"), { recursive: true });
	writeFileSync(join(home, "jobs", name), typeof body === "string" ? body : JSON.stringify(body));
}

/** The turn view's side-menu count and whether it warns. */
function turnsNav(html: string): { count: number; warn: boolean } {
	const match = /data-view="turns"[^>]*><span>턴<\/span><span class="nav-count( is-warn)?">(\d+)</.exec(html);
	if (match === null) throw new Error("no turns menu item");
	return { count: Number(match[2]), warn: match[1] !== undefined };
}

/** The page script's own renderer: what the browser redraws every 15 seconds. */
function clientRender(snapshot: DashboardSnapshot): typeof renderDashboardMain {
	const script = /<script>([\s\S]*)<\/script>/.exec(renderDashboardPage(snapshot))?.[1] ?? "";
	return new Function("document", "setInterval", `${script}\nreturn renderDashboardMain;`)(
		{ getElementById: () => ({}) },
		() => 0,
	) as typeof renderDashboardMain;
}

async function jobsOf(overrides: Partial<SnapshotDeps> = {}): Promise<JobInfo[]> {
	const snapshot = await buildSnapshot(deps(overrides));
	if (!snapshot.jobs.ok) throw new Error(`jobs section failed: ${snapshot.jobs.error}`);
	return snapshot.jobs.items;
}

describe("dashboard jobs section", () => {
	test("AC-1: a running job with a live pid reads as ok with its percent", async () => {
		writeJob("a.json", {
			title: "oh-my-pi 코드 지도",
			state: "running",
			done: 290,
			total: 10254,
			unit: "조각",
			startedAt: iso(NOW - 70 * MINUTE),
			updatedAt: iso(NOW - MINUTE),
			pid: LIVE_PID,
		});
		const [job] = await jobsOf();
		expect(job?.name).toBe("a");
		expect(job?.health).toBe("ok");
		expect(job?.done).toBe(290);
		expect(job?.total).toBe(10254);
		expect(job?.percent).toBeCloseTo(2.8, 1);
	});

	test("AC-2: health reads stale, dead, failed and invalid; a broken file leaves the others intact", async () => {
		const fresh = iso(NOW - MINUTE);
		writeJob("fresh.json", { state: "running", updatedAt: fresh, pid: LIVE_PID, done: 1, total: 2 });
		writeJob("stale.json", { state: "running", updatedAt: iso(NOW - 11 * MINUTE), pid: LIVE_PID });
		writeJob("dead.json", { state: "running", updatedAt: fresh, pid: 9999 });
		writeJob("failed.json", { state: "failed", updatedAt: fresh, detail: "exit 1" });
		writeJob("broken.json", '{"state": "running", ');
		writeJob("no-updated.json", { state: "running", done: 3, total: 4 });
		const snapshot = await buildSnapshot(deps());
		expect(snapshot.jobs.ok).toBe(true);
		const jobs = await jobsOf();
		const health = Object.fromEntries(jobs.map((job) => [job.name, job.health]));
		expect(health).toEqual({
			fresh: "ok",
			stale: "stale",
			dead: "dead",
			failed: "failed",
			broken: "invalid",
			"no-updated": "invalid",
		});
		const byName = new Map(jobs.map((job) => [job.name, job]));
		expect(byName.get("fresh")).toMatchObject({ state: "running", done: 1, total: 2, percent: 50 });
		expect(byName.get("broken")).toMatchObject({ title: "broken.json", state: null });
		expect(byName.get("broken")?.detail).toContain("읽기 실패");
		expect(byName.get("no-updated")?.detail).toContain("updatedAt");
		// A running job past the stale limit with no pid is stale, not dead; a done job with a gone pid is still ok.
		writeJob("stale.json", { state: "running", updatedAt: iso(NOW - 11 * MINUTE) });
		writeJob("dead.json", { state: "done", updatedAt: fresh, pid: 9999 });
		const again = new Map((await jobsOf()).map((job) => [job.name, job.health]));
		expect(again.get("stale")).toBe("stale");
		expect(again.get("dead")).toBe("ok");
	});

	test("counts outside 0 ≤ done ≤ total show no numbers; total 0 shows counts without a percent", async () => {
		const fresh = iso(NOW - MINUTE);
		writeJob("over.json", { state: "running", updatedAt: fresh, done: 5, total: 4 });
		writeJob("negative.json", { state: "running", updatedAt: fresh, done: -1, total: 4 });
		writeJob("fraction.json", { state: "running", updatedAt: fresh, done: 1.5, total: 4 });
		writeJob("empty.json", { state: "running", updatedAt: fresh, done: 0, total: 0 });
		const byName = new Map((await jobsOf()).map((job) => [job.name, job]));
		for (const name of ["over", "negative", "fraction"]) {
			expect(byName.get(name)?.done).toBeUndefined();
			expect(byName.get(name)?.total).toBeUndefined();
			expect(byName.get(name)?.percent).toBeUndefined();
		}
		expect(byName.get("empty")).toMatchObject({ done: 0, total: 0 });
		expect(byName.get("empty")?.percent).toBeUndefined();
	});

	test("a jobs path that cannot be listed fails only the jobs section", async () => {
		writeFileSync(join(home, "jobs"), "not a directory");
		const snapshot = await buildSnapshot(deps());
		expect(snapshot.jobs.ok).toBe(false);
		expect(snapshot.backup.ok).toBe(true);
	});

	test("AC-4: old done jobs drop out, misnamed files are not read, title and detail are masked and cut", async () => {
		writeJob("old-done.json", { state: "done", updatedAt: iso(NOW - 25 * 60 * MINUTE) });
		writeJob("recent-done.json", { state: "done", updatedAt: iso(NOW - 23 * 60 * MINUTE) });
		// A failed job stays a week, past the day finished work gets.
		writeJob("old-failed.json", { state: "failed", updatedAt: iso(NOW - 25 * 60 * MINUTE) });
		writeJob("week-failed.json", { state: "failed", updatedAt: iso(NOW - (7 * 24 * 60 + 1) * MINUTE) });
		// A running job whose pid is gone leaves like finished work once old; a recent one stays to be seen.
		writeJob("old-dead.json", { state: "running", updatedAt: iso(NOW - 25 * 60 * MINUTE), pid: 9999 });
		writeJob("recent-dead.json", { state: "running", updatedAt: iso(NOW - 22 * 60 * MINUTE), pid: 9999 });
		const valid = { state: "running", updatedAt: iso(NOW - MINUTE) };
		writeFileSync(join(home, "x.json"), JSON.stringify(valid)); // `jobs/../x.json`
		writeJob("A B.json", valid);
		writeJob("Upper.json", valid);
		writeJob(".hidden.json", valid);
		writeJob("note.txt", valid);
		writeJob("half.json.tmp", valid);
		mkdirSync(join(home, "jobs", "dir.json"));
		writeJob("masked.json", {
			...valid,
			title: `제목 xoxb-TEST-0 ${"가".repeat(200)}`,
			detail: `tokens=3298706 key=xoxb-TEST-0 ${"x".repeat(300)}`,
		});
		const jobs = await jobsOf();
		expect(jobs.map((job) => job.name)).toEqual(["masked", "recent-dead", "recent-done", "old-failed"]);
		const masked = jobs[0] as JobInfo;
		expect(masked.title).not.toContain("xoxb-TEST-0");
		expect(masked.title).toContain("[REDACTED]");
		expect(Array.from(masked.title)).toHaveLength(120);
		expect(masked.detail).not.toContain("xoxb-TEST-0");
		expect(masked.detail).toStartWith("tokens=3298706 key=[REDACTED]");
		expect(Array.from(masked.detail ?? "")).toHaveLength(200);
	});

	test("at most 50 jobs, newest update first", async () => {
		for (let i = 0; i < 55; i += 1) {
			writeJob(`job-${i}.json`, { state: "running", updatedAt: iso(NOW - i * 1000) });
		}
		const jobs = await jobsOf();
		expect(jobs).toHaveLength(50);
		expect(jobs[0]?.name).toBe("job-0");
		expect(jobs[49]?.name).toBe("job-49");
	});

	describe("turn view", () => {
		/** A bot database with no open turn: the turns section reads ok and empty. */
		beforeEach(() => {
			openStore({
				timezone: "Asia/Seoul",
				path: join(home, "ompbot.db"),
				clock: { now: () => NOW },
				redact: (text) => text,
			}).close();
		});

		test("AC-3: no jobs directory draws today's turn view; a running job alone gets the jobs block, counted in the head only", async () => {
			const empty = await buildSnapshot(deps());
			expect(empty.jobs).toEqual({ ok: true, items: [] });
			expect(empty.turns).toEqual({ ok: true, items: [], threads: [] });
			const before = renderDashboardMain(empty, undefined, NOW, { view: "turns" });
			expect(before).not.toContain("백그라운드 작업");
			expect(before).toContain("최근 24시간 턴이 없어요");
			expect(turnsNav(before)).toEqual({ count: 0, warn: false });

			writeJob("a.json", {
				title: "oh-my-pi 코드 지도",
				state: "running",
				done: 290,
				total: 10254,
				unit: "조각",
				startedAt: iso(NOW - 70 * MINUTE),
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				thread: "C0123456789:1793795646.437279",
				detail: "tokens=3298706 retries=41 fail=0",
				log: "/tmp/hyeon-runs/oh-my-pi.log",
			});
			const snapshot = await buildSnapshot(deps());
			const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
			expect(html).toContain("백그라운드 작업");
			expect(html).toContain("290/10254 조각 (2.8%)");
			expect(html).toContain('<span class="meter" role="img" aria-label="진행 2.8%">');
			expect(html).toContain("스레드 C0123456789:1793795646.437279");
			expect(html).toContain('data-row="job:a"');
			expect(html).toContain(">진행 중<");
			expect(html).not.toContain("최근 24시간 턴이 없어요");
			// The menu counts threads like the 진행 중 column; the running job is named in the head instead.
			expect(turnsNav(html)).toEqual({ count: 0, warn: false });
			expect(html).toContain('진행 중 스레드 <b>0</b> · <a href="#jobs">백그라운드 작업 <b>1</b></a>');
			// The page's own redraw draws the same, and the system view stays as it was.
			expect(clientRender(snapshot)(snapshot, undefined, NOW, { view: "turns" })).toBe(html);
			expect(renderDashboardMain(snapshot, undefined, NOW, { view: "system" })).not.toContain("백그라운드 작업");

			const detail = renderItemDetail(snapshot, "turns", "job:a");
			expect(detail).toContain("oh-my-pi 코드 지도");
			expect(detail).toContain(`<code>${LIVE_PID}</code>`);
			expect(detail).toContain("<code>/tmp/hyeon-runs/oh-my-pi.log</code>");
			expect(detail).toContain("tokens=3298706 retries=41 fail=0");
			expect(renderItemDetail(snapshot, "turns", "job:gone")).toContain("지금 목록에 없는 항목");
		});

		test("a done job folds under the board uncounted; a stale job sits on top and lights the menu warning", async () => {
			writeJob("finished.json", { state: "done", updatedAt: iso(NOW - MINUTE), done: 4, total: 4 });
			const done = renderDashboardMain(await buildSnapshot(deps()), undefined, NOW, { view: "turns" });
			expect(done).toContain(">완료<");
			expect(done).toContain('<details class="closed" id="closed"><summary>끝난 백그라운드 작업');
			expect(done).not.toContain('id="jobs"');
			expect(done.indexOf("최근 24시간 턴이 없어요")).toBeLessThan(done.indexOf("끝난 백그라운드 작업"));
			expect(done).not.toContain("백그라운드 작업 <b>");
			expect(turnsNav(done)).toEqual({ count: 0, warn: false });

			writeJob("late.json", { state: "running", updatedAt: iso(NOW - 11 * MINUTE) });
			const stale = renderDashboardMain(await buildSnapshot(deps()), undefined, NOW, { view: "turns" });
			expect(stale).toContain(">갱신 끊김<");
			expect(stale.indexOf('id="jobs"')).toBeGreaterThan(-1);
			expect(stale.indexOf('id="jobs"')).toBeLessThan(stale.indexOf("끝난 백그라운드 작업"));
			expect(turnsNav(stale)).toEqual({ count: 0, warn: true });
		});

		test("a stopped job reads ok, folds with the finished ones, warns nothing and leaves after 24 hours", async () => {
			writeJob("halted.json", {
				state: "stopped",
				updatedAt: iso(NOW - MINUTE),
				pid: 9999,
				done: 2800,
				total: 17803,
				detail: "중단: 오너 지시",
			});
			writeJob("old-halted.json", { state: "stopped", updatedAt: iso(NOW - 25 * 60 * MINUTE) });
			const snapshot = await buildSnapshot(deps());
			const jobs = await jobsOf();
			expect(jobs.map((job) => [job.name, job.state, job.health])).toEqual([["halted", "stopped", "ok"]]);
			const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
			expect(html).toContain(">중단<");
			expect(html).not.toContain(">파일 오류<");
			expect(html).not.toContain('id="jobs"');
			expect(html).toContain("끝난 백그라운드 작업");
			expect(turnsNav(html)).toEqual({ count: 0, warn: false });
			expect(clientRender(snapshot)(snapshot, undefined, NOW, { view: "turns" })).toBe(html);
			expect(renderItemDetail(snapshot, "turns", "job:halted")).toContain("중단 · stopped");
		});

		test("a jobs section that failed shows under its heading and leaves the turn list as it was", async () => {
			writeFileSync(join(home, "jobs"), "not a directory");
			const snapshot = await buildSnapshot(deps());
			const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
			expect(html).toContain("최근 24시간 턴이 없어요");
			expect(html).toMatch(/백그라운드 작업<\/h2><\/div><div class="notice is-danger">.*읽기 실패/);
			expect(turnsNav(html).warn).toBe(true);
		});
	});
});

describe("dashboard jobs from systemd-run units", () => {
	const unit = (fields: Record<string, string>): string =>
		Object.entries(fields)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n");
	const transient = (id: string, pid: number, extra: Record<string, string> = {}): string =>
		unit({
			MainPID: String(pid),
			Id: id,
			Description: `/srv/${id}.sh`,
			ActiveState: "active",
			ActiveEnterTimestamp: "@1793800000",
			Transient: "yes",
			...extra,
		});
	const listing =
		(stdout: string, code: number | null = 0) =>
		async (cmd: string[]) =>
			cmd[0] === "systemctl" ? { code, stdout, timedOut: false } : { code: 1, stdout: "", timedOut: false };

	test("a running transient ompbot-* unit is a running job; services, helpers, inactive and file-backed units are not", async () => {
		writeJob("audit.json", { state: "running", updatedAt: iso(NOW - MINUTE), pid: LIVE_PID });
		const stdout = [
			transient("ompbot-fable-diet7.service", 501),
			unit({ MainPID: "502", Id: "ompbot.service", ActiveState: "active", Transient: "no" }),
			transient("ompbot-job-fable-diet7.service", 503),
			transient("ompbot-old.service", 0, { ActiveState: "inactive" }),
			transient("ompbot-audit.service", 504),
			transient("ompbot-same-pid.service", LIVE_PID),
		].join("\n\n");
		const jobs = await jobsOf({ run: listing(stdout) });
		expect(jobs.map((job) => [job.name, job.state, job.health])).toEqual([
			["fable-diet7", "running", "ok"],
			["audit", "running", "ok"],
		]);
		expect(jobs[0]).toMatchObject({
			title: "/srv/ompbot-fable-diet7.service.sh",
			pid: 501,
			startedAt: "2026-11-04T22:46:40+09:00",
			detail: "systemd 유닛 ompbot-fable-diet7.service",
		});
	});

	test("kencrew-* units are jobs too, and a name both prefixes share shows once", async () => {
		let asked: string[] = [];
		const stdout = [
			transient("ompbot-intake.service", 601),
			transient("kencrew-intake.service", 602),
			transient("kencrew-fable-intake.service", 603),
		].join("\n\n");
		const run = async (cmd: string[]) => {
			if (cmd[0] === "systemctl") asked = cmd;
			return listing(stdout)(cmd);
		};
		const jobs = await jobsOf({ run });
		expect(asked).toEqual(expect.arrayContaining(["ompbot-*.service", "kencrew-*.service"]));
		expect(jobs.map((job) => [job.name, job.pid])).toEqual([
			["intake", 601],
			["fable-intake", 603],
		]);
	});

	test("no systemctl on the host means no unit jobs; a failing systemctl is one invalid row beside the files", async () => {
		writeJob("audit.json", { state: "running", updatedAt: iso(NOW - MINUTE), pid: LIVE_PID });
		expect((await jobsOf({ run: listing("spawn failed: ENOENT", null) })).map((job) => job.name)).toEqual(["audit"]);
		const jobs = await jobsOf({ run: listing("Failed to connect to bus", 1) });
		expect(jobs.map((job) => [job.name, job.health])).toEqual([
			["systemd", "invalid"],
			["audit", "ok"],
		]);
		expect(jobs[0]?.detail).toContain("Failed to connect to bus");
	});
});

interface ThreadSeed {
	origin: string;
	threadRef: string;
	state: string;
	text: string;
	createdAt: number;
	dispatchedAt?: number | null;
	lastEventAt?: number | null;
}

function seedThreads(rows: ThreadSeed[]): void {
	const dbPath = join(home, "ompbot.db");
	openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const db = new Database(dbPath, { strict: true });
	for (const origin of new Set(rows.map((row) => row.origin))) {
		db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
			origin,
			join(home, "sessions", encodeURIComponent(origin)),
			NOW,
		]);
	}
	for (const [index, row] of rows.entries()) {
		db.run(
			`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at, thread_ref)
			 VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
			[
				`msg-${index}`,
				row.origin,
				row.text,
				row.state,
				row.createdAt,
				row.dispatchedAt ?? null,
				row.lastEventAt ?? null,
				row.threadRef,
			],
		);
	}
	db.close();
}

function hasNestedAnchors(html: string): boolean {
	let depth = 0;
	for (const tag of html.matchAll(/<\/?a(?:\s|>)/gi)) {
		if (tag[0].startsWith("</")) depth = Math.max(0, depth - 1);
		else {
			if (depth > 0) return true;
			depth += 1;
		}
	}
	return false;
}

describe("dashboard jobs in thread board (AC-1, AC-2)", () => {
	const HOUR = 60 * MINUTE;

	test("AC-1: running ok/stale job moves done thread (even >24h old) to working with jobs[], keeps attention priority, and reverts on done/dead/failed", async () => {
		seedThreads([
			{
				origin: "discord/ch/300000000000000001/t/100000000000000001",
				threadRef: "300000000000000001:100000000000000001",
				state: "answered",
				text: "최근 끝난 스레드",
				createdAt: NOW - 2 * HOUR,
				dispatchedAt: NOW - 2 * HOUR,
				lastEventAt: NOW - HOUR,
			},
			{
				origin: "discord/ch/300000000000000002/t/100000000000000002",
				threadRef: "300000000000000002:100000000000000002",
				state: "answered",
				text: "오래된 스레드",
				createdAt: NOW - 30 * HOUR,
				dispatchedAt: NOW - 30 * HOUR,
				lastEventAt: NOW - 29 * HOUR,
			},
			{
				origin: "discord/ch/300000000000000003/t/100000000000000003",
				threadRef: "300000000000000003:100000000000000003",
				state: "failed_notified",
				text: "실패 스레드",
				createdAt: NOW - 2 * HOUR,
				dispatchedAt: NOW - 2 * HOUR,
			},
			{
				origin: "discord/ch/300000000000000004/t/100000000000000004",
				threadRef: "300000000000000004:100000000000000004",
				state: "dispatched",
				text: "정체 스레드",
				createdAt: NOW - 25 * MINUTE,
				dispatchedAt: NOW - 20 * MINUTE,
			},
			{
				origin: "discord/ch/300000000000000005/t/100000000000000005",
				threadRef: "300000000000000005:100000000000000005",
				state: "answered",
				text: "죽은 작업 스레드",
				createdAt: NOW - HOUR,
				dispatchedAt: NOW - HOUR,
			},
		]);
		writeJob("ok-job.json", {
			state: "running",
			updatedAt: iso(NOW - MINUTE),
			pid: LIVE_PID,
			thread: "300000000000000001:100000000000000001",
		});
		writeJob("old-thread-job.json", {
			state: "running",
			updatedAt: iso(NOW - 11 * MINUTE), // stale, still running
			pid: LIVE_PID,
			thread: "300000000000000002:100000000000000002",
		});
		writeJob("failed-turn-job.json", {
			state: "running",
			updatedAt: iso(NOW - MINUTE),
			pid: LIVE_PID,
			thread: "300000000000000003:100000000000000003",
		});
		writeJob("stalled-turn-job.json", {
			state: "running",
			updatedAt: iso(NOW - MINUTE),
			pid: LIVE_PID,
			thread: "300000000000000004:100000000000000004",
		});
		writeJob("dead-job.json", {
			state: "running",
			updatedAt: iso(NOW - MINUTE),
			pid: 9999,
			thread: "300000000000000005:100000000000000005",
		});

		const snap1 = await buildSnapshot(deps());
		expect(snap1.turns.ok).toBe(true);
		const byCode = new Map(
			(snap1.turns.ok ? snap1.turns.threads : []).map((t) => [`C${t.originKey.split("/")[2]?.slice(-1)}`, t]),
		);
		expect(byCode.get("C1")?.column).toBe("working");
		expect(byCode.get("C1")?.jobs).toEqual(["ok-job"]);
		// >24h thread included and placed in working by its running stale job
		expect(byCode.get("C2")?.column).toBe("working");
		expect(byCode.get("C2")?.jobs).toEqual(["old-thread-job"]);
		// attention priority wins over running job
		expect(byCode.get("C3")?.column).toBe("attention");
		expect(byCode.get("C3")?.jobs).toEqual(["failed-turn-job"]);
		expect(byCode.get("C4")?.column).toBe("attention");
		// dead job does not promote to working
		expect(byCode.get("C5")?.column).toBe("done");
		expect(byCode.get("C5")?.jobs).toBeUndefined();

		// When ok-job becomes done (or failed), thread returns to done
		writeJob("ok-job.json", {
			state: "done",
			updatedAt: iso(NOW),
			pid: LIVE_PID,
			thread: "300000000000000001:100000000000000001",
		});
		writeJob("old-thread-job.json", {
			state: "failed",
			updatedAt: iso(NOW),
			thread: "300000000000000002:100000000000000002",
		});
		const snap2 = await buildSnapshot(deps());
		const byCode2 = new Map(
			(snap2.turns.ok ? snap2.turns.threads : []).map((t) => [`C${t.originKey.split("/")[2]?.slice(-1)}`, t]),
		);
		expect(byCode2.get("C1")?.column).toBe("done");
		expect(byCode2.get("C1")?.jobs).toBeUndefined();
		expect(byCode2.get("C2")).toBeUndefined(); // >24h old and no active job -> drops out again

		// If jobs section fails, turns section still builds as usual
		rmSync(join(home, "jobs"), { recursive: true, force: true });
		writeFileSync(join(home, "jobs"), "not-a-dir");
		const snap3 = await buildSnapshot(deps());
		expect(snap3.jobs.ok).toBe(false);
		expect(snap3.turns.ok).toBe(true);
		if (snap3.turns.ok) {
			const c1 = snap3.turns.threads.find((t) => t.originKey === "discord/ch/300000000000000001/t/100000000000000001");
			expect(c1?.column).toBe("done");
			expect(c1?.jobs).toBeUndefined();
		}
	});

	test("AC-2: thread card renders 백그라운드 작업 N badge linking to newest job without nested <a>, and counts thread in head", async () => {
		seedThreads([
			{
				origin: "discord/ch/300000000000000001/t/100000000000000001",
				threadRef: "300000000000000001:100000000000000001",
				state: "answered",
				text: "단일 작업 스레드",
				createdAt: NOW - 2 * HOUR,
				dispatchedAt: NOW - 2 * HOUR,
			},
			{
				origin: "discord/ch/300000000000000002/t/100000000000000002",
				threadRef: "300000000000000002:100000000000000002",
				state: "answered",
				text: "다중 작업 스레드",
				createdAt: NOW - 2 * HOUR,
				dispatchedAt: NOW - 2 * HOUR,
			},
		]);
		writeJob("solo.json", {
			state: "running",
			updatedAt: iso(NOW - 2 * MINUTE),
			pid: LIVE_PID,
			thread: "300000000000000001:100000000000000001",
		});
		writeJob("older-job.json", {
			state: "running",
			updatedAt: iso(NOW - 5 * MINUTE),
			pid: LIVE_PID,
			thread: "300000000000000002:100000000000000002",
		});
		writeJob("newer-job.json", {
			state: "running",
			updatedAt: iso(NOW - MINUTE),
			pid: LIVE_PID,
			thread: "300000000000000002:100000000000000002",
		});

		const snapshot = await buildSnapshot(deps());
		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		expect(html).toContain("진행 중 스레드 <b>2</b>");
		expect(hasNestedAnchors(html)).toBe(false);

		const card1 =
			/<article class="card[^"]*"[^>]*data-row="discord\/ch\/300000000000000001\/t\/100000000000000001"[\s\S]*?<\/article>/.exec(
				html,
			)?.[0] ?? "";
		expect(card1).toContain('data-item="job:solo"');
		expect(card1).toContain('href="?view=turns&amp;item=job%3Asolo"');
		expect(card1).toContain(">백그라운드 작업 1<");

		const card2 =
			/<article class="card[^"]*"[^>]*data-row="discord\/ch\/300000000000000002\/t\/100000000000000002"[\s\S]*?<\/article>/.exec(
				html,
			)?.[0] ?? "";
		expect(card2).toContain('data-item="job:newer-job"');
		expect(card2).toContain('href="?view=turns&amp;item=job%3Anewer-job"');
		expect(card2).toContain('title="newer-job, older-job"');
		expect(card2).toContain(">백그라운드 작업 2<");

		// List layout also has the badge link without nested anchors
		const listHtml = renderDashboardMain(snapshot, undefined, NOW, { view: "turns", layout: "list" });
		expect(hasNestedAnchors(listHtml)).toBe(false);
		expect(listHtml).toContain('data-item="job:newer-job"');
		expect(listHtml).toContain(">백그라운드 작업 2<");

		// Client renderer matches SSR
		expect(clientRender(snapshot)(snapshot, undefined, NOW, { view: "turns" })).toBe(html);
	});
});

describe("job progress tail & security checks (AC-3)", () => {
	test("AC-3: reads masked last 40 lines from tail 64KiB inside allowed roots; blocks outside, secrets, symlinks, non-regular", async () => {
		const userRoot = mkdtempSync(join(tmpdir(), "ompbot-user-home-"));
		const outside = mkdtempSync(join(tmpdir(), "ompbot-outside-"));
		try {
			const workDir = join(userRoot, "work", "proj");
			const altHome = join(userRoot, ".ompbot-alt");
			const secretsInHome = join(home, "secrets");
			const secretsInAlt = join(altHome, "secrets");
			mkdirSync(workDir, { recursive: true });
			mkdirSync(secretsInAlt, { recursive: true });
			mkdirSync(secretsInHome, { recursive: true });

			// 50 lines in allowed workDir with a token to mask
			const allowedProgress = join(workDir, "progress.log");
			const fifty = Array.from({ length: 50 }, (_, i) =>
				i === 45 ? `line-${i + 1} token=xoxb-TEST-0` : `line-${i + 1}`,
			).join("\n");
			writeFileSync(allowedProgress, `${fifty}\n`);

			// >64KiB file where head has marker that must NOT be read
			const largeProgress = join(home, "large.log");
			const headMarker = "HEAD_PAST_64K_MUST_NOT_READ_xoxb-HEAD-SECRET";
			const headPad = `${headMarker}\n${"a".repeat(40 * 1024)}\n`;
			const tailLines = Array.from({ length: 80 }, (_, i) => `tail-${i + 1} ${"b".repeat(900)}`).join("\n");
			writeFileSync(largeProgress, `${headPad}${tailLines}\n`);

			const outsideFile = join(outside, "progress.log");
			writeFileSync(outsideFile, "outside-secret-line\n");

			const secretFile = join(secretsInHome, "token.log");
			writeFileSync(secretFile, "secret-dir-line\n");
			const altSecretFile = join(secretsInAlt, "token.log");
			writeFileSync(altSecretFile, "alt-secret-line\n");

			const symToSecret = join(workDir, "sym-secret.log");
			symlinkSync(secretFile, symToSecret);
			const symToOutside = join(workDir, "sym-outside.log");
			symlinkSync(outsideFile, symToOutside);
			const dirAsProgress = join(workDir, "subdir");
			mkdirSync(dirAsProgress);

			writeJob("ok-progress.json", {
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				progress: allowedProgress,
			});
			writeJob("large-progress.json", {
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				progress: largeProgress,
			});
			writeJob("outside.json", {
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				progress: outsideFile,
			});
			writeJob("in-secrets.json", {
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				progress: secretFile,
			});
			writeJob("in-alt-secrets.json", {
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				progress: altSecretFile,
			});
			writeJob("sym-secret.json", {
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				progress: symToSecret,
			});
			writeJob("sym-outside.json", {
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				progress: symToOutside,
			});
			writeJob("dir-progress.json", {
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				progress: dirAsProgress,
			});

			const snapshot = await buildSnapshot(deps({ userHome: userRoot }));
			const byName = new Map((snapshot.jobs.ok ? snapshot.jobs.items : []).map((j) => [j.name, j]));

			const okJob = byName.get("ok-progress");
			expect(okJob?.progressLines).toHaveLength(40);
			expect(okJob?.progressLines?.[0]).toBe("line-11");
			expect(okJob?.progressLines?.[35]).toBe("line-46 token=[REDACTED]");
			expect(okJob?.progressLines?.[39]).toBe("line-50");

			const detailOk = renderItemDetail(snapshot, "turns", "job:ok-progress");
			expect(detailOk).toContain("진행 기록 (최근 40줄)");
			expect(detailOk).toContain("line-46 token=[REDACTED]");
			expect(detailOk).not.toContain("xoxb-TEST-0");
			expect(detailOk).not.toContain("line-10\n");

			const largeJob = byName.get("large-progress");
			expect(largeJob?.progressLines).toHaveLength(40);
			expect(largeJob?.progressLines?.join("\n")).not.toContain(headMarker);
			expect(largeJob?.progressLines?.[39]).toStartWith("tail-80 ");

			for (const blocked of ["outside", "in-secrets", "in-alt-secrets", "sym-secret", "sym-outside", "dir-progress"]) {
				expect(byName.get(blocked)?.progressLines).toBeUndefined();
				expect(byName.get(blocked)?.progress).toBeDefined();
				const detail = renderItemDetail(snapshot, "turns", `job:${blocked}`);
				expect(detail).not.toContain("진행 기록");
				expect(detail).not.toContain("outside-secret-line");
				expect(detail).not.toContain("secret-dir-line");
				expect(detail).not.toContain("alt-secret-line");
			}
		} finally {
			rmSync(userRoot, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("job trace API and detail tabs (AC-4)", () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	test("AC-4: api/job/trace returns 200 ok, 400 invalid name, 404 unknown_job/no_session/trace_disabled, live:false for dead/done, shares readCwdTrace", async () => {
		const userRoot = mkdtempSync(join(tmpdir(), "ompbot-job-trace-user-"));
		const outside = mkdtempSync(join(tmpdir(), "ompbot-job-trace-out-"));
		try {
			const sessionsRoot = join(userRoot, "sessions");
			const workDir = join(userRoot, "work", "fable");
			mkdirSync(workDir, { recursive: true });
			const sessDir = ompSessionDirFor(workDir, userRoot, sessionsRoot);
			mkdirSync(sessDir, { recursive: true });
			const sessFile = join(sessDir, "s.jsonl");
			const base0 = Date.parse("2026-11-18T02:00:00Z");
			const at = (ms: number) => new Date(base0 + ms).toISOString();
			appendFileSync(
				sessFile,
				`${JSON.stringify({ type: "message", id: "u1", timestamp: at(0), message: { role: "user", content: [] } })}\n`,
			);
			appendFileSync(
				sessFile,
				`${JSON.stringify({
					type: "message",
					id: "a1",
					timestamp: at(800),
					message: {
						role: "assistant",
						model: "opus",
						timestamp: base0 + 100,
						completedAt: base0 + 800,
						stopReason: "stop",
						content: [],
					},
				})}\n`,
			);

			// Shared readCwdTrace matches readCardTrace and readJobTrace
			const direct = readCwdTrace(workDir, true, { userHome: userRoot, sessionsRoot, now: base0 + 5_000 });
			expect(direct.ok).toBe(true);
			expect(
				readCardTrace(
					{ local: true, agent: "omp", cwd: workDir, status: "working" },
					{ userHome: userRoot, sessionsRoot, now: base0 + 5_000 },
				),
			).toEqual(direct);
			expect(
				readJobTrace(
					{ state: "running", health: "ok", cwd: workDir },
					{ userHome: userRoot, sessionsRoot, now: base0 + 5_000, homeDir: home },
				),
			).toEqual(direct);

			// Outside cwd & secrets cwd blocked when homeDir is checked
			mkdirSync(outside, { recursive: true });
			expect(
				readJobTrace(
					{ state: "running", health: "ok", cwd: outside },
					{ userHome: userRoot, sessionsRoot, now: base0 + 5_000, homeDir: home },
				),
			).toEqual({ ok: false, error: "no_session" });
			expect(
				readJobTrace(
					{ state: "running", health: "ok", cwd: join(home, "secrets", "x") },
					{ userHome: userRoot, sessionsRoot, now: base0 + 5_000, homeDir: home },
				),
			).toEqual({ ok: false, error: "no_session" });

			writeJob("live-job.json", {
				title: "실행 중 작업",
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				cwd: workDir,
			});
			writeJob("dead-job.json", {
				title: "죽은 작업",
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: 9999,
				cwd: workDir,
			});
			writeJob("done-job.json", {
				title: "끝난 작업",
				state: "done",
				updatedAt: iso(NOW - MINUTE),
				pid: 9999,
				cwd: workDir,
			});
			writeJob("no-cwd.json", {
				title: "cwd 없음",
				state: "running",
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
			});

			const snapshot = await buildSnapshot(deps({ userHome: userRoot }));
			const server = startDashboardServer({
				port: 0,
				hostname: "127.0.0.1",
				snapshot: async () => snapshot,
				jobTrace: (name) =>
					readJobTraceByName(home, name, {
						userHome: userRoot,
						sessionsRoot,
						now: base0 + 5_000,
						isAlive: (pid) => pid === LIVE_PID,
						timezone: "Asia/Seoul",
					}),
			});
			stop = () => server.stop(true);
			const base = `http://127.0.0.1:${server.port}`;

			const okRes = await fetch(`${base}/api/job/trace?name=live-job`);
			expect(okRes.status).toBe(200);
			const okBody = (await okRes.json()) as Extract<TurnTrace, { ok: true }>;
			expect(okBody).toMatchObject({ ok: true, live: true, startedAt: base0 });

			const deadRes = await fetch(`${base}/api/job/trace?name=dead-job`);
			expect(deadRes.status).toBe(200);
			expect((await deadRes.json()) as Extract<TurnTrace, { ok: true }>).toMatchObject({ ok: true, live: false });

			const doneRes = await fetch(`${base}/api/job/trace?name=done-job`);
			expect(doneRes.status).toBe(200);
			expect((await doneRes.json()) as Extract<TurnTrace, { ok: true }>).toMatchObject({ ok: true, live: false });

			for (const badName of ["", "Upper", "../etc", "bad name"]) {
				const badRes = await fetch(`${base}/api/job/trace?name=${encodeURIComponent(badName)}`);
				expect(badRes.status).toBe(400);
			}

			const missingRes = await fetch(`${base}/api/job/trace?name=missing-job`);
			expect([missingRes.status, await missingRes.json()]).toEqual([404, { ok: false, error: "unknown_job" }]);

			const noCwdRes = await fetch(`${base}/api/job/trace?name=no-cwd`);
			expect([noCwdRes.status, await noCwdRes.json()]).toEqual([404, { ok: false, error: "no_session" }]);

			// SSR job detail page renders job tabs (개요, 트레이스) with 개요 selected
			expect(renderDetailTabs("job", "head")).toContain('data-tab="trace"');
			expect(renderDetailTabs("job", "head")).not.toContain('data-tab="conv"');
			const page = await (await fetch(`${base}/?view=turns&item=job%3Alive-job`)).text();
			const tabStrip = /<div id="detail-tabs"([^>]*)>([\s\S]*?)<\/div>/.exec(page);
			expect(tabStrip?.[1]).not.toContain("hidden");
			expect(tabStrip?.[2]).toContain('id="tab-head"');
			expect(tabStrip?.[2]).toContain('id="tab-trace"');
			expect(tabStrip?.[2]).not.toContain('id="tab-conv"');
			expect(page).toContain("api/job/trace?name=");
			expect(page).toContain("trace.reload()");

			// Without jobTrace option -> 404 trace_disabled
			stop();
			const offServer = startDashboardServer({
				port: 0,
				hostname: "127.0.0.1",
				snapshot: async () => snapshot,
			});
			stop = () => offServer.stop(true);
			const offRes = await fetch(`http://127.0.0.1:${offServer.port}/api/job/trace?name=live-job`);
			expect([offRes.status, await offRes.json()]).toEqual([404, { error: "trace_disabled" }]);
		} finally {
			rmSync(userRoot, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
