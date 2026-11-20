import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordChannelConfig, OmpbotConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { buildLaneOutcomeCard, laneHoldActionId, lanePublishActionId, parseLaneActionId } from "../src/lanes/card";
import { EXTERNAL_PR_LANE, laneLandBlockers } from "../src/lanes/land";
import type { LaneManagerDeps } from "../src/lanes/manager";
import { defaultPrTools, type ProcResult, type ProcRunner } from "../src/lanes/pr";
import type { LaneMeta, LaneRow } from "../src/lanes/status";
import { parsePrCommand } from "../src/lanes/trigger";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { ApprovalResult } from "../src/safety/approval";
import {
	CHANNEL,
	discordBinding,
	GUILD,
	makeHome,
	OWNER,
	OWNER_DM,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// External PR lanes (doc/plans/lane-external-pr.md): every push goes to a local bare repository and gh is a fake;
// nothing reaches GitHub.

const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';
const UPSTREAM = "up/proj";
const LOGIN = "me";

let home: TestHome;
let repos: string[];
let scratch: string[];

beforeEach(() => {
	home = makeHome("ompbot-lane-xpr-home-");
	repos = [];
	scratch = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratch.push(dir);
	return dir;
}

const headOf = (dir: string, ref = "HEAD"): string => git(dir, "rev-parse", ref);
const refOf = (bare: string, ref: string): string | undefined => {
	const run = Bun.spawnSync(["git", "-C", bare, "rev-parse", "--verify", "-q", ref], { stdout: "pipe" });
	return run.exitCode === 0 ? run.stdout.toString().trim() : undefined;
};

function commitIn(dir: string, ...files: string[]): string {
	for (const file of files) writeFileSync(join(dir, file), `${file}\n`);
	git(dir, "add", "--", ...files);
	git(dir, "commit", "-q", "-m", `add ${files.join(" ")}`);
	return headOf(dir);
}

/** A repository with a local bare repository as its `fork` remote (the push target of every test). */
function repoWithFork(): { repo: string; fork: string; base: string } {
	const repo = makeRepo(repos);
	const fork = tempDir("ompbot-lane-xpr-fork-");
	git(fork, "init", "-q", "--bare");
	git(repo, "remote", "add", "fork", fork);
	return { repo, fork, base: git(repo, "symbolic-ref", "--short", "HEAD") };
}

/** One open PR as `gh pr list/view --json` prints it. */
const prJson = (number: number, branch: string, oid: string, owner = LOGIN, base = "") => ({
	number,
	url: `https://github.com/${UPSTREAM}/pull/${number}`,
	state: "OPEN",
	headRefName: branch,
	headRefOid: oid,
	headRepositoryOwner: { login: owner },
	baseRefName: base,
});

interface GhState {
	mine?: object[];
	byHead?: object[];
	view?: Record<number, object>;
}

interface FakeGh {
	run: ProcRunner;
	calls: string[][];
	/** What the fake answers; a test sets it after the lane closed. */
	state: GhState;
	creates(): string[][];
}

interface GitRecorder {
	run: ProcRunner;
	calls: string[][];
	pushes(): string[][];
}

/** A fake gh: `api user`, `pr list` (`--author` → mine, `--head` → byHead), `pr view`, `pr create`. */
function fakeGh(): FakeGh {
	const state: GhState = {};
	const calls: string[][] = [];
	const ok = (stdout: string): ProcResult => ({ code: 0, stdout, stderr: "" });
	const run: ProcRunner = async (argv) => {
		calls.push(argv);
		if (argv[0] === "api") return ok(`${LOGIN}\n`);
		if (argv[0] === "pr" && argv[1] === "list") {
			return ok(JSON.stringify(argv.includes("--author") ? (state.mine ?? []) : (state.byHead ?? [])));
		}
		if (argv[0] === "pr" && argv[1] === "view") {
			const pr = state.view?.[Number(argv[2])];
			return pr === undefined ? { code: 1, stdout: "", stderr: "no pull requests found" } : ok(JSON.stringify(pr));
		}
		if (argv[0] === "pr" && argv[1] === "create") return ok(`https://github.com/${UPSTREAM}/pull/77\n`);
		return { code: 1, stdout: "", stderr: `unexpected gh ${argv.join(" ")}` };
	};
	return { run, calls, state, creates: () => calls.filter((argv) => argv[0] === "pr" && argv[1] === "create") };
}

/** The real git with every argv recorded. */
function recordingGit(): GitRecorder {
	const calls: string[][] = [];
	const run: ProcRunner = (argv, options) => {
		calls.push(argv);
		return defaultPrTools.git(argv, options);
	};
	return { run, calls, pushes: () => calls.filter((argv) => argv[0] === "push") };
}

type Approve = NonNullable<LaneManagerDeps["requestApproval"]>;
type ApprovalRequest = Parameters<Approve>[0];

/** An approval seam answering `answer` (a value, or a function of the request); `asked` resolves at the first ask. */
function approvals(answer: ApprovalResult | ((request: ApprovalRequest) => Promise<ApprovalResult>)) {
	const asked: ApprovalRequest[] = [];
	const first = Promise.withResolvers<ApprovalRequest>();
	const fn: Approve = async (request) => {
		asked.push(request);
		first.resolve(request);
		return typeof answer === "function" ? answer(request) : answer;
	};
	return { fn, asked, first: first.promise };
}

interface Setup {
	h: LaneHarness;
	repo: string;
	fork: string;
	base: string;
	lane: LaneRow;
	sha: string;
	gh: FakeGh;
	gitRec: GitRecorder;
}

/** A closed external PR lane (pushRemote `fork`), its claim commit holding a.txt and (unless `noBody`) pr-body.md. */
async function closedExternal(
	approve: Approve,
	options: { noBody?: boolean; pushRemote?: string; prep?: (repo: string) => void } = {},
): Promise<Setup> {
	const { repo, fork, base } = repoWithFork();
	options.prep?.(repo);
	const gh = fakeGh();
	const gitRec = recordingGit();
	const h = laneHarness(home.dir, { requestApproval: approve, prTools: { git: gitRec.run, gh: gh.run } });
	const started = await h.manager.start({
		title: "ext",
		cwd: repo,
		channel: CHANNEL,
		acceptance: [CHECK_A],
		risk: "L2",
		externalPr: { repo: UPSTREAM, pushRemote: options.pushRemote ?? "fork" },
	});
	await h.settle();
	const sha = commitIn(started.cwd, ...(options.noBody === true ? ["a.txt"] : ["a.txt", "pr-body.md"]));
	expect(
		await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "a.txt 추가" }),
	).toContain("검증 통과");
	await h.settle();
	const lane = h.store.getLane(started.name);
	if (lane === undefined) throw new Error("no lane");
	return { h, repo, fork, base, lane, sha, gh, gitRec };
}

