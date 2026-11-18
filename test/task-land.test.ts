import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { dispatchEnv } from "../src/dispatch/omp";
import { createLaneLander, type LandLane, type LandRequest } from "../src/lanes/land";
import { defaultGit } from "../src/lanes/verify";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems, docsDirOf } from "../src/tasks/docs";
import type { TaskEvaluation } from "../src/tasks/evaluate";
import { createTaskHostOps } from "../src/tasks/host";
import { landTask, type TaskLandDeps, taskLandHold } from "../src/tasks/land";
import type { TaskRow } from "../src/tasks/ledger";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

const CHANNEL = "C1";
const THREAD = "1700.000100";
const clock = { now: () => Date.now() };

const git = (dir: string, ...args: string[]): string =>
	execFileSync("git", ["-C", dir, ...args], { env: dispatchEnv(process.env), encoding: "utf8" }).trim();

/** A clean judgement: the re-judgement lets the tip through unless a test says otherwise. */
const passed = (over: Partial<TaskJudgement> = {}): TaskEvaluation => ({
	ok: true,
	judgement: { problems: [], integrityWarnings: [], ...over } as Partial<TaskJudgement> as TaskJudgement,
});

let root: string;
let origin: string;
let repo: string;
let home: TestHome;
let daemon: Daemon;
/** The re-judgement every core landing of this test gets (the seam keeps the daemon's other deps). */
let judge: (row: TaskRow) => Promise<TaskEvaluation>;
let landCalls: number;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "ompbot-task-land-"));
	origin = join(root, "origin.git");
	repo = join(root, "repo");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: dispatchEnv(process.env) });
	execFileSync("git", ["init", "-q", "-b", "main", repo], { env: dispatchEnv(process.env) });
	git(repo, "config", "user.name", "t");
	git(repo, "config", "user.email", "t@example.test");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "readme\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-q", "-m", "init");
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-q", "origin", "main");
	judge = async () => passed();
	landCalls = 0;
	home = makeHome("ompbot-task-land-home-");
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(new WaitingTransport()))],
		log: createLogger({ sink: () => {}, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		taskLand: (row, deps) => {
			landCalls += 1;
			return landTask(row, { ...deps, judge: (task) => judge(task) });
		},
	});
	await daemon.start();
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
	rmSync(root, { recursive: true, force: true });
});

const commitFile = (dir: string, name: string, text: string, message: string): string => {
	writeFileSync(join(dir, name), text);
	git(dir, "add", name);
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD");
};

/**
 * A reached local task in review: its worktree on `task/<ID>` with one feature commit (`a.txt`) and a docs commit whose
 * outcome.md and PROGRESS.md name the feature commit (9 and 7 hex digits) plus `extraEvidence`.
 */
function seed(extraEvidence = ""): { row: TaskRow; feat: string } {
	const tasks = daemon.store.tasks;
	const registered = tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `slack/ch/${CHANNEL}/t/${THREAD}`,
		threadRef: `${CHANNEL}:${THREAD}`,
		host: null,
		repo,
		acceptance: acceptanceItems(["하나"]),
	});
	const { worktree, branch, taskId } = registered;
	git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	const feat = commitFile(worktree, "a.txt", "task a\n", "feat: a");
	const docs = docsDirOf(worktree, taskId);
	mkdirSync(docs, { recursive: true });
	writeFileSync(join(docs, "outcome.md"), `## AC-1\n- commit: ${feat.slice(0, 9)} feat: a\n${extraEvidence}`);
	writeFileSync(join(docs, "PROGRESS.md"), `- [x] S1 | 증거: commit ${feat.slice(0, 7)}\n`);
	git(worktree, "add", "docs");
	git(worktree, "commit", "-q", "-m", "docs: evidence");
	tasks.transition(taskId, "review", "bot");
	return { row: tasks.require(taskId), feat };
}

const mergeInbounds = () => daemon.store.listInbound().filter((row) => row.textRef.trim().startsWith("머지해"));
const tipOf = (row: TaskRow): string => git(repo, "rev-parse", row.branch);
const moveMainAhead = (): string => commitFile(repo, "b.txt", "main b\n", "feat: b on main");

