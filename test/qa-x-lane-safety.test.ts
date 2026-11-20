import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDispatchTool } from "../src/dispatch/tool";
import { classifyLaneCompletion } from "../src/lanes/integrity";
import { LaneInputError } from "../src/lanes/manager";
import { RESERVATION_TTL_MS } from "../src/lanes/reservations";
import type { LaneRow } from "../src/lanes/status";
import { defaultGit, hiddenChanges } from "../src/lanes/verify";
import { scanHandoffBrief } from "../src/safety/handoff-risk";
import { createTaskHostOps } from "../src/tasks/host";
import { runSignal, type SignalIo } from "../src/tasks/signals";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// qa-x lane, dispatch and safety-guard defects (doc/plans/qa-x-lane-safety-fixes.md), one block per defect.

const GUARD = "guard_deletion_without_adversarial_regression";
const categories = (diff: string): string[] =>
	classifyLaneCompletion({ summary: "done", diff }).map((refusal) => refusal.category);
const fileDiff = (file: string, ...lines: string[]): string[] => [
	`diff --git a/${file} b/${file}`,
	`--- a/${file}`,
	`+++ b/${file}`,
	"@@ -1 +1 @@",
	...lines,
];

describe("1. handoff risk: unique prefixes of git's long options (qa-x #35)", () => {
	test.each([
		["git reset --h HEAD", "git_reset_hard"],
		["git reset --har HEAD", "git_reset_hard"],
		["git branch --del --forc x", "git_branch_force_delete"],
		["git branch --d --f x", "git_branch_force_delete"],
		["git checkout --f other", "git_discard_worktree"],
		["git switch --disc m", "git_discard_worktree"],
		["git switch --discard-change m", "git_discard_worktree"],
	])("%s is high_risk (%s)", (brief, rule) => {
		const scan = scanHandoffBrief(brief);
		expect(scan.verdict).toBe("high_risk");
		expect(scan.findings.map((finding) => finding.rule)).toContain(rule);
	});

	test("the safe forms stay clear", () => {
		for (const brief of [
			"git branch --del x",
			"git switch --detach m",
			"git checkout other",
			"git reset --soft HEAD~1",
		])
			expect(scanHandoffBrief(brief).verdict).toBe("clear");
	});
});

describe("2. dispatch: a taskSpec task may start with `-` (qa-x #36)", () => {
	const tool = buildDispatchTool({
		originKey: "discord/ch/111111111111111111/t/222222222222222222",
		ompExecutable: "omp",
		homeDir: "/home",
		workspaceDir: "/ws",
		herdr: {},
		run: async () => ({ code: 0, stdout: "{}", timedOut: false }),
		log: { info: () => undefined, warn: () => undefined },
	});
	const call = (params: Record<string, unknown>) => tool.execute(params, { signal: new AbortController().signal });

	test("a taskSpec resume is not refused for the leading `-` (it goes inside the built prompt)", async () => {
		// This session has no task ledger: the call gets past the `-` check and stops at the taskSpec one.
		await expect(call({ taskSpec: { id: "T-20261026-01" }, task: "-v 옵션도 고려해" })).rejects.toThrow(
			"이 세션에서는 taskSpec을 쓸 수 없습니다",
		);
		await expect(call({ mode: "herdr", taskSpec: { id: "T-20261026-01" }, task: "-v 옵션도 고려해" })).rejects.toThrow(
			"이 세션에서는 taskSpec을 쓸 수 없습니다",
		);
	});

	test("a herdr or host task starting with `-` is still refused", async () => {
		await expect(call({ mode: "herdr", name: "a1", task: "-v" })).rejects.toThrow("`-`로 시작할 수 없습니다");
		await expect(call({ host: "wsl", name: "a1", task: "-v" })).rejects.toThrow("`-`로 시작할 수 없습니다");
	});
});