const prOf = (s: Setup) => s.h.store.getLane(s.lane.name)?.meta.pr;

async function publish(s: Setup): Promise<void> {
	const outcome = await s.h.manager.requestPublish(s.lane.name);
	expect(outcome).toMatchObject({ handled: true });
	await s.h.settle();
}

// ---------------------------------------------------------------- cards (수락기준 카드 ①~④)

function laneRow(meta: Partial<LaneMeta>): LaneRow {
	return {
		name: "ext",
		title: "외부",
		threadRef: `${CHANNEL}:1`,
		originKey: "ompbot/work/ext",
		cwd: "/tmp/ext",
		sessionDir: "/tmp/ext-s",
		status: "closed",
		history: [],
		createdAt: 0,
		updatedAt: 0,
		meta: {
			startedAt: 0,
			lastProgressAt: 0,
			steerSeq: 0,
			branch: "lane/L-20270115-01",
			baseBranch: "main",
			sha: "a".repeat(40),
			land: { state: "pending", attempts: 0 },
			...meta,
		},
	};
}

const EXTERNAL = { repo: UPSTREAM, base: "main", bodyFile: "pr-body.md", title: "외부", branch: "pr/L-20270115-01" };
const labels = (meta: Partial<LaneMeta>, kind: "ask" | "result" = "ask") =>
	(buildLaneOutcomeCard(laneRow(meta), { kind }).buttons ?? []).map((button) => button.label);

