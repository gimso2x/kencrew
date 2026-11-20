import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscordChannelConfig, OmpbotConfig } from "../src/config";
import { parseThreadRef } from "../src/core/normalize";
import { Daemon } from "../src/daemon/daemon";
import { GUEST_OVERLAY_YAML } from "../src/daemon/guest";
import type { ProcessRunner, RunProcessOptions, RunProcessResult } from "../src/dispatch/omp";
import {
	createLaneLander,
	type LandLane,
	type LandRequest,
	laneLandBlockers,
	QA_FAIL,
	QA_MISSING,
} from "../src/lanes/land";
import { parseQaVerdict, qaOverlayPath, qaWorktreePath } from "../src/lanes/qa";
import {
	buildReviewPrompt,
	parseReviewVerdict,
	REVIEW_DIFF_PROMPT_MAX,
	REVIEW_DISABLED_DISCOVERY,
	REVIEW_OVERLAY_YAML,
	REVIEW_SECTIONS,
	reviewIsolationPaths,
	reviewLane,
} from "../src/lanes/review";
import { bootRuntime, overlayHash } from "../src/lanes/runtime";
import type { LaneRow } from "../src/lanes/status";
import { defaultGit, type GitRunner } from "../src/lanes/verify";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { TaskRisk } from "../src/tasks/docs";
import { createTaskHostOps } from "../src/tasks/host";
import type { AutoLandPolicy } from "../src/tasks/notify";
import {
	CHANNEL,
	discordBinding,
	GUILD,
	makeHome,
	OWNER_DM,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import type { FakeDiscordCall } from "./helpers/discord-fake-transport";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// The independent review before a lane's auto-merge (doc/plans/lane-review-receipt.md). Git is real (temp
// repositories); the reviewer's `omp -p` is a fake process runner.

const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';
const MODEL = "test/reviewer";
const REVIEW = { model: MODEL, timeoutMs: 60_000 };

type Post = Extract<FakeDiscordCall, { method: "createMessage" }>;

let home: TestHome;
let repos: string[];
let daemons: Daemon[];

beforeEach(() => {
	home = makeHome("ompbot-lane-review-home-");
	repos = [];
	daemons = [];
});

afterEach(async () => {
	for (const daemon of daemons) await daemon.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

interface ReviewCall {
	cmd: string[];
	opts: RunProcessOptions;
}

/** A fake `omp -p`: every call is recorded and answered by `answer`. */
function fakeRunner(answer: (call: ReviewCall) => RunProcessResult | Promise<RunProcessResult>): {
	run: ProcessRunner;
	calls: ReviewCall[];
} {
	const calls: ReviewCall[] = [];
	return {
		calls,
		run: async (cmd, opts) => {
			const call = { cmd, opts };
			calls.push(call);
			return answer(call);
		},
	};
}

const says = (stdout: string, over: Partial<RunProcessResult> = {}) =>
	fakeRunner(() => ({ code: 0, stdout, timedOut: false, ...over }));

/** The real landing, every call counted. */
function countingLand(): { land: LandLane; calls: LandRequest[] } {
	const real = createLaneLander({ removeWorktree: (input) => createTaskHostOps().removeWorktree(input) });
	const calls: LandRequest[] = [];
	return {
		calls,
		land: (request, hooks) => {
			calls.push(request);
			return real(request, hooks);
		},
	};
}

const reviewsDir = (): string => join(home.dir, "reviews");

function harness(
	run: ProcessRunner,
	policy: AutoLandPolicy | undefined,
	extra: { git?: GitRunner; land?: LandLane } = {},
): LaneHarness {
	return laneHarness(home.dir, {
		...(extra.land === undefined ? {} : { land: extra.land }),
		...(policy === undefined ? {} : { autoLandPolicy: () => policy }),
		reviewer: {
			ompBin: "/bin/omp-fake",
			systemPromptAppendix: "FLOORS",
			reviewsDir: reviewsDir(),
			run,
			...(extra.git === undefined ? {} : { git: extra.git }),
		},
	});
}

function commitIn(dir: string, file: string): string {
	writeFileSync(join(dir, file), `${file}\n`);
	git(dir, "add", "--", file);
	git(dir, "commit", "-q", "-m", `add ${file}`);
	return git(dir, "rev-parse", "HEAD");
}

/** The test home's config with lanes opening in the server channel `CHANNEL` (the DM has no lane channel of its own). */
function laneConfig(): OmpbotConfig {
	return {
		...home.config,
		channels: { discord: { ...(home.config.channels.discord as DiscordChannelConfig), laneChannelId: CHANNEL } },
	};
}

function requireLane(h: LaneHarness, name: string): LaneRow {
	const lane = h.store.getLane(name);
	if (lane === undefined) throw new Error(`no lane ${name}`);
	return lane;
}

/** Starts a lane, commits `a.txt` and claims it; `settle` false leaves the background work (the review) running. */
async function closeLane(
	h: LaneHarness,
	repo: string,
	settle = true,
	risk: TaskRisk = "L2",
): Promise<{ lane: LaneRow; sha: string }> {
	const started = await h.manager.start({
		title: "review",
		cwd: repo,
		channel: CHANNEL,
		brief: "a.txt를 만든다",
		acceptance: [CHECK_A],
		risk,
	});
	await h.settle();
	const sha = commitIn(started.cwd, "a.txt");
	expect(
		await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "a.txt 추가" }),
	).toContain("검증 통과");
	if (settle) await h.settle();
	return { lane: requireLane(h, started.name), sha };
}

const rootIdOf = (lane: LaneRow): string => parseThreadRef(lane.threadRef)?.threadTs ?? "";
const cardPosts = (transport: WaitingDiscordTransport, lane: LaneRow): Post[] =>
	transport.posts().filter((post) => post.channelId === rootIdOf(lane) && post.id !== lane.meta.statusTs);
const diffFiles = (lane: LaneRow): string[] =>
	existsSync(reviewsDir()) ? readdirSync(reviewsDir()).filter((entry) => entry.startsWith(`${lane.meta.laneId}-`)) : [];
/** The argument after `flag` in an argv. */
const argOf = (cmd: string[], flag: string): string | undefined => cmd[cmd.indexOf(flag) + 1];
const ISOLATION_FLAGS = ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files"];

/** What the reviewer's isolation looked like when the runner was called (lane-review-isolation AC-2·AC-3). */
interface IsolationSeen {
	cwd: string;
	cwdEntries: string[];
	cwdMode: number;
	configPath: string;
	configMode: number;
	config: unknown;
}

function seeIsolation(call: ReviewCall): IsolationSeen {
	const cwd = call.opts.cwd ?? "";
	const configPath = argOf(call.cmd, "--config") ?? "";
	return {
		cwd,
		cwdEntries: readdirSync(cwd),
		cwdMode: statSync(cwd).mode & 0o777,
		configPath,
		configMode: statSync(configPath).mode & 0o777,
		config: Bun.YAML.parse(readFileSync(configPath, "utf8")),
	};
}

describe("without taskAutoLand.review nothing changes (AC-1)", () => {
	test.each([
		["no review key", { repos: [] as string[], maxRisk: "L2" as const }],
		["no taskAutoLand at all", undefined],
	])("%s: the reviewer is never run", async (_name, policyShape) => {
		const repo = makeRepo(repos);
		const fake = says("VERDICT: CLEAR");
		const counted = countingLand();
		const policy = policyShape === undefined ? undefined : { ...policyShape, repos: [repo] };
		const h = harness(fake.run, policy, { land: counted.land });
		const { lane } = await closeLane(h, repo);
		await h.manager.tick();
		await h.settle();
		expect(fake.calls).toHaveLength(0);
		expect(requireLane(h, lane.name).meta.review).toBeUndefined();
		// With the policy the lane lands as before; without it the card asks.
		expect(counted.calls).toHaveLength(policy === undefined ? 0 : 1);
		expect(cardPosts(h.transport, lane)).toHaveLength(1);
		h.close();
	});
});

describe("review before auto-merge", () => {
	test("AC-2: CLEAR — one run in the worktree with --model and read-only tools, the receipt is stored, the lane lands once", async () => {
		const repo = makeRepo(repos);
		const seen: IsolationSeen[] = [];
		const fake = fakeRunner((call) => {
			seen.push(seeIsolation(call));
			return { code: 0, stdout: "diff가 스펙을 충족한다.\nVERDICT: CLEAR\n", timedOut: false };
		});
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane, sha } = await closeLane(h, repo);
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0] as ReviewCall;
		// lane-review-isolation AC-2: the cwd is an empty directory under reviewsDir, never the worktree.
		const isolation = reviewIsolationPaths(reviewsDir(), lane, sha);
		expect(call.opts.cwd).not.toBe(lane.meta.worktree);
		expect(call.opts.cwd).toBe(isolation.cwd);
		expect(call.opts.cwd?.startsWith(`${reviewsDir()}/`)).toBe(true);
		expect(seen[0]).toMatchObject({ cwdEntries: [], cwdMode: 0o700, configPath: isolation.configPath });
		const at = call.cmd.indexOf("--no-session");
		expect(call.cmd.slice(at + 1, at + 7)).toEqual(["--config", isolation.configPath, ...ISOLATION_FLAGS]);
		expect(argOf(call.cmd, "--model")).toBe(MODEL);
		expect(argOf(call.cmd, "--tools")).toBe("read,grep,glob");
		expect(call.opts.timeoutMs).toBe(REVIEW.timeoutMs);
		const after = requireLane(h, lane.name);
		expect(after.meta.review).toMatchObject({ sha, verdict: "CLEAR", model: MODEL, notes: "diff가 스펙을 충족한다." });
		expect(after.meta.review?.runtime).toMatchObject({
			head: sha,
			os: process.platform,
			arch: process.arch,
			overlay: overlayHash(REVIEW_OVERLAY_YAML),
		});
		expect(after.meta.checks?.runtime).toMatchObject({ head: sha, os: process.platform, arch: process.arch });
		expect(after.history.some((entry) => entry.event === "review" && entry.detail === `CLEAR · ${MODEL}`)).toBe(true);
		expect(counted.calls).toHaveLength(1);
		expect(after.meta.land?.state).toBe("landed");
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.content).toContain(`🔎 독립 리뷰 CLEAR · ${MODEL}`);
		// AC-12: the landing removed the review's diff file.
		expect(diffFiles(lane)).toEqual([]);
		await h.manager.tick();
		await h.settle();
		expect(fake.calls).toHaveLength(1);
		h.close();
	});

	test("AC-3·AC-7·AC-12: BLOCK — no landing, the card asks and quotes the findings; the owner's 머지 still lands and the diff file goes", async () => {
		const repo = makeRepo(repos);
		const fake = says("src/a.ts:3 — 테스트를 지웠다\nVERDICT: BLOCK");
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane, sha } = await closeLane(h, repo);
		expect(fake.calls).toHaveLength(1);
		expect(counted.calls).toHaveLength(0);
		const blocked = requireLane(h, lane.name);
		expect(blocked.meta.review).toMatchObject({ sha, verdict: "BLOCK" });
		expect(blocked.meta.land?.state).toBe("pending");
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.content).toContain("자동 머지 안 함: 독립 리뷰 BLOCK");
		expect(cards[0]?.content).toContain("*리뷰 지적*");
		expect(cards[0]?.content).toContain("테스트를 지웠다");
		expect(JSON.stringify(cards[0]?.components ?? [])).toContain(`ompbot:lane:merge:${lane.name}`);
		expect(diffFiles(lane)).toEqual([]);

		const outcome = await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(outcome.handled).toBe(true);
		expect(counted.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		expect(diffFiles(lane)).toEqual([]);
		h.close();
	});

	test.each([
		["timed out", { code: null, stdout: "절반", timedOut: true }, "시간 초과"],
		["exit code 1", { code: 1, stdout: "boom\nVERDICT: CLEAR", timedOut: false }, "종료 코드 1"],
		["no VERDICT line", { code: 0, stdout: "다 좋아 보입니다", timedOut: false }, "VERDICT 없음"],
		[
			"two VERDICT lines",
			{ code: 0, stdout: "VERDICT: BLOCK\n다시 보니\nVERDICT: CLEAR", timedOut: false },
			"VERDICT 여러 줄",
		],
	])("AC-4: %s is inconclusive and nothing lands", async (_name, result, reason) => {
		const repo = makeRepo(repos);
		const fake = fakeRunner(() => result);
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane, sha } = await closeLane(h, repo);
		expect(fake.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.review).toMatchObject({ sha, verdict: "inconclusive", reason });
		expect(counted.calls).toHaveLength(0);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("pending");
		expect(cardPosts(h.transport, lane)[0]?.content).toContain(`독립 리뷰 확인 불가(${reason})`);
		h.close();
	});

	test("a receipt made on another omp major.minor is reviewed again after a restart; a patch bump is not", async () => {
		const unknownRuntime = () =>
			bootRuntime({
				omp: "unknown",
				sourceDir: "/nonexistent",
				git: async () => ({ code: 1, stdout: "", stderr: "" }),
			});
		const repo = makeRepo(repos);
		const fake = says("src/a.ts:1 — 범위 밖\nVERDICT: BLOCK");
		const policy = { repos: [repo], maxRisk: "L2" as const, review: REVIEW };
		try {
			await bootRuntime({ omp: "omp 18.18.7", sourceDir: makeRepo(repos) });
			const first = harness(fake.run, policy);
			const post = first.transport.createMessage.bind(first.transport);
			first.transport.createMessage = async (args) => {
				if (args.content?.includes("머지 대기")) throw new Error("discord down");
				return post(args);
			};
			const { lane } = await closeLane(first, repo);
			expect(fake.calls).toHaveLength(1);
			expect(requireLane(first, lane.name).meta.review?.runtime?.omp).toBe("omp 18.18.7");
			first.close();

			await bootRuntime({ omp: "omp 18.18.9", sourceDir: makeRepo(repos) });
			const patched = harness(fake.run, policy);
			patched.transport.setChannel({ id: rootIdOf(lane), type: 11, parentId: CHANNEL, guildId: GUILD });
			const post2 = patched.transport.createMessage.bind(patched.transport);
			patched.transport.createMessage = async (args) => {
				if (args.content?.includes("머지 대기")) throw new Error("discord down");
				return post2(args);
			};
			await patched.manager.tick();
			await patched.settle();
			expect(fake.calls).toHaveLength(1);
			patched.close();

			await bootRuntime({ omp: "omp 18.19.0", sourceDir: makeRepo(repos) });
			const minor = harness(fake.run, policy);
			minor.transport.setChannel({ id: rootIdOf(lane), type: 11, parentId: CHANNEL, guildId: GUILD });
			await minor.manager.tick();
			await minor.settle();
			expect(fake.calls).toHaveLength(2);
			const redone = requireLane(minor, lane.name);
			expect(redone.meta.review?.runtime?.omp).toBe("omp 18.19.0");
			expect(
				redone.history.some((entry) => entry.event === "review" && entry.detail?.includes("재검사(omp 18.18 → 18.19)")),
			).toBe(true);
			minor.close();
		} finally {
			await unknownRuntime();
		}
	});

	test("AC-5: a receipt for the same commit is not reviewed again when the lane is announced again after a restart", async () => {
		const repo = makeRepo(repos);
		const fake = says("src/a.ts:1 — 범위 밖\nVERDICT: BLOCK");
		const policy = { repos: [repo], maxRisk: "L2" as const, review: REVIEW };
		const first = harness(fake.run, policy);
		// The Outcome card cannot be posted: the lane stays without a card for the next announce.
		const post = first.transport.createMessage.bind(first.transport);
		first.transport.createMessage = async (args) => {
			if (args.content?.includes("머지 대기")) throw new Error("discord down");
			return post(args);
		};
		const { lane, sha } = await closeLane(first, repo);
		expect(fake.calls).toHaveLength(1);
		expect(requireLane(first, lane.name).meta.review).toMatchObject({ sha, verdict: "BLOCK" });
		expect(requireLane(first, lane.name).meta.land?.cardTs).toBeUndefined();
		first.close();

		const second = harness(fake.run, policy);
		// A fresh port after the restart: the lane thread is known to Discord, not to this transport yet.
		second.transport.setChannel({ id: rootIdOf(lane), type: 11, parentId: CHANNEL, guildId: GUILD });
		await second.manager.tick();
		await second.settle();
		expect(fake.calls).toHaveLength(1);
		const shown = requireLane(second, lane.name);
		expect(shown.meta.land?.cardTs).toBeDefined();
		expect(cardPosts(second.transport, shown)[0]?.content).toContain("독립 리뷰 BLOCK");
		await second.manager.tick();
		await second.settle();
		expect(fake.calls).toHaveLength(1);
		second.close();
	});

	test("AC-6: a receipt of another commit is no receipt; the auto request re-checks right before landing", async () => {
		const repo = makeRepo(repos);
		const fake = says("VERDICT: BLOCK");
		const counted = countingLand();
		const policy = { repos: [repo], maxRisk: "L2" as const, review: REVIEW };
		const h = harness(fake.run, policy, { land: counted.land });
		const { lane, sha } = await closeLane(h, repo);
		const clear = { sha, verdict: "CLEAR" as const, model: MODEL, at: 0, notes: "" };
		const cleared = { ...lane, meta: { ...lane.meta, review: clear } };
		expect(laneLandBlockers(cleared, policy, true, false)).toEqual([]);
		const stale = { ...lane, meta: { ...lane.meta, review: { ...clear, sha: "0".repeat(40) } } };
		expect(laneLandBlockers(stale, policy, true, false)).toEqual(["독립 리뷰 없음"]);
		const none = { ...lane, meta: { ...lane.meta, review: undefined } };
		expect(laneLandBlockers(none, policy, true, false)).toEqual(["독립 리뷰 없음"]);
		expect(laneLandBlockers(none, { repos: [repo], maxRisk: "L2" }, true, false)).toEqual([]);

		// The BLOCK receipt stands: an auto request lands nothing and the card keeps asking with the reason.
		const outcome = await h.manager.requestLand(lane.name, "auto");
		await h.settle();
		expect(outcome.text).toContain("독립 리뷰 BLOCK");
		expect(counted.calls).toHaveLength(0);
		const after = requireLane(h, lane.name);
		expect(after.meta.land).toMatchObject({ state: "pending" });
		expect(after.meta.land?.requestedBy).toBeUndefined();
		h.close();
	});

	test("AC-10: stop() aborts the running review and no receipt is stored", async () => {
		const repo = makeRepo(repos);
		const started = Promise.withResolvers<AbortSignal>();
		const fake = fakeRunner(({ opts }) => {
			const signal = opts.signal as AbortSignal;
			started.resolve(signal);
			const ended = Promise.withResolvers<RunProcessResult>();
			signal.addEventListener("abort", () => ended.resolve({ code: null, stdout: "", timedOut: false }));
			return ended.promise;
		});
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane } = await closeLane(h, repo, false);
		const signal = await started.promise;
		expect(signal.aborted).toBe(false);
		h.manager.stop();
		expect(signal.aborted).toBe(true);
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.review).toBeUndefined();
		expect(after.history.some((entry) => entry.event === "review")).toBe(false);
		expect(counted.calls).toHaveLength(0);
		expect(cardPosts(h.transport, lane)).toHaveLength(0);
		h.close();
	});

	test("AC-11: the tick returns while the review runs; the result then lands the lane", async () => {
		const repo = makeRepo(repos);
		const called = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<RunProcessResult>();
		const fake = fakeRunner(() => {
			called.resolve();
			return answer.promise;
		});
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane } = await closeLane(h, repo, false);
		await called.promise;
		await h.manager.tick();
		await h.manager.tick();
		expect(fake.calls).toHaveLength(1);
		expect(cardPosts(h.transport, lane)).toHaveLength(0);
		expect(counted.calls).toHaveLength(0);

		answer.resolve({ code: 0, stdout: "VERDICT: CLEAR", timedOut: false });
		await h.settle();
		expect(counted.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		h.close();
	});

	test("AC-11·AC-12: after !reopen the second review diffs from merge-base <baseBranch> <sha>, not from the old claim; reopen drops the receipt and diff file", async () => {
		const repo = makeRepo(repos);
		const base = git(repo, "symbolic-ref", "--short", "HEAD");
		const forkPoint = git(repo, "rev-parse", "HEAD");
		const calls: string[][] = [];
		const recording: GitRunner = (args) => {
			calls.push(args);
			return defaultGit(args);
		};
		let verdict = "VERDICT: BLOCK";
		const fake = fakeRunner(() => ({ code: 0, stdout: verdict, timedOut: false }));
		const counted = countingLand();
		const h = harness(
			fake.run,
			{ repos: [repo], maxRisk: "L2", review: REVIEW },
			{ git: recording, land: counted.land },
		);
		const { lane, sha: first } = await closeLane(h, repo);
		// The review took its diff file away itself; a leftover of a killed daemon is what the reopen drops.
		expect(diffFiles(lane)).toEqual([]);
		mkdirSync(reviewsDir(), { recursive: true });
		writeFileSync(join(reviewsDir(), `${lane.meta.laneId}-${first.slice(0, 12)}.diff`), "x");
		expect(diffFiles(lane)).toHaveLength(1);

		h.manager.onOwnerMessage(requireLane(h, lane.name), "!reopen b.txt도 추가");
		await h.settle();
		const reopened = requireLane(h, lane.name);
		expect(reopened.status).toBe("working");
		expect(reopened.meta.baseSha).toBe(first);
		expect(reopened.meta.review).toBeUndefined();
		expect(diffFiles(lane)).toEqual([]);

		verdict = "VERDICT: CLEAR";
		calls.length = 0;
		const second = commitIn(reopened.cwd, "b.txt");
		await h.manager.claimDone(reopened.originKey, { repo: reopened.cwd, commit: "HEAD", summary: "b.txt 추가" });
		await h.settle();
		expect(fake.calls).toHaveLength(2);
		const mergeBase = calls.filter((args) => args.includes("merge-base"));
		expect(mergeBase).toEqual([["-C", lane.meta.repo ?? "", "merge-base", `refs/heads/${base}`, second]]);
		const diffs = calls.filter((args) => args.includes("diff"));
		expect(diffs).toHaveLength(2);
		for (const args of diffs) expect(args.at(-1)).toBe(`${forkPoint}..${second}`);
		expect(calls.flat().some((arg) => arg.includes(first))).toBe(false);
		// The prompt holds both commits' work.
		const prompt = fake.calls[1]?.cmd.at(-1) ?? "";
		expect(prompt).toContain("a.txt");
		expect(prompt).toContain("b.txt");
		expect(counted.calls).toHaveLength(1);
		h.close();
	});

	test("AC-12: a discarded lane's diff file is gone", async () => {
		const repo = makeRepo(repos);
		const fake = says("VERDICT: BLOCK");
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW });
		const { lane, sha } = await closeLane(h, repo);
		expect(diffFiles(lane)).toEqual([]);
		// lane-review-isolation AC-6: a leftover diff, overlay and cwd (a killed daemon's) go with it, the cwd recursively.
		const leftover = reviewIsolationPaths(reviewsDir(), lane, sha);
		writeFileSync(join(reviewsDir(), `${lane.meta.laneId}-${sha.slice(0, 12)}.diff`), "x");
		writeFileSync(leftover.configPath, "x");
		mkdirSync(join(leftover.cwd, "sub"), { recursive: true });
		writeFileSync(join(leftover.cwd, "sub", "f"), "x");
		expect(diffFiles(lane)).toHaveLength(3);
		expect((await h.manager.discard(lane.name)).handled).toBe(true);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("discarded");
		expect(diffFiles(lane)).toEqual([]);
		h.close();
	});
});