describe("3. lane integrity: `#` is code in TS/JS (qa-x #38)", () => {
	test("deleting a private guard member `#validate` is a guard deletion", () => {
		expect(categories(fileDiff("src/p3.ts", "-\t#validate(t: string): boolean {").join("\n"))).toEqual([GUARD]);
	});

	test("a `#` comment in Python or shell is still a comment", () => {
		expect(categories(fileDiff("tools/a.py", "-    # validate input later").join("\n"))).toEqual([]);
		expect(categories(fileDiff("tools/a.sh", "-# refuse root").join("\n"))).toEqual([]);
	});
});

describe("4. lane integrity: a guard pasted into a string or comment is not a move (qa-x #72)", () => {
	const guard = '\tif (!ok) throw new Error("denied");';
	const removedFromA = fileDiff("src/a.ts", `-${guard}`);

	test("re-added inside a multi-line template literal of another file: refused", () => {
		const diff = [...removedFromA, ...fileDiff("src/b.ts", "+const doc = `", `+${guard}`, "+`;")].join("\n");
		expect(categories(diff)).toEqual([GUARD]);
	});

	test("re-added inside a template literal or block comment of the same hunk: refused", () => {
		expect(categories(fileDiff("src/a.ts", `-${guard}`, "+const doc = `", `+${guard}`, "+`;").join("\n"))).toEqual([
			GUARD,
		]);
		expect(categories(fileDiff("src/a.ts", `-${guard}`, "+/*", `+${guard}`, "+*/").join("\n"))).toEqual([GUARD]);
	});

	test("re-added as code (a move) is still accepted", () => {
		const diff = [...removedFromA, ...fileDiff("src/b.ts", "+const doc = `x`;", `+${guard}`)].join("\n");
		expect(categories(diff)).toEqual([]);
	});
});

describe("5. lane integrity: a renamed file pairs its edited guard (qa-x #73)", () => {
	test("rename plus a changed message is an edit, not a deletion", () => {
		const diff = [
			"diff --git a/src/old.ts b/src/new.ts",
			"similarity index 90%",
			"rename from src/old.ts",
			"rename to src/new.ts",
			"--- a/src/old.ts",
			"+++ b/src/new.ts",
			"@@ -3 +3 @@",
			'-\tif (!ok) throw new Error("denied");',
			'+\tif (!ok) throw new Error("not allowed");',
		].join("\n");
		expect(categories(diff)).toEqual([]);
	});

	test("rename plus a changed condition is still a deletion", () => {
		const diff = [
			"diff --git a/src/old.ts b/src/new.ts",
			"rename from src/old.ts",
			"rename to src/new.ts",
			"--- a/src/old.ts",
			"+++ b/src/new.ts",
			"@@ -3 +3 @@",
			'-\tif (!ok) throw new Error("denied");',
			'+\tif (false) throw new Error("denied");',
		].join("\n");
		expect(categories(diff)).toContain(GUARD);
	});
});

describe("6. hiddenChanges: a mode change under assume-unchanged (qa-x #74)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-qa-x-mode-"));
		git(dir, "init", "-q");
		writeFileSync(join(dir, "run.sh"), "echo hi\n");
		writeFileSync(join(dir, "data.txt"), "same\n");
		writeFileSync(join(dir, "other.txt"), "same\n");
		chmodSync(join(dir, "run.sh"), 0o644);
		git(dir, "add", "-A");
		git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("an execute bit set on a flagged file is a hidden change", async () => {
		git(dir, "update-index", "--assume-unchanged", "run.sh");
		expect(await hiddenChanges(defaultGit, dir)).toEqual([]);
		chmodSync(join(dir, "run.sh"), 0o755);
		expect(git(dir, "status", "--porcelain")).toBe("");
		expect(await hiddenChanges(defaultGit, dir)).toEqual(["run.sh"]);
	});

	test("a flagged file replaced by a symlink to the same content is a hidden change", async () => {
		git(dir, "update-index", "--assume-unchanged", "data.txt");
		unlinkSync(join(dir, "data.txt"));
		symlinkSync("other.txt", join(dir, "data.txt"));
		expect(await hiddenChanges(defaultGit, dir)).toEqual(["data.txt"]);
	});

	test("with core.fileMode off the execute bit is not a change", async () => {
		git(dir, "config", "core.fileMode", "false");
		git(dir, "update-index", "--assume-unchanged", "run.sh");
		chmodSync(join(dir, "run.sh"), 0o755);
		expect(await hiddenChanges(defaultGit, dir)).toEqual([]);
	});
});

