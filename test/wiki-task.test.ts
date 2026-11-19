import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tasksCommand } from "../src/cli/tasks";
import { Daemon } from "../src/daemon/daemon";
import { dispatchEnv } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems, docsDirOf } from "../src/tasks/docs";
import { landTask, type TaskLandDeps } from "../src/tasks/land";
import type { TaskRow } from "../src/tasks/ledger";
import { CHANNEL, discordBinding, makeHome, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";

// The wiki result note of a [TASK] (doc/plans/wiki-work-outcome-notes.md D): the core's landing, `tasks close --as
// done` with its `tasks_sync`, and a close made while the daemon was down. Real git, a real daemon, a fake client
// directory (its `--sweep` script does nothing).

const THREAD = "400000000000000100";
const clock = { now: () => Date.now() };

const git = (dir: string, ...args: string[]): string =>
	execFileSync("git", ["-C", dir, ...args], { env: dispatchEnv(process.env), encoding: "utf8" }).trim();

let root: string;
let repo: string;
let home: TestHome;
let daemon: Daemon;
let outbox: string;

const outboxIds = (): string[] =>
	existsSync(outbox)
		? readdirSync(outbox)
				.filter((name) => name.endsWith(".json"))
				.map((name) => name.slice(0, -5))
		: [];
const noteOf = (taskId: string) =>
	JSON.parse(readFileSync(join(outbox, `ompbot-task-${taskId}.json`), "utf8")) as { summary: string; project: string };

function newDaemon(): Daemon {
	const sessions = new FakeSessionStore();
	return new Daemon({
		config: home.config,
		channels: [discordBinding(new WaitingDiscordTransport())],
		log: createLogger({ sink: () => {}, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		taskLand: (row, deps: TaskLandDeps) =>
			landTask(row, {
				...deps,
				judge: async () => ({
					ok: true,
					judgement: { problems: [], integrityWarnings: [] } as Partial<TaskJudgement> as TaskJudgement,
				}),
			}),
	});
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "ompbot-wiki-task-"));
	repo = join(root, "repo");
	const origin = join(root, "origin.git");
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
	const client = join(root, "client");
	mkdirSync(join(client, "integrations", "omp"), { recursive: true });
	writeFileSync(join(client, "integrations", "omp", "omp-wiki-session-note.py"), "# fake client\n");
	home = makeHome("ompbot-wiki-task-home-");
	home.config.wikiNotes = { client, agentDir: join(root, "agent") };
	outbox = join(root, "agent", "wiki-outbox");
	daemon = newDaemon();
	await daemon.start();
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
	rmSync(root, { recursive: true, force: true });
});

/** A reached local task in review: spec (AC-1 checked, a goal), one feature commit and an outcome naming it. */
function seed(): TaskRow {
	const tasks = daemon.store.tasks;
	const registered = tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
		threadRef: `${CHANNEL}:${THREAD}`,
		host: null,
		repo,
		acceptance: acceptanceItems(["로그가 회전된다"]),
	});
	const { worktree, branch, taskId } = registered;
	git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	const docs = docsDirOf(worktree, taskId);
	mkdirSync(docs, { recursive: true });
	writeFileSync(
		join(docs, "spec.md"),
		`---\ntask: ${taskId}\n---\n# 목표\n로그 파일을 날짜별로 회전한다.\n# 수락기준\n- [x] AC-1: 로그가 회전된다\n`,
	);
	git(worktree, "add", "docs");
	git(worktree, "commit", "-q", "-m", `docs(task): ${taskId} 4문서`);
	writeFileSync(join(worktree, "a.txt"), "task a\n");
	git(worktree, "add", "a.txt");
	git(worktree, "commit", "-q", "-m", "feat: 로그 회전");
	const feat = git(worktree, "rev-parse", "HEAD");
	writeFileSync(
		join(docs, "outcome.md"),
		`## 요약\n로그 회전 추가\n## AC-1\n- commit: ${feat.slice(0, 9)} feat: 로그 회전\n- test: bun test → 3 pass\n`,
	);
	git(worktree, "add", "docs");
	git(worktree, "commit", "-q", "-m", "docs: evidence");
	tasks.transition(taskId, "review", "bot");
	return tasks.require(taskId);
}

describe("task result note", () => {
	test("AC-2: a core landing writes ompbot-task-<id>.json with the criteria and commits although the worktree and branch are gone", async () => {
		const row = seed();
		expect(await daemon.autoLand(row)).toMatchObject({ state: "landed" });
		expect(existsSync(row.worktree)).toBe(false);
		expect(outboxIds()).toEqual([`ompbot-task-${row.taskId}`]);
		const note = noteOf(row.taskId);
		expect(note.project).toBe("repo");
		expect(note.summary).toContain("로그 파일을 날짜별로 회전한다.");
		expect(note.summary).toContain("AC-1 (통과): 로그가 회전된다");
		expect(note.summary).toContain("bun test → 3 pass");
		expect(note.summary).toContain("feat: 로그 회전");
		expect(note.summary).toContain("push origin/main");
	});

	test("AC-2: tasks close --as done reaches the daemon with tasks_sync and writes the note; cancelled writes none", async () => {
		const done = seed();
		const cancelled = daemon.store.tasks.register({
			title: "취소됨",
			risk: "L1",
			originKey: `discord/ch/${CHANNEL}/t/400000000000000200`,
			threadRef: `${CHANNEL}:400000000000000200`,
			host: null,
			repo,
			acceptance: acceptanceItems(["x"]),
		});
		expect(await tasksCommand(["close", cancelled.taskId, "--as", "cancelled"], home.dir)).toBe(0);
		expect(outboxIds()).toEqual([]);
		expect(await tasksCommand(["close", done.taskId, "--as", "done"], home.dir)).toBe(0);
		expect(outboxIds()).toEqual([`ompbot-task-${done.taskId}`]);
		const note = noteOf(done.taskId);
		expect(note.summary).toContain("AC-1 (통과)");
		expect(note.summary).toContain("feat: 로그 회전");
		// Closing is idempotent: a second sync after the file was drained writes nothing again.
		rmSync(join(outbox, `ompbot-task-${done.taskId}.json`));
		expect(await tasksCommand(["close", done.taskId, "--as", "done"], home.dir)).toBe(0);
		expect(outboxIds()).toEqual([]);
	});

	test("AC-2: a task closed done while the daemon was down gets its note at the next start", async () => {
		const row = seed();
		await daemon.stop();
		// The CLI closes it with no daemon listening: `tasks_sync` finds nobody.
		expect(await tasksCommand(["close", row.taskId, "--as", "done"], home.dir)).toBe(0);
		expect(outboxIds()).toEqual([]);
		daemon = newDaemon();
		await daemon.start();
		expect(outboxIds()).toEqual([`ompbot-task-${row.taskId}`]);
		expect(noteOf(row.taskId).summary).toContain("AC-1 (통과)");
	});
});