describe("Outcome card buttons", () => {
	test("① an external PR lane's ask card offers PR 게시·보류·폐기 and no 머지", () => {
		const card = buildLaneOutcomeCard(laneRow({ externalPr: EXTERNAL }), { kind: "ask" });
		expect(card.title).toBe("📤 PR 게시 대기 · 외부");
		expect((card.buttons ?? []).map((button) => button.label)).toEqual(["PR 게시", "보류", "폐기"]);
		expect(card.text).toContain(`→ \`${UPSTREAM}:main\` PR, 본문 \`pr-body.md\``);
		expect(card.note).toContain("gh pr create");
		// The blocked card of the same lane chooses the same way.
		expect(labels({ externalPr: EXTERNAL, land: { state: "blocked", attempts: 2, reason: "x" } }, "result")).toEqual([
			"PR 게시",
			"보류",
			"폐기",
		]);
		// Held: no second 보류; published (for this commit): only 폐기; a PR from before `!reopen`: PR 갱신.
		expect(labels({ externalPr: EXTERNAL, pr: { state: "held" } })).toEqual(["PR 게시", "폐기"]);
		expect(labels({ externalPr: EXTERNAL, pr: { state: "published", url: "u", sha: "a".repeat(40) } })).toEqual([
			"폐기",
		]);
		expect(labels({ externalPr: EXTERNAL, pr: { state: "published", url: "u", sha: "b".repeat(40) } })).toEqual([
			"PR 갱신",
			"보류",
			"폐기",
		]);
		expect(labels({ externalPr: EXTERNAL, pr: { state: "asking" } })).toEqual([]);
	});

	test("② a lane with one blocking leftover offers only 폐기, names the item and the !reopen way", () => {
		const meta = { leftovers: [{ text: "오너 승인 뒤 push·PR 게시", blocking: true }] };
		const card = buildLaneOutcomeCard(laneRow(meta), { kind: "ask" });
		expect(card.title).toBe("🔍 남은 일 대기 · 외부");
		expect((card.buttons ?? []).map((button) => button.label)).toEqual(["폐기"]);
		expect(card.text).toContain("오너 승인 뒤 push·PR 게시");
		expect(card.text).toContain("!reopen <지시>");
		expect(card.text).toContain('"머지해"');
		expect(labels(meta, "result").filter((label) => label === "머지")).toEqual([]);
	});

	test("③ an ordinary lane keeps 머지·폐기", () => {
		const card = buildLaneOutcomeCard(laneRow({ leftovers: [{ text: "문서", blocking: false }] }), { kind: "ask" });
		expect(card.title).toBe("🔍 머지 대기 · 외부");
		expect((card.buttons ?? []).map((button) => button.label)).toEqual(["머지", "폐기"]);
	});

	test("④ parseLaneActionId reads publish and hold ids and refuses a bad name", () => {
		expect(parseLaneActionId(lanePublishActionId("cataly-pr-오너-프로필"))).toEqual({
			kind: "publish",
			name: "cataly-pr-오너-프로필",
		});
		expect(parseLaneActionId(laneHoldActionId("ext-2"))).toEqual({ kind: "hold", name: "ext-2" });
		expect(parseLaneActionId("ompbot:lane:publish:Bad Name")).toBeUndefined();
		expect(parseLaneActionId("ompbot:lane:hold:")).toBeUndefined();
	});

	test("`!pr` forms", () => {
		expect(parsePrCommand("!pr")).toEqual({});
		expect(parsePrCommand("!pr up/proj")).toEqual({ repo: "up/proj" });
		expect(parsePrCommand("!pr https://github.com/up/proj/pull/12")).toEqual({ repo: "up/proj", prNumber: 12 });
		expect(parsePrCommand("!pr up/proj#3")).toEqual({ repo: "up/proj", prNumber: 3 });
		expect(parsePrCommand("!pr #4")).toEqual({ prNumber: 4 });
		expect(parsePrCommand("!pr 5")).toEqual({ prNumber: 5 });
		expect(parsePrCommand("!pr 아무거나")).toHaveProperty("problem");
		expect(parsePrCommand("!pr up/proj 더")).toBeUndefined();
		expect(parsePrCommand("!pricing")).toBeUndefined();
	});
});

// ---------------------------------------------------------------- manager (수락기준 매니저 ①~⑭)

