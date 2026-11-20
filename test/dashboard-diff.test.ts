import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIFF_FILE_MAX, DIFF_TOTAL_MAX, readDiff } from "../src/dashboard/diff";
import { renderDashboardPage, renderDiffDetail } from "../src/dashboard/html";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { openStore } from "../src/store/db";
import { TASK_SCHEMA } from "../src/tasks/ledger";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";

let home: TestHome;
let repos: string[];

beforeEach(() => {
	repos = [];
	home = makeHome("ompbot-dash-diff-");
	openStore({
		timezone: "Asia/Seoul",
		path: join(home.dir, "ompbot.db"),
		clock: { now: () => Date.now() },
		redact: (text) => text,
	}).close();
});
afterEach(() => {
	home.remove();
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

function write(repo: string, path: string, text: string): void {
	mkdirSync(join(repo, path, ".."), { recursive: true });
	writeFileSync(join(repo, path), text);
}

function commit(repo: string, message: string): string {
	git(repo, "add", "--all");
	git(repo, "commit", "-q", "-m", message);
	return git(repo, "rev-parse", "HEAD");
}

function withDb(fn: (db: Database) => void): void {
	const db = new Database(join(home.dir, "ompbot.db"));
	try {
		fn(db);
	} finally {
		db.close();
	}
}

function addLane(name: string, meta: Record<string, unknown>): void {
	withDb((db) =>
		db
			.query(
				"INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, status, meta, created_at, updated_at) VALUES (?, 't', ?, ?, '/x', '/y', 'working', ?, 1, 1)",
			)
			.run(name, `ref-${name}`, `key-${name}`, JSON.stringify(meta)),
	);
}

function addTask(id: string, repo: string, branch: string, host: string | null = null): void {
	withDb((db) => {
		db.run(TASK_SCHEMA);
		db.query(
			"INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status, acceptance_json, created_at, updated_at) VALUES (?, 't', 'L1', 'k', 'r', ?, ?, '/w', ?, 'a', 'working', '[]', 1, 1)",
		).run(id, host, repo, branch);
	});
}

/** A repo whose base branch has one commit and whose `work` branch adds a file, edits one and touches docs/tasks. */
function fixture(): { repo: string; base: string; tip: string } {
	const repo = makeRepo(repos);
	const base = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
	git(repo, "checkout", "-q", "-b", "work");
	write(repo, "src/a.ts", "export const a = 1;\n");
	write(repo, "README.md", "hello\nworld\n");
	commit(repo, "first");
	write(repo, "docs/tasks/T-1/PROGRESS.md", "status\n");
	write(repo, "src/b.ts", "export const b = 2;\n");
	const tip = commit(repo, "second");
	return { repo, base, tip };
}

describe("readDiff", () => {
	test("a lane diff lists files with +/- counts and hunks from the merge-base, also after a reopen moved baseSha", async () => {
		const { repo, base, tip } = fixture();
		const first = git(repo, "rev-parse", "work~1");
		addLane("fix", { repo, baseBranch: base, sha: tip, baseSha: first });
		const answer = await readDiff(home.dir, { lane: "fix" });
		if (!answer.ok) throw new Error(answer.error);
		expect(answer.subject).toBe("lane:fix");
		expect(answer.sha).toBe(tip);
		expect(answer.truncated).toBe(false);
		expect(answer.files.map((f) => [f.path, f.added, f.deleted]).sort()).toEqual([
			["README.md", 1, 0],
			["docs/tasks/T-1/PROGRESS.md", 1, 0],
			["src/a.ts", 1, 0],
			["src/b.ts", 1, 0],
		]);
		expect(answer.files.find((f) => f.path === "README.md")?.hunks).toContain("+world");
		expect(JSON.stringify(answer)).not.toContain(repo);
	});

	test("a task diff is the tip's change without docs/tasks", async () => {
		const { repo } = fixture();
		addTask("T-1", repo, "work");
		const answer = await readDiff(home.dir, { task: "T-1" });
		if (!answer.ok) throw new Error(answer.error);
		expect(answer.files.map((f) => f.path).sort()).toEqual(["README.md", "src/a.ts", "src/b.ts"]);
		expect(JSON.stringify(answer)).not.toContain(repo);
	});

	test("a secret-shaped line is masked and a binary file carries counts only", async () => {
		const { repo, base } = fixture();
		// Assembled at run time so secret scanners (gitleaks, GitHub push protection) see no token in the source.
		const fakeToken = ["xoxb", "1111111111", "2222222222", "fakeFakeFakeFakeFake"].join("-");
		write(repo, "env.txt", `token=${fakeToken}\n`);
		writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
		const tip = commit(repo, "more");
		addLane("s", { repo, baseBranch: base, sha: tip });
		const answer = await readDiff(home.dir, { lane: "s" });
		if (!answer.ok) throw new Error(answer.error);
		expect(JSON.stringify(answer)).not.toContain(fakeToken);
		const bin = answer.files.find((f) => f.path === "blob.bin");
		expect(bin).toMatchObject({ binary: true, added: 0, deleted: 0, hunks: "" });
	});

	test("a file over the per-file cap and a change over the total cap are cut and flagged truncated", async () => {
		const { repo, base } = fixture();
		const line = `${"x".repeat(78)}\n`;
		write(repo, "big.txt", line.repeat(Math.ceil((DIFF_FILE_MAX * 2) / 79)));
		let tip = commit(repo, "big");
		addLane("one", { repo, baseBranch: base, sha: tip });
		const one = await readDiff(home.dir, { lane: "one" });
		if (!one.ok) throw new Error(one.error);
		expect(one.truncated).toBe(true);
		const big = one.files.find((f) => f.path === "big.txt");
		expect(big?.hunks.length).toBeLessThanOrEqual(DIFF_FILE_MAX);
		expect(big?.added).toBeGreaterThan(1500);
		for (let i = 0; i < Math.ceil(DIFF_TOTAL_MAX / DIFF_FILE_MAX) + 1; i++) {
			write(repo, `many/${i}.txt`, line.repeat(Math.ceil(DIFF_FILE_MAX / 79) - 10));
		}
		tip = commit(repo, "many");
		addLane("all", { repo, baseBranch: base, sha: tip });
		const all = await readDiff(home.dir, { lane: "all" });
		if (!all.ok) throw new Error(all.error);
		expect(all.truncated).toBe(true);
		expect(all.files.reduce((n, f) => n + f.hunks.length, 0)).toBeLessThanOrEqual(DIFF_TOTAL_MAX);
	});

	test("misses: no claim, gone branch, remote task, unknown names", async () => {
		const { repo } = fixture();
		addLane("early", { repo, baseBranch: "main" });
		addTask("T-2", repo, "no-such-branch");
		addTask("T-3", repo, "work", "oci");
		expect(await readDiff(home.dir, { lane: "early" })).toEqual({ ok: false, error: "no_claim" });
		expect(await readDiff(home.dir, { task: "T-2" })).toEqual({ ok: false, error: "gone" });
		expect(await readDiff(home.dir, { task: "T-3" })).toEqual({ ok: false, error: "remote_unsupported" });
		expect(await readDiff(home.dir, { lane: "nope" })).toEqual({ ok: false, error: "unknown_lane" });
		expect(await readDiff(home.dir, { task: "T-9" })).toEqual({ ok: false, error: "unknown_task" });
	});
});

describe("api/diff", () => {
	function serve(diff?: Parameters<typeof startDashboardServer>[0]["diff"]) {
		return startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot: async () => {
				throw new Error("unused");
			},
			...(diff === undefined ? {} : { diff }),
		});
	}

	test("without the option every diff request is 404 diff_disabled", async () => {
		const server = serve();
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/api/diff?lane=a`);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "diff_disabled" });
		} finally {
			server.stop(true);
		}
	});

	test("answers the reader's result, its misses as 404, a git failure as 500 and a bad subject as 400", async () => {
		const { repo, base, tip } = fixture();
		addLane("fix", { repo, baseBranch: base, sha: tip });
		addLane("early", { repo, baseBranch: base });
		addLane("broken", { repo, baseBranch: base, sha: "0".repeat(40) });
		const server = serve((subject) => readDiff(home.dir, subject));
		const url = `http://127.0.0.1:${server.port}/api/diff`;
		try {
			const ok = await fetch(`${url}?lane=fix`);
			expect(ok.status).toBe(200);
			expect(((await ok.json()) as { files: unknown[] }).files.length).toBe(4);
			expect((await fetch(`${url}?lane=early`)).status).toBe(404);
			expect(await (await fetch(`${url}?lane=broken`)).json()).toEqual({ ok: false, error: "diff_failed" });
			expect((await fetch(url)).status).toBe(400);
			expect((await fetch(`${url}?lane=a&task=b`)).status).toBe(400);
		} finally {
			server.stop(true);
		}
	});
});

