import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import type { Store } from "../src/store/db";
import { acceptanceItems } from "../src/tasks/docs";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type WikiFixture, wikiFixture } from "./helpers/wiki-fixture";

// Notes of committing conversation turns (doc/plans/wiki-work-outcome-notes.md D): one per channel thread and day, one
// per DM turn, kept in their own ledger because `turn_snapshots` forgets rows long before the day is over.

/** 2027-01-15 12:00 KST. */
const NOON = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const THREAD_ORIGIN = "discord/ch/300000000000000001/t/400000000000000100";
const THREAD_REF = "300000000000000001:400000000000000100";

let home: TestHome;
let store: Store;
let wiki: WikiFixture;
let repos: string[];
let now: number;

beforeEach(() => {
	home = makeHome("ompbot-wiki-turns-home-");
	now = NOON;
	store = openBotStore(join(home.dir, "ompbot.db"), { now: () => now }, "Asia/Seoul");
	wiki = wikiFixture(store, { now: () => now });
	repos = [];
});
afterEach(() => {
	store.close();
	home.remove();
	wiki.remove();
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

/** A turn that committed `subject` in `repo`: its before and after heads. */
function commitTurn(
	repo: string,
	subject: string,
): { headBefore: string; headAfter: string; repo: string; endedAt: number } {
	const headBefore = git(repo, "rev-parse", "HEAD");
	git(repo, "commit", "-q", "--allow-empty", "-m", subject);
	return { repo, headBefore, headAfter: git(repo, "rev-parse", "HEAD"), endedAt: now };
}

describe("conversation turn notes", () => {
	test("AC-3: two committing turns of one channel thread and day become one note after the day, although turn_snapshots dropped them", async () => {
		const repo = makeRepo(repos);
		const first = commitTurn(repo, "feat: 첫 번째");
		await wiki.notes.recordTurn({ originKey: THREAD_ORIGIN, opRef: "op1", threadRef: THREAD_REF, rows: [first] });
		now += 60_000;
		const second = commitTurn(repo, "feat: 두 번째");
		await wiki.notes.recordTurn({ originKey: THREAD_ORIGIN, opRef: "op2", threadRef: THREAD_REF, rows: [second] });
		// `turn_snapshots` keeps 20 rows per origin: 25 more turns push the two above out.
		for (let index = 0; index < 25; index++) {
			store.recordTurnSnapshot({
				originKey: THREAD_ORIGIN,
				opRef: `later${index}`,
				repo,
				headBefore: "a",
				treeBefore: "a",
				headAfter: "b",
				treeAfter: "b",
				startedAt: now,
				endedAt: now,
			});
		}
		expect(store.listTurnSnapshots({ originKey: THREAD_ORIGIN, opRef: "op1" })).toEqual([]);

		// Same day: nothing yet.
		await wiki.notes.flushTurns();
		expect(wiki.outbox()).toEqual([]);

		now += DAY_MS;
		await wiki.notes.flushTurns();
		const ids = wiki.outbox();
		expect(ids).toHaveLength(1);
		expect(ids[0]).toMatch(/^ompbot-turns-[0-9a-f]{10}-20270115$/);
		const note = wiki.read(ids[0] as string);
		expect(note.tags).toEqual(["ompbot", "work-outcome", "turns"]);
		expect(note.summary).toContain("feat: 첫 번째");
		expect(note.summary).toContain("feat: 두 번째");
		expect(note.project).toBe(repo.split("/").pop() ?? "");
		expect(wiki.sweeps).toHaveLength(1);

		// Written once: the drained file does not come back.
		rmSync(join(wiki.config?.agentDir ?? "", "wiki-outbox", `${ids[0]}.json`));
		await wiki.notes.flushTurns();
		expect(wiki.outbox()).toEqual([]);
	});

	test("AC-3: a DM turn is its own note at the next flush, even on the same day", async () => {
		const repo = makeRepo(repos);
		const one = commitTurn(repo, "fix: 하나");
		const two = commitTurn(repo, "fix: 둘");
		await wiki.notes.recordTurn({
			originKey: "discord/dm/200000000000000001",
			opRef: "op1",
			threadRef: "200000000000000001:400000000000000001",
			rows: [one],
		});
		await wiki.notes.recordTurn({
			originKey: "discord/dm/200000000000000001",
			opRef: "op2",
			threadRef: "200000000000000001:400000000000000002",
			rows: [two],
		});
		await wiki.notes.flushTurns();
		const ids = wiki.outbox();
		expect(ids).toHaveLength(2);
		expect(ids.map((id) => wiki.read(id).summary).join("\n")).toContain("fix: 하나");
		expect(ids.map((id) => wiki.read(id).summary).join("\n")).toContain("fix: 둘");
	});

	test("AC-3: a turn in a lane's or a [TASK]'s own origin and a turn that did not commit are left out", async () => {
		const repo = makeRepo(repos);
		store.tasks.register({
			title: "t",
			risk: "L1",
			originKey: THREAD_ORIGIN,
			threadRef: THREAD_REF,
			host: null,
			repo,
			acceptance: acceptanceItems(["x"]),
		});
		await wiki.notes.recordTurn({
			originKey: THREAD_ORIGIN,
			opRef: "op1",
			threadRef: THREAD_REF,
			rows: [commitTurn(repo, "feat: task thread")],
		});
		await wiki.notes.recordTurn({
			originKey: "lane/L-20270115-01",
			opRef: "op1",
			threadRef: "200000000000000001:400000000000000001",
			rows: [commitTurn(repo, "feat: lane")],
		});
		const head = git(repo, "rev-parse", "HEAD");
		await wiki.notes.recordTurn({
			originKey: "discord/dm/200000000000000001",
			opRef: "op2",
			threadRef: "200000000000000001:400000000000000002",
			rows: [{ repo, headBefore: head, headAfter: head, endedAt: now }],
		});
		now += DAY_MS;
		await wiki.notes.flushTurns();
		expect(wiki.outbox()).toEqual([]);
	});
});