describe("run QA after the review (doc/plans/bot-org-risk-gates.md 단계 3, 레인 C)", () => {
	const QA_MODEL = "zai/test-qa:high";
	const CLEAR = "스펙 충족\nCONFIDENCE: 0.90\nVERDICT: CLEAR";
	const qaDir = (): string => join(home.dir, "qa-worktrees");
	const isQa = (call: ReviewCall): boolean => argOf(call.cmd, "--model") === QA_MODEL;
	const pass = (finding = "bun test 통과"): RunProcessResult => ({
		code: 0,
		stdout: `실행함\n${JSON.stringify({ verdict: "PASS", findings: [finding] })}`,
		timedOut: false,
	});

	function qaOverlay(): string {
		const path = join(home.dir, "qa.omp.yml");
		writeFileSync(path, "modelRoles:\n  default: zai/test-qa:high\n");
		return path;
	}

	/** Review (confident band up to L3) and QA from L3, as 송박 will set them after the merge. */
	function qaPolicy(repo: string, withQa = true): AutoLandPolicy {
		return {
			repos: [repo],
			maxRisk: "L2",
			review: { ...REVIEW, confident: { maxRisk: "L3", minConfidence: 0.8 } },
			...(withQa ? { qa: { minRisk: "L3" as const, overlay: qaOverlay(), model: QA_MODEL, timeoutMs: 60_000 } } : {}),
		};
	}

	function qaHarness(run: ProcessRunner, policy: AutoLandPolicy, land?: LandLane): LaneHarness {
		return laneHarness(home.dir, {
			...(land === undefined ? {} : { land }),
			autoLandPolicy: () => policy,
			reviewer: { ompBin: "/bin/omp-fake", systemPromptAppendix: "FLOORS", reviewsDir: reviewsDir(), run },
			qaWorktreesDir: qaDir(),
		});
	}

	/** Linked worktrees of `repo` as `git worktree list` names them. */
	const worktreeList = (repo: string): string => git(repo, "worktree", "list", "--porcelain");
	const leftCopies = (): string[] => (existsSync(qaDir()) ? readdirSync(qaDir()) : []);

	test("AC-1·AC-5·AC-6: an L3 lane is reviewed, then QA'd once in a detached copy of its sha; PASS frees it and it lands", async () => {
		const repo = makeRepo(repos);
		const order: string[] = [];
		let atQa: { exists: boolean; head: string; laneHead: string; laneStatus: string } | undefined;
		let h: LaneHarness | undefined;
		const fake = fakeRunner((call) => {
			if (!isQa(call)) {
				order.push("review");
				return { code: 0, stdout: CLEAR, timedOut: false };
			}
			order.push("qa");
			const cwd = call.opts.cwd ?? "";
			const laneWorktree = h?.store.listLanes()[0]?.meta.worktree ?? "";
			atQa = {
				exists: existsSync(cwd),
				head: git(cwd, "rev-parse", "HEAD"),
				laneHead: git(laneWorktree, "rev-parse", "HEAD"),
				laneStatus: git(laneWorktree, "status", "--porcelain"),
			};
			return pass();
		});
		const counted = countingLand();
		const policy = qaPolicy(repo);
		h = qaHarness(fake.run, policy, counted.land);
		const { lane, sha } = await closeLane(h, repo, true, "L3");
		// AC-5: review → CLEAR → QA → PASS → merge, in one go.
		expect(order).toEqual(["review", "qa"]);
		const call = fake.calls.find(isQa) as ReviewCall;
		const copy = qaWorktreePath(qaDir(), lane, sha);
		expect(copy).toBe(join(home.dir, "qa-worktrees", `${lane.meta.laneId}-${sha}`));
		expect(call.opts.cwd).toBe(copy);
		expect(call.opts.timeoutMs).toBe(60_000);
		// AC-6: --model <qa.model>, the reviewer's isolation overlay and then qa.overlay; the default tools (bash).
		const at = call.cmd.indexOf("--no-session");
		expect(call.cmd.slice(at + 1, at + 9)).toEqual([
			"--config",
			qaOverlayPath(reviewsDir(), lane, sha),
			...ISOLATION_FLAGS,
			"--config",
			policy.qa?.overlay ?? "",
		]);
		expect(argOf(call.cmd, "--model")).toBe(QA_MODEL);
		expect(call.cmd).not.toContain("--tools");
		expect(call.cmd.at(-1)).toContain("a.txt가 있다");
		// The copy held the claim commit; the lane worktree stayed at it, clean.
		expect(atQa).toEqual({ exists: true, head: sha, laneHead: sha, laneStatus: "" });
		const after = requireLane(h, lane.name);
		expect(after.meta.qa).toMatchObject({ sha, verdict: "PASS", findings: ["bun test 통과"], model: QA_MODEL });
		expect(after.meta.qa?.runtime).toMatchObject({ head: sha, os: process.platform, arch: process.arch });
		expect(after.meta.qa?.runtime?.overlay).toMatch(/^[0-9a-f]{16}$/);
		expect(after.history.some((entry) => entry.event === "qa" && entry.detail === `PASS · ${QA_MODEL}`)).toBe(true);
		expect(laneLandBlockers(after, policy, true, false)).toEqual([]);
		expect(counted.calls).toHaveLength(1);
		expect(after.meta.land?.state).toBe("landed");
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.content).toContain("🧪 실행 QA(뚱기 · test-qa): PASS");
		// AC-6: the copy is gone, from disk and from git's worktree list.
		expect(leftCopies()).toEqual([]);
		expect(worktreeList(repo)).not.toContain(copy);
		await h.manager.tick();
		await h.settle();
		expect(fake.calls).toHaveLength(2);
		h.close();
	});

	test.each([
		["FAIL", { code: 0, stdout: '{"verdict":"FAIL","findings":["bun test 3 fail"]}', timedOut: false }, QA_FAIL],
		["a timeout", { code: null, stdout: "", timedOut: true }, "실행 QA 확인 불가(시간 초과)"],
		[
			"an unparsable last line",
			{ code: 0, stdout: "다 돌려 봤다\nPASS", timedOut: false },
			"실행 QA 확인 불가(마지막 줄이 JSON 아님)",
		],
	] as const)(
		"AC-2·AC-6: %s holds the merge, the copy goes, the lane worktree is untouched",
		async (_name, answer, reason) => {
			const repo = makeRepo(repos);
			const fake = fakeRunner((call) => (isQa(call) ? { ...answer } : { code: 0, stdout: CLEAR, timedOut: false }));
			const counted = countingLand();
			const policy = qaPolicy(repo);
			const h = qaHarness(fake.run, policy, counted.land);
			const { lane, sha } = await closeLane(h, repo, true, "L3");
			expect(fake.calls.filter(isQa)).toHaveLength(1);
			const after = requireLane(h, lane.name);
			expect(after.meta.qa?.sha).toBe(sha);
			expect(laneLandBlockers(after, policy, true, false)).toEqual([reason]);
			expect(counted.calls).toHaveLength(0);
			expect(after.meta.land?.state).toBe("pending");
			const cards = cardPosts(h.transport, lane);
			expect(cards).toHaveLength(1);
			expect(cards[0]?.content).toContain(`자동 머지 안 함: ${reason}`);
			expect(leftCopies()).toEqual([]);
			expect(worktreeList(repo)).not.toContain(qaWorktreePath(qaDir(), lane, sha));
			const worktree = after.meta.worktree ?? "";
			expect(git(worktree, "rev-parse", "HEAD")).toBe(sha);
			expect(git(worktree, "status", "--porcelain")).toBe("");
			// One commit is run once: the tick after does not run it again.
			await h.manager.tick();
			await h.settle();
			expect(fake.calls.filter(isQa)).toHaveLength(1);
			h.close();
		},
	);

	test.each([
		["an L2 lane with qa set", "L2" as const, true],
		["an L3 lane without qa", "L3" as const, false],
	])("AC-4: %s is never QA'd and lands on its review alone", async (_name, risk, withQa) => {
		const repo = makeRepo(repos);
		const fake = fakeRunner(() => ({ code: 0, stdout: CLEAR, timedOut: false }));
		const counted = countingLand();
		const policy = qaPolicy(repo, withQa);
		const h = qaHarness(fake.run, policy, counted.land);
		const { lane } = await closeLane(h, repo, true, risk);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls.filter(isQa)).toHaveLength(0);
		const after = requireLane(h, lane.name);
		expect(after.meta.qa).toBeUndefined();
		expect(counted.calls).toHaveLength(1);
		expect(cardPosts(h.transport, lane)[0]?.content).not.toContain("실행 QA");
		h.close();
	});

	test("AC-5: an L4 (unreviewable) lane is neither reviewed nor QA'd and asks for its risk only", async () => {
		const repo = makeRepo(repos);
		const fake = says(CLEAR);
		const counted = countingLand();
		const h = qaHarness(fake.run, qaPolicy(repo), counted.land);
		const { lane } = await closeLane(h, repo, true, "L4");
		expect(fake.calls).toHaveLength(0);
		expect(counted.calls).toHaveLength(0);
		const text = cardPosts(h.transport, lane)[0]?.content ?? "";
		expect(text).toContain("자동 머지 안 함: 위험 L4 > L2");
		expect(text).not.toContain("실행 QA");
		h.close();
	});

	test.each([
		["the owner's 머지", "land"],
		["폐기", "discard"],
	] as const)("AC-7: %s during the QA aborts it; no receipt is written and the copy goes", async (_name, action) => {
		const repo = makeRepo(repos);
		const started = Promise.withResolvers<string>();
		const aborted: boolean[] = [];
		const fake = fakeRunner((call) => {
			if (!isQa(call)) return { code: 0, stdout: CLEAR, timedOut: false };
			const signal = call.opts.signal;
			// Ends only when the core aborts it (like a long QA run killed by its abort switch).
			const ended = Promise.withResolvers<RunProcessResult>();
			signal?.addEventListener("abort", () => {
				aborted.push(true);
				ended.resolve({ code: null, stdout: "", timedOut: false });
			});
			started.resolve(call.opts.cwd ?? "");
			return ended.promise;
		});
		const counted = countingLand();
		const h = qaHarness(fake.run, qaPolicy(repo), counted.land);
		const { lane } = await closeLane(h, repo, false, "L3");
		const copy = await started.promise;
		expect(existsSync(copy)).toBe(true);
		const outcome =
			action === "land" ? await h.manager.requestLand(lane.name, "owner") : await h.manager.discard(lane.name);
		await h.settle();
		expect(outcome.handled).toBe(true);
		expect(aborted).toEqual([true]);
		const after = requireLane(h, lane.name);
		expect(after.meta.qa).toBeUndefined();
		expect(after.history.some((entry) => entry.event === "qa")).toBe(false);
		expect(after.meta.land?.state).toBe(action === "land" ? "landed" : "discarded");
		expect(existsSync(copy)).toBe(false);
		expect(worktreeList(repo)).not.toContain(copy);
		expect(h.logs.some((line) => line.includes("lane_qa_stopped"))).toBe(true);
		h.close();
	});

	test("AC-7: a receipt whose lane moved to another sha meanwhile is dropped", async () => {
		const repo = makeRepo(repos);
		let h: LaneHarness | undefined;
		const fake = fakeRunner((call) => {
			if (!isQa(call)) return { code: 0, stdout: CLEAR, timedOut: false };
			const name = h?.store.listLanes()[0]?.name ?? "";
			h?.store.patchLane(name, undefined, { sha: "f".repeat(40) });
			return pass();
		});
		const counted = countingLand();
		h = qaHarness(fake.run, qaPolicy(repo), counted.land);
		const { lane } = await closeLane(h, repo, true, "L3");
		expect(fake.calls.filter(isQa)).toHaveLength(1);
		const after = requireLane(h, lane.name);
		expect(after.meta.qa).toBeUndefined();
		expect(h.logs.some((line) => line.includes("lane_qa_stale"))).toBe(true);
		expect(counted.calls).toHaveLength(0);
		expect(leftCopies()).toEqual([]);
		h.close();
	});

	test("AC-7: copies left in qa-worktrees are removed when the manager starts, from disk and git's list", async () => {
		const repo = makeRepo(repos);
		const sha = git(repo, "rev-parse", "HEAD");
		const leftover = join(qaDir(), `L-20270115-01-${sha}`);
		mkdirSync(qaDir(), { recursive: true });
		git(repo, "worktree", "add", "--detach", leftover, sha);
		writeFileSync(join(leftover, "untracked.txt"), "x");
		const broken = join(qaDir(), "not-a-worktree");
		mkdirSync(broken);
		expect(worktreeList(repo)).toContain(leftover);
		const h = qaHarness(says(CLEAR).run, qaPolicy(repo));
		await h.settle();
		expect(leftCopies()).toEqual([]);
		expect(worktreeList(repo)).not.toContain(leftover);
		h.close();
	});

	test("parseQaVerdict: the last line only; a closing fence is skipped; findings are capped and redacted", () => {
		expect(parseQaVerdict('a\n{"verdict":"PASS","findings":["ok"]}\n```\n')).toEqual({
			verdict: "PASS",
			findings: ["ok"],
		});
		expect(parseQaVerdict('{"verdict":"FAIL"}')).toEqual({ verdict: "FAIL", findings: [] });
		expect(parseQaVerdict('{"verdict":"PASS","findings":["x"]}\n끝')).toEqual({ reason: "마지막 줄이 JSON 아님" });
		expect(parseQaVerdict('{"verdict":"OK"}')).toEqual({ reason: "verdict가 PASS·FAIL 아님" });
		expect(parseQaVerdict('{"verdict":"PASS","findings":"x"}')).toEqual({ reason: "findings가 배열 아님" });
		expect(parseQaVerdict("")).toEqual({ reason: "마지막 줄 없음" });
		const many = parseQaVerdict(
			JSON.stringify({ verdict: "FAIL", findings: Array.from({ length: 12 }, (_, i) => `${i}${"x".repeat(300)}`) }),
		);
		expect("findings" in many && many.findings).toHaveLength(10);
		expect("findings" in many && many.findings[0]).toHaveLength(200);
		const token = ["xoxb", "TEST", "0"].join("-");
		expect(parseQaVerdict(JSON.stringify({ verdict: "FAIL", findings: [`leak ${token}`] }))).toEqual({
			verdict: "FAIL",
			findings: [redact(`leak ${token}`)],
		});
	});

	test("AC-3: a receipt of the previous claim commit holds the lane as 실행 QA 없음", async () => {
		const repo = makeRepo(repos);
		const fake = fakeRunner((call) => (isQa(call) ? pass() : { code: 0, stdout: CLEAR, timedOut: false }));
		const policy = qaPolicy(repo);
		const h = qaHarness(fake.run, policy, countingLand().land);
		const { lane, sha } = await closeLane(h, repo, false, "L3");
		h.close();
		const next = "e".repeat(40);
		const reclaimed: LaneRow = {
			...lane,
			meta: {
				...lane.meta,
				sha: next,
				checks: { head: next, results: lane.meta.checks?.results ?? [] },
				review: { sha: next, verdict: "CLEAR", model: MODEL, at: 0, notes: "", confidence: 0.9 },
				qa: { sha, verdict: "PASS", findings: [], model: QA_MODEL, at: 0 },
			},
		};
		expect(laneLandBlockers(reclaimed, policy, true, false)).toEqual([QA_MISSING]);
	});
});

