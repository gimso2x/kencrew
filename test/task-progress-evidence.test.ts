import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiscordChannel } from "../src/discord/channel";
import type { HerdrAgentStatusResult, ProcessRunner } from "../src/dispatch/omp";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import { NO_EVIDENCE_LINE } from "../src/tasks/notify";
import { progressWithoutUpdated, type TaskSweepDeps, TaskSweeper, taskProgressEvidence } from "../src/tasks/sweeper";
import { localIso } from "../src/time";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";
import { git, makeRepo } from "./helpers/git-fixtures";

const repos: string[] = [];
afterEach(() => {
	for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TASK = "T-20261120-04";
const PROGRESS = `docs/tasks/${TASK}/PROGRESS.md`;
const PROGRESS_TEXT = (updated: string, current: string): string =>
	[
		"---",
		`task: ${TASK}`,
		"status: working",
		`updated: ${updated}`,
		`current: ${current}`,
		"next: 다음 단계",
		"---",
		"# 단계",
		"- [ ] S1: 하나",
		"",
	].join("\n");

/** A repo with the task's docs committed; the PROGRESS.md text is `body`. */
function taskRepo(body: string): string {
	const dir = makeRepo(repos);
	mkdirSync(join(dir, "docs/tasks", TASK), { recursive: true });
	writeFileSync(join(dir, "src.txt"), "v1\n");
	writeFileSync(join(dir, PROGRESS), body);
	git(dir, "add", "src.txt", PROGRESS);
	git(dir, "commit", "-q", "-m", "docs");
	return dir;
}

const keyOf = async (dir: string): Promise<string> => {
	const evidence = await taskProgressEvidence(dir, TASK, realRun);
	if (!evidence.ok) throw new Error(`evidence failed: ${evidence.reason}`);
	return evidence.key;
};

const realRun: ProcessRunner = async (cmd, opts) => {
	const run = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", cwd: opts?.cwd });
	return { code: run.exitCode ?? 1, stdout: run.stdout.toString(), timedOut: false };
};

describe("taskProgressEvidence", () => {
	test("a rewritten `updated` line leaves the key as it was", async () => {
		const dir = taskRepo(PROGRESS_TEXT("2026-11-20T10:00:00+09:00", "S1"));
		const before = await keyOf(dir);
		writeFileSync(join(dir, PROGRESS), PROGRESS_TEXT("2026-11-20T10:20:00+09:00", "S1"));
		expect(await keyOf(dir)).toBe(before);
	});

	test("PROGRESS.md current·next moving is progress", async () => {
		const dir = taskRepo(PROGRESS_TEXT("2026-11-20T10:00:00+09:00", "S1"));
		const before = await keyOf(dir);
		writeFileSync(join(dir, PROGRESS), PROGRESS_TEXT("2026-11-20T10:20:00+09:00", "S2"));
		expect(await keyOf(dir)).not.toBe(before);
	});

	test("a commit is progress", async () => {
		const dir = taskRepo(PROGRESS_TEXT("2026-11-20T10:00:00+09:00", "S1"));
		const before = await keyOf(dir);
		writeFileSync(join(dir, "src.txt"), "v2\n");
		git(dir, "commit", "-q", "-am", "work");
		expect(await keyOf(dir)).not.toBe(before);
	});

	test("an uncommitted change to the same path's content is progress, and so is the next one", async () => {
		const dir = taskRepo(PROGRESS_TEXT("2026-11-20T10:00:00+09:00", "S1"));
		const before = await keyOf(dir);
		writeFileSync(join(dir, "src.txt"), "v2\n");
		const changed = await keyOf(dir);
		expect(changed).not.toBe(before);
		writeFileSync(join(dir, "src.txt"), "v3\n");
		expect(await keyOf(dir)).not.toBe(changed);
	});

	test("a new untracked file is progress", async () => {
		const dir = taskRepo(PROGRESS_TEXT("2026-11-20T10:00:00+09:00", "S1"));
		const before = await keyOf(dir);
		writeFileSync(join(dir, "new.txt"), "x\n");
		expect(await keyOf(dir)).not.toBe(before);
	});

	test("an unreadable worktree reports ok: false", async () => {
		const evidence = await taskProgressEvidence(join(repos[0] ?? "/nonexistent", "no-such-dir"), TASK, realRun);
		expect(evidence).toMatchObject({ ok: false });
	});

	test("progressWithoutUpdated drops only the `updated` line", () => {
		expect(progressWithoutUpdated("a\nupdated: 1\nb")).toBe("a\nb");
	});
});

const T0 = Date.parse("2026-11-20T01:00:00Z");
const MIN = 60_000;

function judgement(over: Partial<TaskJudgement> = {}): TaskJudgement {
	return {
		reached: false,
		acChecked: 0,
		acTotal: 1,
		stepsDone: 0,
		stepsTotal: 1,
		status: "working",
		updatedAt: localIso(T0, "Asia/Seoul"),
		updatedAtMs: T0,
		specChanged: false,
		specKey: "spec1",
		blocked: false,
		needsOwner: false,
		blockedReason: "",
		decision: { question: "", recommend: "", impact: "" },
		current: "S1",
		restated: "",
		evidence: {},
		summary: [],
		checks: [],
		integrityWarnings: [],
		reachKey: "k1",
		acceptance: [],
		steps: [],
		problems: [],
		...over,
	};
}

interface Rig {
	sweeper: TaskSweeper;
	ledger: TaskLedger;
	row: TaskRow;
	clock: { ms: number };
	next: { value: TaskJudgement };
	reminders: string[];
	evidence: { value: string | undefined; throws?: boolean; calls: number };
	infos: Array<{ event: string; fields?: Record<string, unknown> }>;
	warnings: Array<{ event: string; fields?: Record<string, unknown> }>;
}

function rig(withEvidence = true): Rig {
	const clock = { ms: T0 };
	const db = new Database(":memory:", { strict: true });
	const ledger = new TaskLedger(db, { timezone: "Asia/Seoul", clock: { now: () => clock.ms } });
	const row = ledger.register({
		title: "정체 시계",
		risk: "L2",
		originKey: "discord/ch/1/t/2",
		threadRef: "1:2",
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["하나"]),
	});
	const reminders: string[] = [];
	const next: Rig["next"] = { value: judgement() };
	const evidence: Rig["evidence"] = { value: "e1", calls: 0 };
	const infos: Rig["infos"] = [];
	const warnings: Rig["warnings"] = [];
	const agent: HerdrAgentStatusResult = { ok: true, status: "idle" };
	const deps: TaskSweepDeps = {
		ledger,
		evaluate: async () => ({ ok: true, judgement: next.value }),
		remind: async (_row, text) => {
			reminders.push(text);
			return { ok: true };
		},
		agentStatus: async () => agent,
		readAgent: async () => ({ ok: true, output: "" }),
		channels: registryOf(new DiscordChannel(new FakeDiscordTransport(), { ownerUserId: "1" })),
		ownerUserId: "1",
		now: () => clock.ms,
		log: {
			info: (event, fields) => infos.push({ event, fields }),
			warn: (event, fields) => warnings.push({ event, fields }),
		},
		...(withEvidence
			? {
					progressEvidence: async () => {
						evidence.calls += 1;
						if (evidence.throws) throw new Error("git down");
						return evidence.value;
					},
				}
			: {}),
	};
	return { sweeper: new TaskSweeper(deps), ledger, row, clock, next, reminders, evidence, infos, warnings };
}

const progressAt = (r: Rig): number => r.ledger.require(r.row.taskId).progressAt ?? 0;

describe("TaskSweeper progress evidence", () => {
	test("a new `updated` with unchanged evidence keeps progressAt, reminds, and says the clock alone moved", async () => {
		const r = rig();
		await r.sweeper.sweep(); // baseline: the first evidence reading counts
		expect(progressAt(r)).toBe(T0);

		r.clock.ms = T0 + 40 * MIN;
		r.next.value = judgement({ updatedAt: localIso(T0 + 35 * MIN, "Asia/Seoul"), updatedAtMs: T0 + 35 * MIN });
		const [result] = await r.sweeper.sweep();
		expect(progressAt(r)).toBe(T0);
		expect(result?.actions).toContain("stale reminder to agent");
		expect(r.reminders).toHaveLength(1);
		expect(r.reminders[0]).toContain("`updated`만 바꾸면 진행으로 치지 않으니 current·next에 실제 진척을 적으세요.");
		expect(r.reminders[0]).toContain(NO_EVIDENCE_LINE);
		expect(r.infos.map((entry) => entry.event)).toContain("task_progress_no_evidence");
	});

	test("a new `updated` with new evidence moves progressAt", async () => {
		const r = rig();
		await r.sweeper.sweep();
		r.evidence.value = "e2";
		r.clock.ms = T0 + 10 * MIN;
		r.next.value = judgement({ updatedAt: localIso(T0 + 10 * MIN, "Asia/Seoul"), updatedAtMs: T0 + 10 * MIN });
		await r.sweeper.sweep();
		expect(progressAt(r)).toBe(T0 + 10 * MIN);
		expect(r.reminders).toEqual([]);
		// The no-evidence line is not carried once real evidence came in.
		r.clock.ms = T0 + 40 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders[0] ?? "").not.toContain(NO_EVIDENCE_LINE);
	});

	test("unreadable evidence keeps the old time-based rule", async () => {
		const r = rig();
		await r.sweeper.sweep();
		r.evidence.value = undefined; // remote task, missing worktree, git failure
		r.clock.ms = T0 + 10 * MIN;
		r.next.value = judgement({ updatedAt: localIso(T0 + 10 * MIN, "Asia/Seoul"), updatedAtMs: T0 + 10 * MIN });
		await r.sweeper.sweep();
		expect(progressAt(r)).toBe(T0 + 10 * MIN);
	});

	test("a throwing evidence read counts as unreadable and warns once", async () => {
		const r = rig();
		await r.sweeper.sweep();
		r.evidence.throws = true;
		for (const minutes of [10, 20]) {
			r.clock.ms = T0 + minutes * MIN;
			r.next.value = judgement({
				updatedAt: localIso(T0 + minutes * MIN, "Asia/Seoul"),
				updatedAtMs: T0 + minutes * MIN,
			});
			await r.sweeper.sweep();
		}
		expect(progressAt(r)).toBe(T0 + 20 * MIN);
		expect(r.warnings.filter((entry) => entry.event === "task_progress_evidence_failed")).toHaveLength(1);
	});

	test("without the dep every new `updated` counts, as before", async () => {
		const r = rig(false);
		await r.sweeper.sweep();
		r.clock.ms = T0 + 10 * MIN;
		r.next.value = judgement({ updatedAt: localIso(T0 + 10 * MIN, "Asia/Seoul"), updatedAtMs: T0 + 10 * MIN });
		await r.sweeper.sweep();
		expect(progressAt(r)).toBe(T0 + 10 * MIN);
		expect(r.evidence.calls).toBe(0);
	});

	test("the same `updated` read twice is not a second progress", async () => {
		const r = rig();
		await r.sweeper.sweep();
		r.evidence.value = "e2";
		r.clock.ms = T0 + 10 * MIN;
		await r.sweeper.sweep(); // same judgement value: no new `updated`
		expect(progressAt(r)).toBe(T0);
		expect(r.evidence.calls).toBe(1);
	});
});
