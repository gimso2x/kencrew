import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config";
import { collectLaneCommitIdentities, commitIdentityRefusals, type IntegrityRefusal } from "../src/lanes/integrity";
import type { LaneRow } from "../src/lanes/status";
import type { AutoLandPolicy } from "../src/tasks/notify";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const ALLOWED = "owner@example.com";
const FOREIGN = "someone@company.example";
const GITHUB = "noreply@github.com";

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("ompbot-lane-identity-home-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** Commits `files` with an explicit author and committer email; returns the new HEAD. */
function commitAs(dir: string, author: string, committer: string, ...files: string[]): string {
	for (const file of files) writeFileSync(join(dir, file), `${file}\n`);
	git(dir, "add", "--", ...files);
	git(
		dir,
		"-c",
		`user.email=${committer}`,
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"--author",
		`t <${author}>`,
		"-m",
		`add ${files.join(" ")}`,
	);
	return git(dir, "rev-parse", "HEAD");
}

/** A policy whose `commitEmails` lists `repo` with `emails`. */
function policyOf(repo: string, emails: string[]): AutoLandPolicy {
	return { repos: [repo], maxRisk: "L2", commitEmails: { [repo]: emails } };
}

/** Starts a work lane on `repo` (no acceptance checks: the git verdict and the claim's own text decide). */
function laneWith(h: LaneHarness, repo: string): Promise<LaneRow> {
	return h.manager.start({ title: "identity", cwd: repo, channel: CHANNEL, acceptance: [], risk: "L2" });
}

/** A harness taking the auto-merge policy (the carrier of `commitEmails`) as the daemon does; cards are recorded. */
function harnessWith(policy: AutoLandPolicy): LaneHarness & { asked: string[] } {
	const asked: string[] = [];
	const h = laneHarness(home.dir, {
		autoLandPolicy: () => policy,
		// The owner declines: the refusal then steers its remedies back instead of closing the lane.
		approvals: {
			request: async (_channel: string, summary: string) => {
				asked.push(summary);
				return "denied";
			},
		},
	});
	return Object.assign(h, { asked });
}

describe("lane commit identity (AC-1)", () => {
	test("an allowed author and committer closes the lane", async () => {
		const repo = makeRepo(repos);
		const h = harnessWith(policyOf(repo, [ALLOWED]));
		const lane = await laneWith(h, repo);
		await h.settle();
		commitAs(lane.cwd, ALLOWED, ALLOWED, "a.txt");
		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(text).toContain("검증 통과");
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		h.close();
	});

	test("a foreign author email is refused with commit_identity_mismatch and its remedy", async () => {
		const repo = makeRepo(repos);
		const h = harnessWith(policyOf(repo, [ALLOWED]));
		const lane = await laneWith(h, repo);
		await h.settle();
		const sha = commitAs(lane.cwd, FOREIGN, ALLOWED, "a.txt");
		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(text).toContain("commit_identity_mismatch");
		// The approval card carries the excerpt (short sha + the offending identity), the steer carries the remedy.
		expect(h.asked.join("\n")).toContain(`commit_identity_mismatch: ${sha.slice(0, 7)}: 작성자 <${FOREIGN}>`);
		const steered = h.steers(lane.originKey).join("\n");
		expect(steered).toContain("commit_identity_mismatch");
		expect(steered).toContain("git commit --amend --reset-author");
		h.close();
	});

	test("a foreign committer email is refused while the author is allowed", async () => {
		const repo = makeRepo(repos);
		const h = harnessWith(policyOf(repo, [ALLOWED]));
		const lane = await laneWith(h, repo);
		await h.settle();
		commitAs(lane.cwd, ALLOWED, FOREIGN, "a.txt");
		const sha = git(lane.cwd, "rev-parse", "HEAD");
		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(text).toContain("commit_identity_mismatch");
		expect(h.asked.join("\n")).toContain(`commit_identity_mismatch: ${sha.slice(0, 7)}: 커미터 <${FOREIGN}>`);
		h.close();
	});

	test("a repository not listed in commitEmails is not checked", async () => {
		const repo = makeRepo(repos);
		const other = makeRepo(repos);
		const h = harnessWith(policyOf(other, [ALLOWED]));
		const lane = await laneWith(h, repo);
		await h.settle();
		commitAs(lane.cwd, FOREIGN, FOREIGN, "a.txt");
		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(text).not.toContain("commit_identity_mismatch");
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		h.close();
	});

	test("a noreply@github.com committer is allowed", async () => {
		const repo = makeRepo(repos);
		const h = harnessWith(policyOf(repo, [ALLOWED]));
		const lane = await laneWith(h, repo);
		await h.settle();
		commitAs(lane.cwd, ALLOWED, GITHUB, "a.txt");
		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(text).not.toContain("commit_identity_mismatch");
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		h.close();
	});
});

describe("lane commit identity reading", () => {
	test("only the lane's own commits are read from the merge-base with the base branch", async () => {
		const repo = makeRepo(repos);
		const base = git(repo, "rev-parse", "HEAD");
		// The fixture's default branch is whatever this host's git picks (`master` or `main`).
		const baseBranch = git(repo, "symbolic-ref", "--short", "HEAD");
		git(repo, "checkout", "-q", "-b", "lane/x");
		const viaLane = commitAs(repo, FOREIGN, FOREIGN, "a.txt");
		commitAs(repo, ALLOWED, ALLOWED, "b.txt");
		const identities = await collectLaneCommitIdentities(repo, { baseBranch }, git(repo, "rev-parse", "HEAD"));
		// `git log` lists newest first.
		expect(identities.map((identity) => [identity.sha, identity.author])).toEqual([
			[git(repo, "rev-parse", "HEAD"), ALLOWED],
			[viaLane, FOREIGN],
		]);
		expect(identities.some((identity) => identity.sha === base)).toBe(false);
	});

	test("the committer is GitHub's noreply address only as the committer, case-insensitively matched otherwise", () => {
		const refused = (identities: Parameters<typeof commitIdentityRefusals>[0]): string[] =>
			commitIdentityRefusals(identities, [ALLOWED]).map((refusal: IntegrityRefusal) => refusal.excerpt);
		expect(refused([{ sha: "abcdef1234", author: FOREIGN, committer: GITHUB }])).toEqual([
			"abcdef1: 작성자 <someone@company.example>",
		]);
		expect(refused([{ sha: "abcdef1234", author: GITHUB, committer: ALLOWED }])).toHaveLength(1);
		expect(refused([{ sha: "abcdef1234", author: ALLOWED.toUpperCase(), committer: ALLOWED }])).toEqual([]);
		expect(
			refused([
				{ sha: "abcdef1234", author: ALLOWED, committer: ALLOWED },
				{ sha: "1234567890", author: ALLOWED, committer: FOREIGN },
			]),
		).toEqual(["1234567: 커미터 <someone@company.example>"]);
	});
});

describe("taskAutoLand.commitEmails config (AC-1)", () => {
	/** Rewrites the test home's config with `commitEmails` under `taskAutoLand`. */
	function withCommitEmails(commitEmails: unknown, extra: Record<string, unknown> = {}): void {
		const path = join(home.dir, "config.json");
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		raw.taskAutoLand = { repos: ["/srv/repo"], commitEmails, ...extra };
		writeFileSync(path, JSON.stringify(raw));
	}

	function configError(): ConfigError {
		try {
			loadConfig(home.dir);
		} catch (error) {
			if (error instanceof ConfigError) return error;
			throw error;
		}
		throw new Error("loadConfig did not throw");
	}

	test("absolute repository keys with non-empty email lists are kept", () => {
		withCommitEmails({ "/srv/repo/": ["owner@example.com", "other@example.com"] });
		expect(loadConfig(home.dir).taskAutoLand?.commitEmails).toEqual({
			"/srv/repo": ["owner@example.com", "other@example.com"],
		});
	});

	test.each([
		["a relative repository key", { "srv/repo": ["a@b.c"] }, "taskAutoLand.commitEmails.srv/repo"],
		["an empty email list", { "/srv/repo": [] }, "taskAutoLand.commitEmails./srv/repo"],
		["an email that is not a string", { "/srv/repo": [7] }, "taskAutoLand.commitEmails./srv/repo.0"],
		["an email without @", { "/srv/repo": ["owner.example.com"] }, "taskAutoLand.commitEmails./srv/repo.0"],
		["an email with a blank", { "/srv/repo": ["a b@c.d"] }, "taskAutoLand.commitEmails./srv/repo.0"],
		["a list that is not an array", { "/srv/repo": "a@b.c" }, "taskAutoLand.commitEmails./srv/repo"],
		["a non-object", ["a@b.c"], "taskAutoLand.commitEmails"],
	])("a malformed commitEmails (%s) is a config error", (_name, value, field) => {
		withCommitEmails(value);
		const error = configError();
		expect(error.code).toBe("config_invalid");
		expect(error.message).toContain(`field=${field}`);
	});
});