describe("landTask through Daemon.autoLand (real git)", () => {
	test("AC-1: base not ahead: landed, main ff to the fixed sha and pushed, worktree and branch gone, done by core-land, no '머지해'", async () => {
		const { row } = seed();
		const sha = tipOf(row);
		const result = await daemon.autoLand(row);
		expect(result).toMatchObject({ state: "landed", baseBranch: "main", sha, pushed: "origin/main", notes: [] });
		expect(git(repo, "rev-parse", "main")).toBe(sha);
		expect(git(origin, "rev-parse", "main")).toBe(sha);
		expect(existsSync(row.worktree)).toBe(false);
		expect(git(repo, "branch", "--list", row.branch)).toBe("");
		expect(daemon.store.tasks.require(row.taskId).status).toBe("done");
		expect(daemon.store.tasks.history(row.taskId).at(-1)).toMatchObject({
			fromStatus: "review",
			toStatus: "done",
			actor: "core-land",
		});
		expect(landCalls).toBe(1);
		expect(mergeInbounds()).toHaveLength(0);
	});

	test("AC-2: base ahead: core rebase, a commit replacing the stale evidence hashes, landed at that sha", async () => {
		const { row, feat } = seed();
		const mainB = moveMainAhead();
		const result = await daemon.autoLand(row);
		expect(result.state).toBe("landed");
		if (result.state !== "landed") return;
		expect(result.rebase).toEqual({ oldSha: expect.any(String), newSha: result.sha });
		expect(git(repo, "rev-parse", "main")).toBe(result.sha);
		expect(git(repo, "merge-base", "--is-ancestor", mainB, result.sha)).toBe("");
		expect(git(repo, "log", "-1", "--format=%s", result.sha)).toBe(
			`docs(task): ${row.taskId} rebase 뒤 증거 해시 갱신`,
		);
		const newFeat = git(repo, "log", "-1", "--format=%H", "--grep=^feat: a$", result.sha);
		expect(newFeat).not.toBe(feat);
		const outcome = git(repo, "show", `${result.sha}:docs/tasks/${row.taskId}/outcome.md`);
		const progress = git(repo, "show", `${result.sha}:docs/tasks/${row.taskId}/PROGRESS.md`);
		expect(outcome).toContain(`- commit: ${newFeat.slice(0, 9)} feat: a`);
		expect(progress).toContain(`commit ${newFeat.slice(0, 7)}`);
		for (const text of [outcome, progress]) expect(text).not.toContain(feat.slice(0, 7));
		expect(daemon.store.tasks.require(row.taskId).status).toBe("done");
		expect(mergeInbounds()).toHaveLength(0);
	});

	describe("AC-3: handoff — main does not move, exactly one '머지해'", () => {
		/** Lands, then checks: handoff naming `reason`, main at `mainBefore`, one "머지해", the task still in review. */
		async function expectHandoff(row: TaskRow, reason: string, mainBefore: string) {
			const result = await daemon.autoLand(row);
			expect(result).toMatchObject({ state: "handoff", reason: expect.stringContaining(reason) });
			expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
			expect(git(origin, "rev-parse", "main")).not.toBe(tipOf(row));
			expect(mergeInbounds()).toHaveLength(1);
			expect(daemon.store.tasks.require(row.taskId).status).toBe("review");
			return result;
		}

		test("rebase conflict: worktree branch back at OLD", async () => {
			const { row } = seed();
			const old = tipOf(row);
			const main = commitFile(repo, "a.txt", "main a\n", "feat: other a on main");
			await expectHandoff(row, "rebase 실패(충돌)", main);
			expect(tipOf(row)).toBe(old);
			expect(git(row.worktree, "status", "--porcelain")).toBe("");
		});

		test("evidence hash without a pair: worktree branch back at OLD", async () => {
			git(repo, "checkout", "-q", "-b", "side");
			const side = commitFile(repo, "s.txt", "side\n", "feat: side");
			git(repo, "checkout", "-q", "main");
			const { row } = seed(`- commit: ${side.slice(0, 10)} side\n`);
			const old = tipOf(row);
			const main = moveMainAhead();
			await expectHandoff(row, `해시 짝 없음: ${side.slice(0, 10)}`, main);
			expect(tipOf(row)).toBe(old);
		});

		test("change lost in the rebase: worktree branch back at OLD", async () => {
			const { row } = seed();
			const old = tipOf(row);
			// main already has the task's a.txt change: the rebase drops the feature commit, a.txt leaves the branch diff.
			const main = commitFile(repo, "a.txt", "task a\n", "feat: same a on main");
			await expectHandoff(row, "rebase 뒤 변경 유실: a.txt", main);
			expect(tipOf(row)).toBe(old);
		});

		test("dirty worktree (an untracked file): worktree branch at OLD", async () => {
			const { row } = seed();
			const old = tipOf(row);
			writeFileSync(join(row.worktree, "scratch.txt"), "x\n");
			await expectHandoff(row, "worktree에 커밋 안 된 변경 1건: ?? scratch.txt", git(repo, "rev-parse", "main"));
			expect(tipOf(row)).toBe(old);
		});

		test("non-bare origin URL (a path without .git): worktree branch at OLD", async () => {
			const { row } = seed();
			const old = tipOf(row);
			git(repo, "remote", "set-url", "origin", join(root, "live-checkout"));
			await expectHandoff(row, "비베어 원격 가능성", git(repo, "rev-parse", "main"));
			expect(tipOf(row)).toBe(old);
		});

		test("re-judgement problem after a rebase: the branch stays rebased (OLD→NEW on the result)", async () => {
			const { row } = seed();
			const old = tipOf(row);
			const main = moveMainAhead();
			judge = async () => passed({ problems: ["check AC-1 실패: exit 1"] });
			const result = await expectHandoff(row, "재판정 문제: check AC-1 실패", main);
			expect(result).toMatchObject({ rebase: { oldSha: old, newSha: tipOf(row) } });
			expect(tipOf(row)).not.toBe(old);
			expect(git(repo, "merge-base", "--is-ancestor", main, tipOf(row))).toBe("");
		});

		test("integrity warning", async () => {
			const { row } = seed();
			judge = async () => passed({ integrityWarnings: ["무결성 guard_deletion: 검사 삭제"] });
			await expectHandoff(row, "무결성 경고: 무결성 guard_deletion", git(repo, "rev-parse", "main"));
		});

		test("judgement error (failed evaluation, and a throwing judge)", async () => {
			const { row } = seed();
			judge = async () => ({ ok: false, error: "spec.md read failed" });
			await expectHandoff(row, "판정 오류: spec.md read failed", git(repo, "rev-parse", "main"));
		});

		test("judgement that throws", async () => {
			const { row } = seed();
			judge = async () => {
				throw new Error("check runner died");
			};
			await expectHandoff(row, "판정 오류: check runner died", git(repo, "rev-parse", "main"));
		});

		test("branch moved after the re-judgement", async () => {
			const { row } = seed();
			judge = async (task) => {
				commitFile(task.worktree, "late.txt", "late\n", "feat: late");
				return passed();
			};
			await expectHandoff(row, "검증 뒤 브랜치가 움직임", git(repo, "rev-parse", "main"));
		});
	});

	test("AC-9: push refused: merged-not-pushed, done, no '머지해'", async () => {
		const hook = join(origin, "hooks", "pre-receive");
		writeFileSync(hook, "#!/bin/sh\necho refused-by-test >&2\nexit 1\n");
		chmodSync(hook, 0o755);
		const { row } = seed();
		const sha = tipOf(row);
		const result = await daemon.autoLand(row);
		expect(result).toMatchObject({ state: "merged-not-pushed", sha, reason: expect.stringContaining("rejected") });
		expect(git(repo, "rev-parse", "main")).toBe(sha);
		expect(git(origin, "rev-parse", "main")).not.toBe(sha);
		expect(daemon.store.tasks.require(row.taskId)).toMatchObject({ status: "done" });
		expect(mergeInbounds()).toHaveLength(0);
	});

	test("AC-9: a status change right before the merge (a resume): blocked, main unmoved, no '머지해'", async () => {
		const { row } = seed();
		const main = git(repo, "rev-parse", "main");
		judge = async (task) => {
			daemon.store.tasks.transition(task.taskId, "working", "bot", "resume");
			return passed();
		};
		expect(await daemon.autoLand(row)).toEqual({ state: "blocked", reason: "TASK 상태가 working로 바뀜" });
		expect(git(repo, "rev-parse", "main")).toBe(main);
		expect(daemon.store.tasks.require(row.taskId).status).toBe("working");
		expect(mergeInbounds()).toHaveLength(0);
	});
});

