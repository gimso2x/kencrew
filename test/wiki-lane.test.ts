import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";
import { type WikiFixture, wikiFixture } from "./helpers/wiki-fixture";

// The wiki result note of a landed lane (doc/plans/wiki-work-outcome-notes.md C·D): real git repositories in temp
// directories, the wiki client's `--sweep` replaced by a recorder.

const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';

let homes: TestHome[];
let repos: string[];
let scratch: string[];
let fixtures: WikiFixture[];

beforeEach(() => {
	homes = [];
	repos = [];
	scratch = [];
	fixtures = [];
});
afterEach(() => {
	for (const home of homes) home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
	for (const fixture of fixtures) fixture.remove();
});

const baseOf = (repo: string): string => git(repo, "symbolic-ref", "--short", "HEAD");

function repoWithOrigin(): { repo: string; bare: string; base: string } {
	const repo = makeRepo(repos);
	const bare = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-wiki-bare-")));
	scratch.push(bare);
	git(bare, "init", "-q", "--bare");
	git(repo, "remote", "add", "origin", bare);
	git(repo, "push", "-q", "origin", baseOf(repo));
	return { repo, bare, base: baseOf(repo) };
}

function commitIn(dir: string, file: string): string {
	writeFileSync(join(dir, file), `${file}\n`);
	git(dir, "add", "--", file);
	git(dir, "commit", "-q", "-m", `add ${file}`);
	return git(dir, "rev-parse", "HEAD");
}

/** A harness whose lanes report to a `WikiNotes` over the harness's own store. */
function withNotes(options: { spawnFails?: boolean } = {}): { h: LaneHarness; wiki: WikiFixture } {
	let wiki!: WikiFixture;
	// One bot home (one ledger) per harness: a test may build several.
	const home = makeHome("ompbot-wiki-lane-home-");
	homes.push(home);
	const h = laneHarness(home.dir, {
		wikiNotes: {
			laneDraft: (lane) => wiki.notes.laneDraft(lane),
			laneDropDraft: (lane) => wiki.notes.laneDropDraft(lane),
			laneLanded: (lane) => wiki.notes.laneLanded(lane),
		},
	});
	wiki = wikiFixture(h.store, options);
	fixtures.push(wiki);
	return { h, wiki };
}

async function closeLane(h: LaneHarness, repo: string, title = "a.txt 추가") {
	const started = await h.manager.start({ title, cwd: repo, channel: CHANNEL, acceptance: [CHECK_A], risk: "L2" });
	await h.settle();
	commitIn(started.cwd, "a.txt");
	await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "a.txt 추가" });
	await h.settle();
	const lane = h.store.getLane(started.name);
	if (lane === undefined) throw new Error("lane missing");
	return lane;
}

