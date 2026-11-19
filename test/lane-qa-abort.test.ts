import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRunner, RunProcessOptions, RunProcessResult } from "../src/dispatch/omp";
import type { LaneRow } from "../src/lanes/status";
import type { AutoLandPolicy } from "../src/tasks/notify";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// A run QA waiting for the review slot ends at once when a landing or discard aborts it, and the slot it queued for is
// given back when it comes, so the queue behind it keeps moving (doc/plans/muse-review-fixes-1.md §3).

const QA_MODEL = "zai/test-qa:high";
const CLEAR = "스펙 충족\nCONFIDENCE: 0.90\nVERDICT: CLEAR";
const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';
const PASS: RunProcessResult = {
	code: 0,
	stdout: `실행함\n${JSON.stringify({ verdict: "PASS", findings: ["bun test 통과"] })}`,
	timedOut: false,
};

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("ompbot-lane-qa-abort-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** One macrotask turn: every microtask queued before it (an `await` continuation) has run. */
async function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

/** Resolves once `cond` holds; yields to the event loop, bounded by a deadline (never a fixed wait). */
async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
	for (const deadline = Date.now() + timeoutMs; !cond() && Date.now() < deadline; ) await nextTurn();
	expect(cond()).toBeTrue();
}

/** Starts an L3 lane titled `title` and commits `a.txt` in its worktree. */
async function startLane(h: LaneHarness, repo: string, title: string): Promise<LaneRow> {
	const started = await h.manager.start({
		title,
		cwd: repo,
		channel: CHANNEL,
		brief: "a.txt를 만든다",
		acceptance: [CHECK_A],
		risk: "L3",
	});
	writeFileSync(join(started.cwd, "a.txt"), "a.txt\n");
	git(started.cwd, "add", "--", "a.txt");
	git(started.cwd, "commit", "-q", "-m", "add a.txt");
	const lane = h.store.getLane(started.name);
	if (lane === undefined) throw new Error(`no lane ${started.name}`);
	return lane;
}

/** Claims the lane's commit; the review and QA the claim starts keep running in the background. */
async function claim(h: LaneHarness, lane: LaneRow): Promise<void> {
	expect(
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a.txt 추가" }),
	).toContain("검증 통과");
}

describe("run QA aborted while it waits for the review slot", () => {
	test("a discard ends the waiting QA at once; the slot it queued for is given back to the next QA", async () => {
		const repoA = makeRepo(repos);
		const repoB = makeRepo(repos);
		const reviewA = Promise.withResolvers<void>();
		const reviewB = Promise.withResolvers<void>();
		const reviewBStarted = Promise.withResolvers<void>();
		const reviews: string[] = [];
		const qaRuns: string[] = [];
		const run: ProcessRunner = async (cmd: string[], opts: RunProcessOptions) => {
			if (cmd[cmd.indexOf("--model") + 1] === QA_MODEL) {
				qaRuns.push(opts.cwd ?? "");
				return PASS;
			}
			reviews.push(cmd.at(-1) ?? "");
			if (reviews.length === 1) await reviewA.promise;
			else {
				reviewBStarted.resolve();
				await reviewB.promise;
			}
			return { code: 0, stdout: CLEAR, timedOut: false };
		};
		let matches = 0;
		const overlay = join(home.dir, "qa.omp.yml");
		writeFileSync(overlay, "modelRoles:\n  default: zai/test-qa:high\n");
		const policy: AutoLandPolicy = {
			repos: [repoA, repoB],
			maxRisk: "L2",
			review: { model: "test/reviewer", timeoutMs: 60_000, confident: { maxRisk: "L3", minConfidence: 0.8 } },
			qa: { minRisk: "L3", overlay, model: QA_MODEL, timeoutMs: 60_000 },
		};
		const h = laneHarness(home.dir, {
			autoLandPolicy: () => policy,
			// Counts each announce's repo check: what follows it up to the review or QA start runs without another await.
			repoMatches: async () => {
				matches += 1;
				return true;
			},
			reviewer: { ompBin: "/bin/omp-fake", systemPromptAppendix: "FLOORS", reviewsDir: join(home.dir, "reviews"), run },
			qaWorktreesDir: join(home.dir, "qa-worktrees"),
		});
		try {
			// A's review holds the slot; B's review queues behind it.
			const a = await startLane(h, repoA, "qa-a");
			const b = await startLane(h, repoB, "qa-b");
			await h.settle();
			await claim(h, a);
			await until(() => reviews.length === 1 && matches === 1);
			await claim(h, b);
			await until(() => matches === 2);
			await nextTurn();
			// A's review ends: B's review takes the slot and A's QA queues behind it.
			reviewA.resolve();
			await reviewBStarted.promise;
			await until(() => matches === 3);
			await nextTurn();
			expect(h.store.getLane(a.name)?.meta.review?.verdict).toBe("CLEAR");

			let discarded = false;
			const discarding = h.manager.discard(a.name).then((outcome) => {
				discarded = true;
				return outcome;
			});
			// B's review still holds the slot: the discard must not wait for it.
			await until(() => discarded);
			expect((await discarding).handled).toBe(true);
			expect(h.store.getLane(a.name)?.meta.land?.state).toBe("discarded");
			expect(h.logs.some((line) => line.includes("lane_qa_aborted") && line.includes(a.name))).toBe(true);
			expect(h.logs.some((line) => line.includes("lane_qa_stopped") && line.includes(a.name))).toBe(true);
			expect(qaRuns).toEqual([]);

			// B's review ends: its QA gets the slot past A's abandoned turn, runs and records its receipt.
			reviewB.resolve();
			await h.settle();
			expect(qaRuns).toHaveLength(1);
			expect(h.store.getLane(b.name)?.meta.qa).toMatchObject({ verdict: "PASS", model: QA_MODEL });
			expect(h.store.getLane(a.name)?.meta.qa).toBeUndefined();
		} finally {
			reviewA.resolve();
			reviewB.resolve();
			await h.settle();
			h.close();
		}
	}, 30_000);
});