describe("landTask deps (real git)", () => {
	/** Deps over a plain lander; `holdReason` and the lander as the test needs. */
	function deps(over: Partial<TaskLandDeps> = {}): TaskLandDeps {
		return {
			land: createLaneLander({ removeWorktree: (input) => createTaskHostOps().removeWorktree(input) }),
			judge: async () => passed(),
			holdReason: () => undefined,
			ledger: daemon.store.tasks,
			afterDone: async () => [],
			...over,
		};
	}

	test.each<[string, (row: TaskRow) => string | undefined]>([
		["frozen", (row) => taskLandHold(row, { frozen: true, paused: false, hold: undefined })],
		["paused", (row) => taskLandHold(row, { frozen: false, paused: true, hold: undefined })],
		["autoland.hold", (row) => taskLandHold(row, { frozen: false, paused: false, hold: "코드 롤백" })],
		[
			"status change",
			(row) => taskLandHold({ ...row, status: "working" }, { frozen: false, paused: false, hold: undefined }),
		],
	])("AC-9: %s right before the merge: blocked, main and the branch unmoved", async (_name, hold) => {
		const { row } = seed();
		const main = git(repo, "rev-parse", "main");
		const tip = tipOf(row);
		const result = await landTask(row, deps({ holdReason: () => hold(row) }));
		expect(result.state).toBe("blocked");
		expect(git(repo, "rev-parse", "main")).toBe(main);
		expect(tipOf(row)).toBe(tip);
		expect(daemon.store.tasks.require(row.taskId).status).toBe("review");
	});

	test("AC-10: a lane landing and a task landing on one repository share one lander: zero overlap", async () => {
		const events: string[] = [];
		const laneGate = Promise.withResolvers<void>();
		const laneInRemove = Promise.withResolvers<void>();
		const taskQueued = Promise.withResolvers<void>();
		const lander = createLaneLander({
			removeWorktree: async (input) => {
				const who = input.branch.startsWith("lane/") ? "lane" : "task";
				if (who === "lane") {
					laneInRemove.resolve();
					await laneGate.promise;
				}
				await createTaskHostOps().removeWorktree(input);
				events.push(`${who}:end`);
			},
			git: async (args) => {
				if (args.includes("cat-file")) events.push(args.at(-1) === laneSha ? "lane:start" : "task:start");
				return defaultGit(args);
			},
		});
		// The lane: its own worktree and branch in the same repository, one commit on main.
		const laneWorktree = join(root, "lane-wt");
		git(repo, "worktree", "add", "-q", "-b", "lane/L-20261116-01", laneWorktree, "main");
		const laneSha = commitFile(laneWorktree, "lane.txt", "lane\n", "feat: lane");
		const laneRequest: LandRequest = {
			repo,
			baseBranch: "main",
			branch: "lane/L-20261116-01",
			worktree: laneWorktree,
			sha: laneSha,
			push: true,
		};
		const { row } = seed();
		const laneLanding = lander(laneRequest);
		await laneInRemove.promise;
		const shared: LandLane = (request, hooks) => {
			taskQueued.resolve();
			return lander(request, hooks);
		};
		const taskLanding = landTask(row, deps({ land: shared }));
		await taskQueued.promise;
		laneGate.resolve();
		expect(await laneLanding).toMatchObject({ state: "landed" });
		// The task branch is no longer a fast-forward of main: the core rebases it and lands at the new tip.
		const result = await taskLanding;
		expect(result.state).toBe("landed");
		expect(events.filter((event) => event.endsWith(":start") || event.endsWith(":end"))).toEqual([
			"lane:start",
			"lane:end",
			"task:start",
			"task:end",
		]);
		expect(daemon.store.tasks.require(row.taskId).status).toBe("done");
	});
});