describe("7. check output secrets are masked before the ledger (qa-x #39)", () => {
	const SECRET = `xoxb-${"1".repeat(12)}-${"A".repeat(24)}`;
	const io = (code: number, output: string): SignalIo => ({
		runCheck: async () => ({ code, output, timedOut: false }),
		readBytes: async () => undefined,
	});

	test("a failed check's tail carries no secret, even one cut by the tail", async () => {
		const failed = await runSignal('command ["bun","test"]', io(1, `token=${SECRET} fail`));
		expect(failed.ok).toBe(false);
		expect(failed.detail).not.toContain("xoxb-");
		expect(failed.detail).not.toContain("A".repeat(24));
		expect(failed.detail).toContain("[REDACTED]");
		// The tail keeps the last 80 characters: the token's prefix falls outside, its body inside.
		const cut = await runSignal('command ["bun","test"]', io(1, `${"x".repeat(100)} ${SECRET}${"B".repeat(70)}`));
		expect(cut.detail).not.toContain("A".repeat(10));
	});

	test("a stdout mismatch's tail carries no secret", async () => {
		const result = await runSignal('command ["bun","test"] stdout~"0 fail"', io(0, `leaked ${SECRET}`));
		expect(result.ok).toBe(false);
		expect(result.detail).not.toContain(SECRET);
	});
});