describe("lane result note", () => {
	test("AC-1: landed writes ompbot-lane-<id>.json once with goal, criteria and commits, after the worktree is gone; a tick does not write it again", async () => {
		const { repo } = repoWithOrigin();
		const { h, wiki } = withNotes();
		const lane = await closeLane(h, repo);
		expect(wiki.outbox()).toEqual([]);

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const id = `ompbot-lane-${lane.meta.laneId}`;
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);
		expect(wiki.outbox()).toEqual([id]);
		const note = wiki.read(id);
		expect(note.title).toBe("작업 결과: a.txt 추가");
		expect(note.tags).toEqual(["ompbot", "work-outcome", "lane"]);
		expect(note.project).toBe(repo.split("/").pop() ?? "");
		expect(note.summary).toContain("## 목표");
		expect(note.summary).toContain("AC-1 (통과)");
		expect(note.summary).toContain("add a.txt");
		expect(note.summary).toContain("머지");
		expect(wiki.sweeps).toHaveLength(1);
		expect(wiki.sweeps[0]).toEqual(["python3", expect.stringContaining("omp-wiki-session-note.py"), "--sweep"]);

		// The sweep drained the file; a later tick must not bring it back.
		rmSync(join(wiki.config?.agentDir ?? "", "wiki-outbox", `${id}.json`));
		await h.manager.tick();
		await h.settle();
		expect(wiki.outbox()).toEqual([]);
		expect(wiki.sweeps).toHaveLength(1);
		h.close();
	});

	test("AC-1: merged-not-pushed writes nothing until the origin catches up; then it is written once", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const { h, wiki } = withNotes();
		const lane = await closeLane(h, repo);
		const other = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-wiki-clone-")));
		scratch.push(other);
		git(other, "clone", "-q", bare, ".");
		commitIn(other, "theirs.txt");
		git(other, "push", "-q", "origin", `HEAD:refs/heads/${base}`);

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(h.store.getLane(lane.name)?.meta.land?.state).toBe("merged-not-pushed");
		expect(wiki.outbox()).toEqual([]);

		git(repo, "pull", "-q", "--rebase", "origin", base);
		git(repo, "push", "-q", "origin", `HEAD:refs/heads/${base}`);
		await h.manager.tick();
		await h.settle();
		expect(h.store.getLane(lane.name)?.meta.land?.state).toBe("landed");
		const id = `ompbot-lane-${lane.meta.laneId}`;
		expect(wiki.outbox()).toEqual([id]);
		expect(wiki.read(id).summary).toContain("add a.txt");
		h.close();
	});

	test("AC-1: a discarded lane writes nothing", async () => {
		const second = repoWithOrigin();
		const again = withNotes();
		const discarded = await closeLane(again.h, second.repo);
		await again.h.manager.discard(discarded.name);
		await again.h.settle();
		expect(again.h.store.getLane(discarded.name)?.meta.land?.state).toBe("discarded");
		expect(again.wiki.outbox()).toEqual([]);
		again.h.close();
	});

	// One scenario per test: a lane cycle spawns a few dozen git subprocesses, so a test that chains three cycles
	// outruns bun's default 5 s per-test budget under load (a work bound, not a race — T-20261119-06).
	test("AC-4: without wikiNotes nothing is written and the landing stands", async () => {
		const first = repoWithOrigin();
		const { h, wiki } = withNotes();
		wiki.config = undefined;
		const off = await closeLane(h, first.repo);
		await h.manager.requestLand(off.name, "owner");
		await h.settle();
		expect(h.store.getLane(off.name)?.meta.land?.state).toBe("landed");
		expect(wiki.outbox()).toEqual([]);
		expect(wiki.sweeps).toEqual([]);
		h.close();
	});

	test("AC-4: a write failure changes no landing and logs wiki_note_failed", async () => {
		// Writing fails: the agent dir sits below a regular file.
		const second = repoWithOrigin();
		const failing = withNotes();
		const blocker = join(failing.wiki.dir, "blocker");
		writeFileSync(blocker, "x");
		failing.wiki.config = {
			...(failing.wiki.config as NonNullable<typeof failing.wiki.config>),
			agentDir: join(blocker, "agent"),
		};
		const lane = await closeLane(failing.h, second.repo);
		await failing.h.manager.requestLand(lane.name, "owner");
		await failing.h.settle();
		expect(failing.h.store.getLane(lane.name)?.meta.land?.state).toBe("landed");
		expect(failing.wiki.logs.some((line) => line.includes("wiki_note_failed") && line.includes("outbox"))).toBe(true);
		failing.h.close();
	});

	test("AC-4: a sweep that cannot start changes no landing; the note waits in the outbox", async () => {
		// Only the sweep cannot start: the file is there, the landing stands, a warning is logged.
		const third = repoWithOrigin();
		const spawning = withNotes({ spawnFails: true });
		const spawned = await closeLane(spawning.h, third.repo);
		await spawning.h.manager.requestLand(spawned.name, "owner");
		await spawning.h.settle();
		expect(spawning.h.store.getLane(spawned.name)?.meta.land?.state).toBe("landed");
		expect(spawning.wiki.outbox()).toEqual([`ompbot-lane-${spawned.meta.laneId}`]);
		expect(spawning.wiki.logs.some((line) => line.includes("wiki_note_failed") && line.includes("sweep"))).toBe(true);
		spawning.h.close();
	});

	test("AC-6: secret-looking text in the title is masked in the file", async () => {
		const { repo } = repoWithOrigin();
		const { h, wiki } = withNotes();
		const lane = await closeLane(h, repo, "키 sk-live1234567890abcdef 와 xoxb-123-abc 정리");
		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const raw = JSON.stringify(wiki.read(`ompbot-lane-${lane.meta.laneId}`));
		expect(raw).not.toContain("sk-live");
		expect(raw).not.toContain("xoxb-123");
		expect(raw).toContain("[REDACTED]");
		h.close();
	});
});