const off = { ok: false as const, error: "not in this test" };
const SNAPSHOT = {
	generatedAt: "2026-11-12T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		ompVersion: "1",
		origins: 1,
		busy: 0,
		ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0, uncertain: 0 },
		monitors: { count: 0, next: null },
		openGates: [],
	},
	turns: off,
	tasks: { ok: true, items: [] },
	lanes: off,
	herdr: { ok: true, hosts: [] },
	approvals: off,
	monitors: off,
	alerts: off,
	gates: off,
	backup: off,
	jobs: off,
} as unknown as DashboardSnapshot;

describe("diff page", () => {
	test("?diff=lane:<name> opens the detail panel on that change, with the title escaped", async () => {
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot: async () => SNAPSHOT,
		});
		try {
			const page = await (await fetch(`http://127.0.0.1:${server.port}/?diff=lane%3Afix`)).text();
			expect(page).toContain('<aside id="detail" class="detail is-open" aria-label="변경 보기">');
			expect(page).toContain('<h2 class="detail-title" id="detail-title" tabindex="-1">lane:fix</h2>');
			expect(page).toContain('class="detail-open"');
			expect(renderDashboardPage(SNAPSHOT, { diff: "lane:<b>" })).toContain("lane:&lt;b&gt;");
		} finally {
			server.stop(true);
		}
	});

	test("the answer is drawn as one folded block per file with coloured lines and a truncation note", () => {
		const html = renderDiffDetail("task:T-1", {
			base: "a".repeat(40),
			sha: "b".repeat(40),
			truncated: true,
			files: [
				{ path: "src/<a>.ts", added: 1, deleted: 1, binary: false, hunks: "@@ -1 +1 @@\n-old\n+new" },
				{ path: "x.bin", added: 0, deleted: 0, binary: true, hunks: "" },
			],
		});
		expect(html).toContain("파일 2개 · +1 −1");
		expect(html).toContain('<span class="diff-path">src/&lt;a&gt;.ts</span>');
		expect(html).toContain('<span class="da">+new</span>');
		expect(html).toContain('<span class="dd">-old</span>');
		expect(html).toContain("잘림");
		expect(renderDiffDetail("lane:x", { error: "no_claim" })).toContain("no_claim");
		expect(renderDiffDetail("lane:x")).toContain("불러오는 중");
	});
});