describe("8-11. lane reservations", () => {
	let home: TestHome;
	let repos: string[];
	let h: LaneHarness;
	let repo: string;

	beforeEach(() => {
		home = makeHome("ompbot-qa-x-lane-home-");
		repos = [];
		repo = makeRepo(repos);
		h = laneHarness(home.dir);
	});

	afterEach(() => {
		h.close();
		home.remove();
		for (const made of repos) removeRepoAndWorktrees(made);
	});

	async function lane(title: string): Promise<LaneRow> {
		const started = await h.manager.start({ title, cwd: repo, channel: CHANNEL });
		await h.settle();
		return started;
	}

	function land(name: string): void {
		h.store.transitionLane(name, "done-claimed", { event: "claimed" });
		h.store.transitionLane(name, "closed", { event: "landed" }, { land: { state: "landed", attempts: 0 } });
	}

	const reserve = (a: LaneRow, extra: Record<string, unknown> = {}, manager = h.manager) =>
		manager.reserve({
			args: { title: "next step", cwd: repo, channel: CHANNEL, ...extra },
			after: [a.name],
			originKey: "discord/dm/1",
			threadRef: a.threadRef,
		});

	async function tick(): Promise<void> {
		await h.manager.tick();
		await h.settle();
	}

	test("8. a prerequisite made before worktrees is refused as such, not as another repository's (qa-x #68)", async () => {
		const a = await lane("first");
		h.store.patchLane("first", undefined, { repo: undefined });
		const refused = reserve(a);
		await expect(refused).rejects.toThrow(LaneInputError);
		await expect(reserve(a)).rejects.toThrow("worktree 도입 전 레인");
		await expect(reserve(a)).rejects.not.toThrow("다른 저장소");
	});

	test("9. reserve refuses the arguments start would refuse, before storing (qa-x #69)", async () => {
		const a = await lane("first");
		for (const extra of [
			{ risk: "L9" },
			{ acceptance: "not a list" },
			{ scope: "src/**" },
			{ model: "nope" },
			{ tierConfidence: 2 },
			{ tierReason: 3 },
		]) {
			await expect(reserve(a, extra)).rejects.toThrow(LaneInputError);
		}
		expect(h.store.listLaneReservations(["waiting", "ready"])).toHaveLength(0);
		expect((await reserve(a, { risk: "L2", acceptance: ["a.txt가 있다"] })).state).toBe("waiting");
	});

	test("10. a `started` reservation left without its lane by a dead process goes back to ready (qa-x #70)", async () => {
		const a = await lane("first");
		land("first");
		const reservation = await reserve(a);
		await tick();
		// The process died right after ready → started: no lane row was ever written.
		expect(h.store.moveLaneReservation(reservation.id, ["ready"], "started")).toBe(true);
		await tick();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("ready");
		expect(h.manager.cancelReservation(reservation.id).handled).toBe(true);
	});

	test("10. one whose lane row was written records that lane instead", async () => {
		const a = await lane("first");
		land("first");
		const reservation = await reserve(a);
		await tick();
		expect(h.store.moveLaneReservation(reservation.id, ["ready"], "started")).toBe(true);
		// The lane the dead start opened (same conversation, title and repository, after the reservation).
		const opened = await h.manager.start({
			title: "next step",
			cwd: repo,
			channel: CHANNEL,
			parentOrigin: "discord/dm/1",
		});
		await tick();
		expect(h.store.getLaneReservation(reservation.id)).toMatchObject({ state: "started", laneName: opened.name });
	});

	test("10. a start still running in this process is not taken for an orphan", async () => {
		const a = await lane("first");
		land("first");
		const real = createTaskHostOps();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const gated = laneHarness(home.dir, {
			hostOps: {
				...real,
				createWorktree: async (input) => {
					entered.resolve();
					await release.promise;
					return real.createWorktree(input);
				},
			},
		});
		try {
			const reservation = await reserve(a, {}, gated.manager);
			await gated.manager.tick();
			const starting = gated.manager.startReservation(reservation.id);
			await entered.promise;
			await gated.manager.tick();
			expect(gated.store.getLaneReservation(reservation.id)?.state).toBe("started");
			release.resolve();
			expect((await starting).handled).toBe(true);
			await gated.settle();
			expect(gated.store.getLaneReservation(reservation.id)?.laneName).toBeString();
		} finally {
			gated.close();
		}
	});

	test("11. an expiry notice whose post failed is posted by the next tick, once (qa-x #71)", async () => {
		const a = await lane("first");
		const reservation = await reserve(a);
		const transport = h.transport;
		const realCreate = transport.createMessage.bind(transport);
		let failing = true;
		transport.createMessage = async (args) => {
			if (failing && (args.content ?? "").includes("만료됐습니다")) throw new Error("discord down");
			return realCreate(args);
		};
		const notices = () => transport.posts((text) => text.includes("만료됐습니다"));
		h.advance(RESERVATION_TTL_MS + 1);
		await tick();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("expired");
		expect(notices()).toHaveLength(0);
		failing = false;
		await tick();
		expect(notices()).toHaveLength(1);
		await tick();
		expect(notices()).toHaveLength(1);
		expect(h.store.getLaneReservation(reservation.id)).toMatchObject({ state: "expired", notice: null });
	});

	test("11. a ▶ after expiry whose notice failed leaves it owed to the tick", async () => {
		const a = await lane("first");
		land("first");
		const reservation = await reserve(a);
		await tick();
		const transport = h.transport;
		const realCreate = transport.createMessage.bind(transport);
		let failing = true;
		transport.createMessage = async (args) => {
			if (failing && (args.content ?? "").includes("만료됐습니다")) throw new Error("discord down");
			return realCreate(args);
		};
		h.advance(RESERVATION_TTL_MS);
		expect((await h.manager.startReservation(reservation.id)).handled).toBe(false);
		expect(transport.posts((text) => text.includes("만료됐습니다"))).toHaveLength(0);
		failing = false;
		await tick();
		expect(transport.posts((text) => text.includes("만료됐습니다"))).toHaveLength(1);
	});
});