describe("LaneManager external PR publish", () => {
	test("① approved: the lane commit lands on <branch> of the fork, gh pr create gets the arguments, published with url", async () => {
		const ap = approvals("approved");
		const s = await closedExternal(ap.fn);
		expect(s.lane.meta.externalPr).toMatchObject({ repo: UPSTREAM, base: s.base, bodyFile: "pr-body.md" });
		const branch = s.lane.meta.externalPr?.branch ?? "";
		expect(branch).toMatch(/^pr\/L-\d{8}-\d{2}$/);
		await publish(s);
		expect(refOf(s.fork, `refs/heads/${branch}`)).toBe(s.sha);
		expect(s.gh.creates()).toEqual([
			[
				"pr",
				"create",
				"--repo",
				UPSTREAM,
				"--base",
				s.base,
				"--head",
				`${LOGIN}:${branch}`,
				"--title",
				"ext",
				"--body-file",
				join(s.lane.meta.worktree ?? "", "pr-body.md"),
			],
		]);
		expect(prOf(s)).toMatchObject({ state: "published", url: `https://github.com/${UPSTREAM}/pull/77`, sha: s.sha });
		expect(ap.asked).toHaveLength(1);
		expect(ap.asked[0]?.origin).toMatchObject({ originKey: s.lane.originKey });
		expect(ap.asked[0]?.summary).toContain("새 PR");
		expect(ap.asked[0]?.detail.external).toContain(`github.com/${UPSTREAM}`);
		const lane = s.h.store.getLane(s.lane.name);
		expect(lane?.history.map((entry) => entry.event)).toContain("pr_published");
		expect(lane?.meta.renderedRoot).toBe("📤 ext");
		expect(lane?.meta.renderedStatus).toBe("📤 ext · PR 게시됨");
		s.h.close();
	});

	for (const [answer, reason] of [
		["denied", "승인 거부"],
		["timeout", "승인 시간 초과"],
	] as const) {
		test(`② approval ${answer}: nothing pushed, held (${reason})`, async () => {
			const s = await closedExternal(approvals(answer).fn);
			await publish(s);
			expect(s.gitRec.pushes()).toEqual([]);
			expect(prOf(s)).toMatchObject({ state: "held", reason });
			expect(s.gh.creates()).toEqual([]);
			s.h.close();
		});
	}

	test("③ an open PR of the login's branch is updated, not created again", async () => {
		const s = await closedExternal(approvals("approved").fn);
		const branch = s.lane.meta.externalPr?.branch ?? "";
		// Its head cannot be fetched (unknown): the fast-forward-only push decides.
		s.gh.state.byHead = [prJson(3, branch, "0".repeat(40), LOGIN, s.base)];
		await publish(s);
		expect(s.gh.creates()).toEqual([]);
		expect(refOf(s.fork, `refs/heads/${branch}`)).toBe(s.sha);
		expect(prOf(s)).toMatchObject({ state: "published", url: `https://github.com/${UPSTREAM}/pull/3` });
		s.h.close();
	});

	test("④ no body file: refused before any approval card", async () => {
		const ap = approvals("approved");
		const s = await closedExternal(ap.fn, { noBody: true });
		const outcome = await s.h.manager.requestPublish(s.lane.name);
		expect(outcome.handled).toBe(false);
		expect(outcome.text).toContain("본문 파일 없음");
		expect(ap.asked).toEqual([]);
		expect(prOf(s)).toBeUndefined();
		s.h.close();
	});

	test("④ a non-fast-forward push is refused: failed, and no force argument ever", async () => {
		const s = await closedExternal(approvals("approved").fn);
		const branch = s.lane.meta.externalPr?.branch ?? "";
		// Somebody else's commit already sits on that branch of the fork.
		const other = tempDir("ompbot-lane-xpr-other-");
		git(other, "init", "-q");
		writeFileSync(join(other, "z.txt"), "z\n");
		git(other, "add", "z.txt");
		git(other, "commit", "-q", "-m", "z");
		git(other, "push", "-q", s.fork, `HEAD:refs/heads/${branch}`);
		const before = refOf(s.fork, `refs/heads/${branch}`);
		await publish(s);
		expect(prOf(s)).toMatchObject({ state: "failed" });
		expect(prOf(s)?.reason).toContain("push 거절");
		expect(refOf(s.fork, `refs/heads/${branch}`)).toBe(before);
		const pushArgs = s.gitRec.pushes().flat();
		expect(pushArgs.length).toBeGreaterThan(0);
		expect(pushArgs.some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("+"))).toBe(false);
		expect(s.gh.creates()).toEqual([]);
		s.h.close();
	});

	test("④ a push remote that is the upstream itself: failed without a push or an approval", async () => {
		const ap = approvals("approved");
		const s = await closedExternal(ap.fn, {
			pushRemote: "upstream",
			prep: (repo) => git(repo, "remote", "add", "upstream", `https://github.com/${UPSTREAM}.git`),
		});
		await publish(s);
		expect(prOf(s)).toMatchObject({ state: "failed" });
		expect(prOf(s)?.reason).toContain("upstream에 직접 push하지 않음");
		expect(s.gitRec.pushes()).toEqual([]);
		expect(ap.asked).toEqual([]);
		s.h.close();
	});

	test("⑤ requestLand refuses an external PR lane (owner and auto); the base branch stays", async () => {
		const s = await closedExternal(approvals("approved").fn);
		const base = headOf(s.repo, s.base);
		for (const by of ["owner", "auto"] as const) {
			const outcome = await s.h.manager.requestLand(s.lane.name, by);
			expect(outcome.handled).toBe(false);
			expect(outcome.text).toContain("PR 게시");
		}
		await s.h.settle();
		expect(headOf(s.repo, s.base)).toBe(base);
		expect(s.h.store.getLane(s.lane.name)?.meta.land?.state).toBe("pending");
		const policy = { repos: [], maxRisk: "L4" } as unknown as Parameters<typeof laneLandBlockers>[1];
		expect(laneLandBlockers(s.lane, policy, true, false)).toContain(EXTERNAL_PR_LANE);
		s.h.close();
	});

	test("⑥ a second PR 게시 while the approval waits is refused; ⑨ the tick leaves a running asking alone", async () => {
		const answer = Promise.withResolvers<ApprovalResult>();
		const ap = approvals(() => answer.promise);
		const s = await closedExternal(ap.fn);
		expect((await s.h.manager.requestPublish(s.lane.name)).handled).toBe(true);
		await ap.first;
		expect(prOf(s)?.state).toBe("asking");
		const second = await s.h.manager.requestPublish(s.lane.name);
		expect(second.handled).toBe(false);
		await s.h.manager.tick();
		expect(prOf(s)?.state).toBe("asking");
		answer.resolve("denied");
		await s.h.settle();
		expect(ap.asked).toHaveLength(1);
		expect(prOf(s)).toMatchObject({ state: "held", reason: "승인 거부" });
		// ⑨ An `asking` no process runs (left by a forced stop) is held by the tick.
		s.h.store.patchLane(s.lane.name, undefined, { pr: { state: "asking" } });
		await s.h.manager.tick();
		expect(prOf(s)).toMatchObject({ state: "held", reason: "재시작으로 승인 대기 끊김" });
		s.h.close();
	});

	test("⑦ only another owner's PR of the same branch name is open: a new PR is created", async () => {
		const s = await closedExternal(approvals("approved").fn);
		const branch = s.lane.meta.externalPr?.branch ?? "";
		s.gh.state.byHead = [prJson(9, branch, "0".repeat(40), "someone-else", s.base)];
		await publish(s);
		expect(s.gh.creates()).toHaveLength(1);
		expect(prOf(s)).toMatchObject({ state: "published", url: `https://github.com/${UPSTREAM}/pull/77` });
		s.h.close();
	});

	test("⑧ stop() while the approval waits: held (재시작으로 끊김), nothing pushed", async () => {
		const ap = approvals((request) => {
			const { promise, resolve } = Promise.withResolvers<ApprovalResult>();
			request.signal.addEventListener("abort", () => resolve("denied"), { once: true });
			return promise;
		});
		const s = await closedExternal(ap.fn);
		await s.h.manager.requestPublish(s.lane.name);
		const asked = await ap.first;
		s.h.manager.stop();
		expect(asked.signal.aborted).toBe(true);
		expect(prOf(s)).toMatchObject({ state: "held", reason: "재시작으로 끊김" });
		await s.h.settle();
		expect(prOf(s)).toMatchObject({ state: "held", reason: "재시작으로 끊김" });
		expect(s.gitRec.pushes()).toEqual([]);
		expect(s.gh.creates()).toEqual([]);
		s.h.close();
	});

	test("⑩ a free-text reply is not an approval: held with the reply's start", async () => {
		const s = await closedExternal(approvals({ replied: "나중에 다시 보자" }).fn);
		await publish(s);
		expect(prOf(s)).toMatchObject({ state: "held", reason: "답장(승인 아님): 나중에 다시 보자" });
		expect(s.gitRec.pushes()).toEqual([]);
		s.h.close();
	});

	test("⑪ my open PR whose head is behind the lane commit: fast-forward push to its branch, no pr create", async () => {
		const s = await closedExternal(approvals("approved").fn);
		const baseSha = headOf(s.repo, s.base);
		git(s.repo, "push", "-q", "fork", `${baseSha}:refs/heads/feature-x`);
		s.gh.state.mine = [prJson(5, "feature-x", baseSha, LOGIN, s.base)];
		await publish(s);
		expect(refOf(s.fork, "refs/heads/feature-x")).toBe(s.sha);
		expect(s.gh.creates()).toEqual([]);
		const lane = s.h.store.getLane(s.lane.name);
		expect(lane?.meta.pr).toMatchObject({ state: "published", url: `https://github.com/${UPSTREAM}/pull/5` });
		expect(lane?.meta.externalPr).toMatchObject({ branch: "feature-x", prNumber: 5 });
		s.h.close();
	});

	test("⑫ the lane commit is in the PR head already: published without a push", async () => {
		const ap = approvals("approved");
		const s = await closedExternal(ap.fn);
		git(s.repo, "push", "-q", "fork", `${s.sha}:refs/heads/feature-y`);
		s.gh.state.mine = [prJson(6, "feature-y", s.sha, LOGIN, s.base)];
		await publish(s);
		expect(prOf(s)).toMatchObject({ state: "published", url: `https://github.com/${UPSTREAM}/pull/6` });
		expect(s.gitRec.pushes()).toEqual([]);
		expect(s.gh.creates()).toEqual([]);
		// Nothing goes out, so no approval card either.
		expect(ap.asked).toEqual([]);
		s.h.close();
	});

	test("⑬ a PR head that diverged from the lane commit: failed without a push", async () => {
		const s = await closedExternal(approvals("approved").fn);
		git(s.repo, "checkout", "-q", "-b", "side");
		const side = commitIn(s.repo, "side.txt");
		git(s.repo, "push", "-q", "fork", "side");
		git(s.repo, "checkout", "-q", s.base);
		s.gh.state.view = { 8: prJson(8, "side", side, LOGIN, s.base) };
		expect(await s.h.manager.attachExternalPr(s.lane.name, { prNumber: 8 })).toMatchObject({ handled: true });
		await publish(s);
		expect(prOf(s)).toMatchObject({ state: "failed" });
		expect(prOf(s)?.reason).toContain("갈라짐");
		expect(refOf(s.fork, "refs/heads/side")).toBe(side);
		expect(s.gitRec.pushes()).toEqual([]);
		s.h.close();
	});

	test("⑭ two candidate PRs: failed naming them; after `!pr <번호>` that PR is updated", async () => {
		const s = await closedExternal(approvals("approved").fn);
		const baseSha = headOf(s.repo, s.base);
		git(s.repo, "push", "-q", "fork", `${baseSha}:refs/heads/f1`, `${baseSha}:refs/heads/f2`);
		const second = prJson(6, "f2", baseSha, LOGIN, s.base);
		s.gh.state.mine = [prJson(5, "f1", baseSha, LOGIN, s.base), second];
		s.gh.state.view = { 6: second };
		await publish(s);
		expect(prOf(s)).toMatchObject({ state: "failed" });
		expect(prOf(s)?.reason).toContain("후보 2개");
		expect(s.gitRec.pushes()).toEqual([]);
		expect(await s.h.manager.attachExternalPr(s.lane.name, { prNumber: 6 })).toMatchObject({ handled: true });
		await publish(s);
		expect(prOf(s)).toMatchObject({ state: "published", url: `https://github.com/${UPSTREAM}/pull/6` });
		expect(refOf(s.fork, "refs/heads/f2")).toBe(s.sha);
		expect(refOf(s.fork, "refs/heads/f1")).toBe(baseSha);
		expect(s.gh.creates()).toEqual([]);
		s.h.close();
	});

	test("보류 holds; !reopen keeps a published PR; 폐기 says the PR stays", async () => {
		const s = await closedExternal(approvals("approved").fn);
		expect(await s.h.manager.hold(s.lane.name)).toMatchObject({ handled: true });
		expect(prOf(s)).toMatchObject({ state: "held" });
		expect(s.h.store.getLane(s.lane.name)?.meta.renderedStatus).toBe("⏸ ext · 보류");
		await publish(s);
		expect(prOf(s)?.state).toBe("published");
		const discarded = await s.h.manager.discard(s.lane.name);
		expect(discarded.text).toContain(`PR https://github.com/${UPSTREAM}/pull/77은 그대로입니다.`);
		s.h.close();
	});
});