describe("reviewLane: the prompt and the diff file (AC-8)", () => {
	const SHA = "c".repeat(40);
	const lane = (over: Partial<LaneRow["meta"]> = {}): LaneRow => ({
		name: "review",
		title: "리뷰 제목",
		threadRef: `${CHANNEL}:900000000000000001`,
		originKey: "ompbot/work/review",
		cwd: "/wt",
		sessionDir: "/s",
		status: "closed",
		history: [],
		createdAt: 0,
		updatedAt: 0,
		meta: {
			startedAt: 0,
			lastProgressAt: 0,
			steerSeq: 0,
			sha: SHA,
			baseSha: "b".repeat(40),
			laneId: "L-20270115-01",
			repo: "/repo",
			worktree: "/wt",
			baseBranch: "main",
			brief: "브리프 본문",
			acceptance: [{ id: "AC-1", text: "수락기준 하나" }],
			checks: { head: SHA, results: [{ id: "AC-1", signal: "s", ok: true, detail: "통과 상세" }] },
			claim: { repo: "/wt", commit: SHA, summary: "구현자 요약", claimedAt: 0 },
			...over,
		},
	});

	function fakeGit(diff: string): { git: GitRunner; calls: string[][] } {
		const calls: string[][] = [];
		return {
			calls,
			git: async (args) => {
				calls.push(args);
				if (args.includes("merge-base")) return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
				if (args.includes("--stat")) return { code: 0, stdout: " a.ts | 1 +\n", stderr: "" };
				return { code: 0, stdout: diff, stderr: "" };
			},
		};
	}

	const deps = (git: GitRunner, run: ProcessRunner) => ({
		ompBin: "/bin/omp-fake",
		systemPromptAppendix: "FLOORS",
		reviewsDir: reviewsDir(),
		headOf: async () => ({ sha: SHA, clean: true }),
		now: () => 1,
		git,
		run,
	});

	test("omp-isolation AC-2: the reviewer runs in the bot's ompProfile, without the inherited agent dir", async () => {
		const fake = says("VERDICT: CLEAR");
		await reviewLane(
			{ lane: lane(), model: MODEL, timeoutMs: 1000 },
			{
				...deps(fakeGit("+x\n").git, fake.run),
				ompProfile: "ompbot",
				inheritedEnv: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/custom/agent" },
			},
		);
		expect(fake.calls[0]?.opts.env?.OMP_PROFILE).toBe("ompbot");
		expect(fake.calls[0]?.opts.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
	});

	test("the four sections come in order: spec → diff → checks → the lane's report", async () => {
		const fake = says("VERDICT: CLEAR");
		const receipt = await reviewLane(
			{ lane: lane(), model: MODEL, timeoutMs: 1000 },
			deps(fakeGit("+marker-line\n").git, fake.run),
		);
		expect(receipt.verdict).toBe("CLEAR");
		const prompt = fake.calls[0]?.cmd.at(-1) ?? "";
		const at = [
			prompt.indexOf(REVIEW_SECTIONS.spec),
			prompt.indexOf("브리프 본문"),
			prompt.indexOf("수락기준 하나"),
			prompt.indexOf(REVIEW_SECTIONS.diff),
			prompt.indexOf("+marker-line"),
			prompt.indexOf(REVIEW_SECTIONS.checks),
			prompt.indexOf("통과 상세"),
			prompt.indexOf(REVIEW_SECTIONS.claim),
			prompt.indexOf("구현자 요약"),
		];
		expect(at.every((index) => index >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		// A short diff is whole in the prompt: no pointer to the file.
		expect(prompt).not.toContain(reviewsDir());
	});

	test("a diff over 60000 characters is cut, the prompt names the diff file, and the file is 0600 in a 0700 directory", async () => {
		const path = join(reviewsDir(), `L-20270115-01-${SHA.slice(0, 12)}.diff`);
		let modes: { file: number; dir: number; text: string } | undefined;
		const fake = fakeRunner(() => {
			modes = {
				file: statSync(path).mode & 0o777,
				dir: statSync(reviewsDir()).mode & 0o777,
				text: readFileSync(path, "utf8"),
			};
			return { code: 0, stdout: "VERDICT: CLEAR", timedOut: false };
		});
		const big = `${"+x\n".repeat(30_000)}+tail-marker\n`;
		await reviewLane({ lane: lane(), model: MODEL, timeoutMs: 1000 }, deps(fakeGit(big).git, fake.run));
		const prompt = fake.calls[0]?.cmd.at(-1) ?? "";
		expect(prompt).toContain(path);
		expect(prompt).not.toContain("tail-marker");
		expect(prompt.length).toBeLessThan(big.length);
		expect(modes).toEqual({ file: 0o600, dir: 0o700, text: expect.stringContaining("tail-marker") });
		expect(existsSync(path)).toBe(false);
		// The prompt's diff block holds at most REVIEW_DIFF_PROMPT_MAX characters.
		const block = buildReviewPrompt({ lane: lane(), diff: big, diffPath: path });
		const diffPart = block.slice(block.indexOf("```diff\n") + 8, block.indexOf("\n```", block.indexOf("```diff\n")));
		expect(diffPart.length).toBeLessThanOrEqual(REVIEW_DIFF_PROMPT_MAX);
	});

	test("lane-review-isolation AC-3: the overlay is 0600 at the call, disables discovery and persistent state; one run", async () => {
		const seen: IsolationSeen[] = [];
		const fake = fakeRunner((call) => {
			seen.push(seeIsolation(call));
			return { code: 0, stdout: "VERDICT: CLEAR", timedOut: false };
		});
		await reviewLane({ lane: lane(), model: MODEL, timeoutMs: 1000 }, deps(fakeGit("+x\n").git, fake.run));
		expect(fake.calls).toHaveLength(1);
		const path = join(reviewsDir(), `L-20270115-01-${SHA.slice(0, 12)}.omp.yml`);
		expect(seen[0]?.configPath).toBe(path);
		expect(seen[0]?.configMode).toBe(0o600);
		expect(seen[0]?.config).toMatchObject({
			disabledProviders: [...REVIEW_DISABLED_DISCOVERY],
			mcp: { enableProjectConfig: false },
			autolearn: { enabled: false },
			memory: { backend: "off" },
			// review confidence AC-4: the reviewer answers with its --model only.
			retry: { modelFallback: false },
		});
		expect(seen[0]?.config).toHaveProperty("disabledProviders", [...REVIEW_DISABLED_DISCOVERY]);
	});

	test("lane-review-isolation AC-5: the prompt names the worktree's absolute path and tells grep·glob to pass it as path", async () => {
		const fake = says("VERDICT: CLEAR");
		await reviewLane(
			{ lane: lane({ worktree: "/abs/work/tree-1" }), model: MODEL, timeoutMs: 1000 },
			deps(fakeGit("+x\n").git, fake.run),
		);
		const prompt = fake.calls[0]?.cmd.at(-1) ?? "";
		expect(prompt).toContain("/abs/work/tree-1의 파일을 read·grep·glob으로 확인");
		expect(prompt).toContain("grep·glob을 부를 때는 path에 반드시 위 worktree 절대경로(/abs/work/tree-1)를 넘겨라");
		const at = Object.values(REVIEW_SECTIONS).map((section) => prompt.indexOf(section));
		expect(at.every((index) => index >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
	});

	test.each([
		["CLEAR", () => ({ code: 0, stdout: "VERDICT: CLEAR", timedOut: false }), "CLEAR"],
		["BLOCK", () => ({ code: 0, stdout: "VERDICT: BLOCK", timedOut: false }), "BLOCK"],
		["timeout", () => ({ code: null, stdout: "절반", timedOut: true }), "inconclusive"],
		["abort", "abort", "inconclusive"],
		["a runner that throws", "throw", "inconclusive"],
	] as const)("lane-review-isolation AC-6: after %s the overlay and the cwd are gone", async (_name, end, verdict) => {
		const abort = new AbortController();
		const isolation = reviewIsolationPaths(reviewsDir(), lane(), SHA);
		const fake = fakeRunner((call) => {
			expect(existsSync(isolation.configPath)).toBe(true);
			expect(call.opts.cwd).toBe(isolation.cwd);
			// Something the reviewer left in its cwd is removed with it.
			writeFileSync(join(isolation.cwd, "left.txt"), "x");
			if (end === "throw") throw new Error("spawn boom");
			if (end === "abort") {
				abort.abort();
				return { code: null, stdout: "", timedOut: false };
			}
			return end();
		});
		const receipt = await reviewLane(
			{ lane: lane(), model: MODEL, timeoutMs: 1000, signal: abort.signal },
			deps(fakeGit("+x\n").git, fake.run),
		);
		expect(fake.calls).toHaveLength(1);
		expect(receipt.verdict).toBe(verdict);
		expect(existsSync(isolation.configPath)).toBe(false);
		expect(existsSync(isolation.cwd)).toBe(false);
		expect(readdirSync(reviewsDir())).toEqual([]);
	});

	test("no merge-base and a worktree off the claim are inconclusive without running the reviewer", async () => {
		const fake = says("VERDICT: CLEAR");
		const noBase: GitRunner = async () => ({ code: 1, stdout: "", stderr: "fatal" });
		const lost = await reviewLane({ lane: lane(), model: MODEL, timeoutMs: 1000 }, deps(noBase, fake.run));
		expect(lost).toMatchObject({ verdict: "inconclusive", reason: "diff 기준점 없음", sha: SHA });
		const moved = await reviewLane(
			{ lane: lane(), model: MODEL, timeoutMs: 1000 },
			{ ...deps(fakeGit("").git, fake.run), headOf: async () => ({ sha: "d".repeat(40), clean: true }) },
		);
		expect(moved.verdict).toBe("inconclusive");
		expect(fake.calls).toHaveLength(0);
	});
});

describe("review confidence (doc/plans/lane-review-confidence.md)", () => {
	test.each([
		["present", "지적 하나\nCONFIDENCE: 0.92\nVERDICT: CLEAR", "CLEAR", 0.92, "지적 하나"],
		["present after a blank line", "지적\nCONFIDENCE: 0.9 \n\nVERDICT: BLOCK\n", "BLOCK", 0.9, "지적"],
		["1", "CONFIDENCE: 1\nVERDICT: CLEAR", "CLEAR", 1, ""],
		["1.00", "CONFIDENCE:1.00\nVERDICT: CLEAR", "CLEAR", 1, ""],
		["0", "CONFIDENCE: 0\nVERDICT: BLOCK", "BLOCK", 0, ""],
		["absent", "지적 하나\nVERDICT: BLOCK", "BLOCK", undefined, "지적 하나"],
		["a percentage", "지적\nCONFIDENCE: 92%\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["above 1", "지적\nCONFIDENCE: 1.5\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["no leading digit", "지적\nCONFIDENCE: .9\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["a word", "지적\nCONFIDENCE: high\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["two lines", "CONFIDENCE: 0.5\n지적\nCONFIDENCE: 0.9\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["not right above VERDICT", "CONFIDENCE: 0.9\n지적\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
	] as const)("AC-3: CONFIDENCE %s", (_name, output, verdict, confidence, notes) => {
		const parsed = parseReviewVerdict(output);
		expect(parsed).toEqual({ verdict, notes, ...(confidence === undefined ? {} : { confidence }) });
	});

	test("AC-3: a malformed CONFIDENCE never makes the verdict inconclusive, and VERDICT rules stay", () => {
		expect(parseReviewVerdict("CONFIDENCE: 0.9\nVERDICT: CLEAR\nCONFIDENCE: 0.9")).toEqual({ reason: "VERDICT 없음" });
		expect(parseReviewVerdict("CONFIDENCE: x\nCONFIDENCE: y\nVERDICT: BLOCK")).toEqual({ verdict: "BLOCK", notes: "" });
	});

	test("AC-3: the prompt asks for the CONFIDENCE line; the receipt keeps its value and notes drop the line", async () => {
		const repo = makeRepo(repos);
		const fake = says("지적 없음\nCONFIDENCE: 0.8\nVERDICT: BLOCK");
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW });
		const { lane, sha } = await closeLane(h, repo);
		expect(fake.calls[0]?.cmd.at(-1)).toContain("마지막 줄 바로 위에는 `CONFIDENCE: <0.00~1.00>` 한 줄을 쓴다.");
		const after = requireLane(h, lane.name);
		expect(after.meta.review).toMatchObject({ sha, verdict: "BLOCK", confidence: 0.8, notes: "지적 없음" });
		expect(after.history.some((entry) => entry.event === "review" && entry.detail === `BLOCK 0.80 · ${MODEL}`)).toBe(
			true,
		);
		h.close();
	});

	test("AC-4: only the reviewer's overlay turns the model fallback off; the guest/qa overlay keeps it", () => {
		expect(Bun.YAML.parse(REVIEW_OVERLAY_YAML)).toMatchObject({ retry: { modelFallback: false } });
		expect(REVIEW_OVERLAY_YAML).toContain("modelFallback: false");
		expect(GUEST_OVERLAY_YAML).not.toContain("modelFallback");
		expect(Bun.YAML.parse(GUEST_OVERLAY_YAML)).not.toHaveProperty("retry");
		expect(REVIEW_OVERLAY_YAML.startsWith(GUEST_OVERLAY_YAML)).toBe(true);
	});
});

describe("through the daemon: #autoLandPolicy hands taskAutoLand.review to the lanes (AC-12)", () => {
	test("the configured model and the default timeout reach the reviewer", async () => {
		const repo = makeRepo(repos);
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		const called = Promise.withResolvers<ReviewCall>();
		const fake = fakeRunner((call) => {
			called.resolve(call);
			return { code: 0, stdout: "VERDICT: CLEAR", timedOut: false };
		});
		const sessions = new FakeSessionStore();
		const clock = { now: () => Date.now() };
		const daemon = new Daemon({
			config: {
				...laneConfig(),
				taskAutoLand: { repos: [repo], review: { model: "daemon/model" } },
			},
			channels: [discordBinding(transport)],
			log: createLogger({ sink: () => {}, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			landLane: async () => ({ state: "landed", preSha: "unknown" }),
			laneReviewRun: fake.run,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		daemons.push(daemon);
		await daemon.start();
		const signal = new AbortController().signal;
		const start = daemon.hostToolsFor(`discord/dm/${OWNER_DM}`).find((tool) => tool.name === "ompbot_work_start");
		await start?.execute(
			{ title: "daemon-review", cwd: repo, brief: "데몬 브리프", acceptance: [CHECK_A], risk: "L2" },
			{ signal },
		);
		const lane = daemon.store.getLane("daemon-review");
		if (lane === undefined) throw new Error("no lane");
		expect(lane.meta.brief).toBe("데몬 브리프");
		commitIn(lane.cwd, "a.txt");
		const claim = daemon.hostToolsFor(lane.originKey).find((tool) => tool.name === "ompbot_claim_done");
		expect(await claim?.execute({ repo: lane.cwd, commit: "HEAD", summary: "a.txt 추가" }, { signal })).toContain(
			"검증 통과",
		);
		const call = await called.promise;
		expect(argOf(call.cmd, "--model")).toBe("daemon/model");
		expect(call.opts.timeoutMs).toBe(600_000);
		expect(call.cmd.at(-1)).toContain("데몬 브리프");
		// The CLEAR receipt makes the card the auto-merge one (the landing itself is lane-land's subject).
		await transport.waitForPosts((text) => text.includes("독립 리뷰 CLEAR"));
		expect(transport.posts((text) => text.includes("자동 머지 ·"))).toHaveLength(1);
		expect(daemon.store.getLane("daemon-review")?.meta.review).toMatchObject({
			verdict: "CLEAR",
			model: "daemon/model",
		});
	});

	test("review confidence AC-7: review.confident reaches the lanes — explicit L3 is reviewed and auto-merged on CLEAR 0.90; no risk and L4 ask unreviewed", async () => {
		const repo = makeRepo(repos);
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		const fake = fakeRunner(() => ({ code: 0, stdout: "확인함\nCONFIDENCE: 0.90\nVERDICT: CLEAR", timedOut: false }));
		const sessions = new FakeSessionStore();
		const clock = { now: () => Date.now() };
		const landed: string[] = [];
		const daemon = new Daemon({
			config: {
				...laneConfig(),
				taskAutoLand: {
					repos: [repo],
					review: { model: "daemon/model", confident: { maxRisk: "L3", minConfidence: 0.85 } },
				},
			},
			channels: [discordBinding(transport)],
			log: createLogger({ sink: () => {}, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			landLane: async (request) => {
				landed.push(request.branch);
				return { state: "landed", preSha: "unknown" };
			},
			laneReviewRun: fake.run,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		daemons.push(daemon);
		await daemon.start();
		const signal = new AbortController().signal;
		const start = daemon.hostToolsFor(`discord/dm/${OWNER_DM}`).find((tool) => tool.name === "ompbot_work_start");
		const closeWith = async (title: string, risk: string | undefined): Promise<LaneRow> => {
			await start?.execute(
				{ title, cwd: repo, brief: `${title} 브리프`, acceptance: [CHECK_A], ...(risk === undefined ? {} : { risk }) },
				{ signal },
			);
			const lane = daemon.store.getLane(title);
			if (lane === undefined) throw new Error(`no lane ${title}`);
			commitIn(lane.cwd, "a.txt");
			const claim = daemon.hostToolsFor(lane.originKey).find((tool) => tool.name === "ompbot_claim_done");
			expect(await claim?.execute({ repo: lane.cwd, commit: "HEAD", summary: "a.txt 추가" }, { signal })).toContain(
				"검증 통과",
			);
			return lane;
		};

		const unrated = await closeWith("confident-none", undefined);
		expect(unrated.meta.risk).toBeUndefined();
		await transport.waitForPosts((text) => text.includes("머지 대기 · confident-none"));
		const l4 = await closeWith("confident-l4", "L4");
		await transport.waitForPosts((text) => text.includes("머지 대기 · confident-l4"));
		expect(fake.calls).toHaveLength(0);
		for (const [title, risk] of [
			["confident-none", "L3"],
			["confident-l4", "L4"],
		] as const) {
			const [card] = transport.posts((text) => text.includes(`머지 대기 · ${title}`));
			expect(card?.content).toContain(`자동 머지 안 함: 위험 ${risk} > L2`);
			expect(card?.content).not.toContain("독립 리뷰");
			expect(daemon.store.getLane(title)?.meta.review).toBeUndefined();
		}
		expect(l4.meta.risk).toBe("L4");

		await closeWith("confident-l3", "L3");
		await transport.waitForPosts((text) => text.includes("자동 머지 · confident-l3"));
		expect(fake.calls).toHaveLength(1);
		expect(argOf(fake.calls[0]?.cmd ?? [], "--model")).toBe("daemon/model");
		expect(fake.calls[0]?.cmd.at(-1)).toContain("confident-l3 브리프");
		const [auto] = transport.posts((text) => text.includes("자동 머지 · confident-l3"));
		expect(auto?.content).toContain("🔎 독립 리뷰 CLEAR 0.90 · daemon/model");
		expect(daemon.store.getLane("confident-l3")?.meta.review).toMatchObject({ verdict: "CLEAR", confidence: 0.9 });
		expect(transport.posts((text) => text.includes("머지 대기 · confident-l3"))).toHaveLength(0);
		expect(fake.calls).toHaveLength(1);
	});
});