// ---------------------------------------------------------------- daemon (수락기준 데몬)

describe("through the daemon: `!pr` in a closed lane's thread", () => {
	function laneConfig(): OmpbotConfig {
		return {
			...home.config,
			channels: { discord: { ...(home.config.channels.discord as DiscordChannelConfig), laneChannelId: CHANNEL } },
		};
	}

	test("`!pr owner/name` records externalPr and redraws the card without reaching the lane session; bare `!pr` on a non-GitHub origin is refused", async () => {
		const repo = makeRepo(repos);
		const bare = tempDir("ompbot-lane-xpr-origin-");
		git(bare, "init", "-q", "--bare");
		git(repo, "remote", "add", "origin", bare);
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		const sessions = new FakeSessionStore();
		const drivers = new Map<string, FakeOmpDriver>();
		const clock = { now: () => Date.now() };
		const daemon = new Daemon({
			config: laneConfig(),
			channels: [discordBinding(transport)],
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions });
				drivers.set(origin, driver);
				return driver;
			},
		});
		try {
			await daemon.start();
			await daemon.inject({ origin: `discord/dm/${OWNER_DM}`, asOwner: true, text: `작업: ask @${repo}` });
			await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore"));
			const rootId = transport.posts((text) => text === "🔄 ask")[0]?.id ?? "";
			const claim = daemon.hostToolsFor("ompbot/work/ask").find((tool) => tool.name === "ompbot_claim_done");
			const worktree = daemon.store.getLane("ask")?.cwd ?? "";
			commitIn(worktree, "a.txt");
			const signal = new AbortController().signal;
			expect(await claim?.execute({ repo: worktree, commit: "HEAD", summary: "a.txt 추가" }, { signal })).toContain(
				"검증 통과",
			);
			await transport.waitForPosts((text) => text.startsWith("🔍 머지 대기"));
			const cardId = transport.posts((text) => text.startsWith("🔍 머지 대기"))[0]?.id ?? "";
			const send = (content: string, id: string) =>
				transport.emitMessage({ id, channel_id: rootId, guild_id: GUILD, author: { id: OWNER }, content, type: 0 });
			const lanePrompts = () =>
				drivers.get("ompbot/work/ask")?.calls.filter((call) => call.startsWith("prompt:")) ?? [];

			await send("!pr", "7100000000000000100");
			await transport.waitForPosts((text) => text.includes("GitHub 저장소가 아니라"));
			expect(daemon.store.getLane("ask")?.meta.externalPr).toBeUndefined();

			await send("!pr up/proj", "7100000000000000200");
			await transport.waitForPosts((text) => text.includes("외부 PR 레인으로 바꿨습니다"));
			expect(daemon.store.getLane("ask")?.meta.externalPr).toMatchObject({ repo: "up/proj", bodyFile: "pr-body.md" });
			const redrawn = transport.calls.findLast((call) => call.method === "editMessage" && call.messageId === cardId);
			expect(redrawn?.method === "editMessage" ? redrawn.content : "").toContain("📤 PR 게시 대기");
			expect(JSON.stringify(redrawn?.method === "editMessage" ? redrawn.components : [])).toContain(
				lanePublishActionId("ask"),
			);
			expect(lanePrompts().some((call) => call.includes("!pr"))).toBe(false);
			expect(daemon.store.getInbound(`${CHANNEL}:7100000000000000200`)).toMatchObject({ state: "answered" });
		} finally {
			await daemon.stop();
		}
	});
});
