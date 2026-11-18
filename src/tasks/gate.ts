import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageRef } from "../channel/port";
import { laneQaRisk, QA_INCONCLUSIVE, REVIEW_INCONCLUSIVE, receiptBlockers } from "../lanes/land";
import { type GateSlot, qaDepsOf, runQa, untilAborted } from "../lanes/qa";
import { type GateSubject, type LaneReviewDeps, reviewSubject } from "../lanes/review";
import type { LaneQa, LaneReview } from "../lanes/status";
import { defaultGit, type GitRunner } from "../lanes/verify";
import type { Logger } from "../log";
import type { TaskJudgement } from "./checker";
import { docsDirOf, type TaskRisk } from "./docs";
import { baseBranchOf, type TaskLandOutcome } from "./land";
import type { TaskGate, TaskLedger, TaskRow } from "./ledger";
import type { AutoLandPolicy } from "./notify";

/**
 * The independent review and run QA of a reached local [TASK] in the `taskAutoLand.review.confident` band
 * (doc/plans/task-review-qa-gate.md): the lanes' `reviewSubject`·`runQa` on the task's branch tip, one at a time in the
 * slot the lanes share, receipts kept in `tasks.gate_json` per tip. A `CLEAR` of at least `minConfidence` starts the
 * QA, a `PASS` lands the task through the core (`land`), anything else ends with the reasons. Each kind starts at most
 * `GATE_STARTS_MAX` times per tip (notice keys `gate:<sha>:<kind>:<n>`), so a gate cut off by restarts gives up.
 */

export const GATE_STARTS_MAX = 2;

export type GateKind = "review" | "qa";

/** What the gate does next for a tip: run one kind, or stop with the reasons (`[]` = the receipts let it land). */
export type TaskGateStep = { run: GateKind } | { blockers: string[] };

/** The gate's order for the task at `sha`: review → `CLEAR` (confident) → QA → `PASS`. */
export function taskGateStep(gate: TaskGate | null, sha: string, risk: TaskRisk, policy: AutoLandPolicy): TaskGateStep {
	const receipts = gate ?? {};
	if (policy.review !== undefined && receipts.review?.sha !== sha) return { run: "review" };
	const { qa: _qa, ...reviewOnly } = policy;
	const reviewed = receiptBlockers(receipts, sha, risk, reviewOnly);
	if (reviewed.length > 0) return { blockers: reviewed };
	if (laneQaRisk(risk, policy) && receipts.qa?.sha !== sha) return { run: "qa" };
	return { blockers: receiptBlockers(receipts, sha, risk, policy) };
}

/** The reason of a kind whose starts ran out without a receipt. */
export const exhaustedReason = (kind: GateKind): string =>
	`${kind === "review" ? REVIEW_INCONCLUSIVE : QA_INCONCLUSIVE}(재시도 ${GATE_STARTS_MAX}회 소진)`;

/** The task's branch tip and the base branch it lands on (`landTask`'s); `undefined` when git cannot tell. */
export async function taskTip(git: GitRunner, row: TaskRow): Promise<{ sha: string; baseBranch: string } | undefined> {
	const tip = await git(["-C", row.repo, "rev-parse", "--verify", "-q", `refs/heads/${row.branch}^{commit}`]);
	const baseBranch = await baseBranchOf(git, row.repo);
	if (tip.code !== 0 || baseBranch === undefined) return undefined;
	return { sha: tip.stdout.trim(), baseBranch };
}

/**
 * A reached task as the review and QA read it: spec.md as the brief, the registered criteria, the checks the sweep
 * re-ran (`judgement`), the outcome summary as the implementer's report.
 */
export function taskSubject(
	row: TaskRow,
	judgement: TaskJudgement,
	tip: { sha: string; baseBranch: string },
): GateSubject {
	const spec = join(docsDirOf(row.worktree, row.taskId), "spec.md");
	return {
		id: row.taskId,
		title: row.title,
		brief: existsSync(spec) ? readFileSync(spec, "utf8") : undefined,
		acceptance: row.acceptance,
		sha: tip.sha,
		baseBranch: tip.baseBranch,
		repo: row.repo,
		worktree: row.worktree,
		claim:
			judgement.summary.length === 0
				? undefined
				: { commit: tip.sha.slice(0, 12), summary: judgement.summary.join(" / ") },
		checks: judgement.checks,
	};
}

/** What the gate's caller (the sweep) does with its cards. */
export interface TaskGateHooks {
	/** The judgement the task reached with (its checks go to the review and QA). */
	judgement: TaskJudgement;
	/** The gate starts in the background: post the running card; resolves with where it went (`undefined`: none). */
	gating(): Promise<MessageRef | undefined>;
	/** The gate ended (and landed, when nothing held it). Not called for an aborted gate. */
	ended(end: TaskGateEnd, card: MessageRef | undefined): Promise<void>;
}

export interface TaskGateEnd {
	gate: TaskGate | null;
	/** Why the receipts hold the merge; `[]` = the landing ran (`landed`). */
	blockers: string[];
	landed?: TaskLandOutcome;
}

export interface TaskGateDeps {
	ledger: TaskLedger;
	slot: GateSlot;
	/** The lanes' reviewer setup; absent: every receipt is `inconclusive`. */
	reviewer?: Omit<LaneReviewDeps, "headOf" | "now">;
	/** `<ompbot home>/qa-worktrees`. */
	qaWorktreesDir?: string;
	headOf(worktree: string): Promise<{ sha: string; clean: boolean }>;
	git?: GitRunner;
	now(): number;
	log: Logger;
	/** Lands the task through the core after a clear gate (`Daemon` auto-merge, under its landing lock). */
	land(row: TaskRow): Promise<TaskLandOutcome>;
}

/** The running gates by task: their abort switch and when the run (not the landing after it) has ended. */
export class TaskGateRunner {
	readonly #deps: TaskGateDeps;
	readonly #running = new Map<string, { abort: AbortController; ended: Promise<void> }>();

	constructor(deps: TaskGateDeps) {
		this.#deps = deps;
	}

	has(taskId: string): boolean {
		return this.#running.has(taskId);
	}

	/**
	 * The gate's decision for a reached task in the band: `undefined` = its receipts let it land now; `held` = they hold
	 * it (or the starts ran out: told once per tip, later calls get no reasons); `gating` = a kind started in the
	 * background, after `hooks.gating()` posted the running card.
	 */
	async decide(row: TaskRow, hooks: TaskGateHooks, policy: AutoLandPolicy): Promise<TaskLandOutcome | undefined> {
		const tip = await taskTip(this.#deps.git ?? defaultGit, row);
		if (tip === undefined) return { state: "held", reasons: ["작업 브랜치 끝 커밋을 읽지 못함"] };
		const step = taskGateStep(row.gate, tip.sha, row.risk, policy);
		if ("blockers" in step) return step.blockers.length === 0 ? undefined : { state: "held", reasons: step.blockers };
		if (this.#running.has(row.taskId)) return { state: "in_flight" };
		if (!this.#claimStart(row.taskId, tip.sha, step.run)) {
			const told = this.#deps.ledger.recordNotice(row.taskId, `gate:${tip.sha}:exhausted`);
			return { state: "held", reasons: told ? [exhaustedReason(step.run)] : [] };
		}
		const abort = new AbortController();
		const ended = Promise.withResolvers<void>();
		this.#running.set(row.taskId, { abort, ended: ended.promise });
		const card = hooks.gating();
		const subject = taskSubject(row, hooks.judgement, tip);
		void this.#run(row, subject, policy, step.run, { abort, end: ended.resolve, card, hooks }).catch((error: unknown) =>
			this.#deps.log.error("task_gate_failed", { task: row.taskId, error: String(error) }),
		);
		await card;
		return { state: "gating" };
	}

	/** Whether the band task's tip still lacks a receipt the gate would start (a restart cut it off). */
	async pending(row: TaskRow, policy: AutoLandPolicy): Promise<boolean> {
		if (this.#running.has(row.taskId)) return false;
		const tip = await taskTip(this.#deps.git ?? defaultGit, row);
		if (tip === undefined || `gate:${tip.sha}:exhausted` in row.notices) return false;
		return "run" in taskGateStep(row.gate, tip.sha, row.risk, policy);
	}

	/** Aborts the task's running gate and waits until it ended (nothing recorded); at once when none runs. */
	async abort(taskId: string): Promise<void> {
		const running = this.#running.get(taskId);
		if (running === undefined) return;
		running.abort.abort();
		this.#deps.log.info("task_gate_aborted", { task: taskId });
		await running.ended;
	}

	/** The daemon stops: every running gate is aborted and waited for. */
	async stop(): Promise<void> {
		await Promise.all([...this.#running.keys()].map((taskId) => this.abort(taskId)));
	}

	#claimStart(taskId: string, sha: string, kind: GateKind): boolean {
		for (let n = 1; n <= GATE_STARTS_MAX; n++) {
			if (this.#deps.ledger.recordNotice(taskId, `gate:${sha}:${kind}:${n}`)) return true;
		}
		return false;
	}

	async #run(
		row: TaskRow,
		subject: GateSubject,
		policy: AutoLandPolicy,
		first: GateKind,
		ctx: { abort: AbortController; end: () => void; card: Promise<MessageRef | undefined>; hooks: TaskGateHooks },
	): Promise<void> {
		const { ledger, log } = this.#deps;
		let blockers: string[];
		try {
			let kind = first;
			for (;;) {
				const receipt = await this.#one(kind, subject, policy, ctx.abort.signal);
				if (receipt === undefined || ctx.abort.signal.aborted) {
					log.info("task_gate_stopped", { task: row.taskId, kind });
					return;
				}
				if (ledger.get(row.taskId)?.status !== "review") {
					log.info("task_gate_stale", { task: row.taskId, kind, sha: subject.sha });
					return;
				}
				const gate = ledger.recordGate(
					row.taskId,
					kind === "review" ? { review: receipt as LaneReview } : { qa: receipt as LaneQa },
				).gate;
				log.info("task_gate_recorded", { task: row.taskId, kind, sha: subject.sha, verdict: receipt.verdict });
				const step = taskGateStep(gate, subject.sha, row.risk, policy);
				if ("blockers" in step) {
					blockers = step.blockers;
					break;
				}
				if (!this.#claimStart(row.taskId, subject.sha, step.run)) {
					blockers = [exhaustedReason(step.run)];
					break;
				}
				kind = step.run;
			}
		} finally {
			// Before the landing: an owner's 머지 that comes now finds the landing lock, not this gate.
			this.#running.delete(row.taskId);
			ctx.end();
		}
		const current = ledger.require(row.taskId);
		const landed = blockers.length === 0 ? await this.#deps.land(current) : undefined;
		await ctx.hooks.ended(
			{ gate: current.gate, blockers, ...(landed === undefined ? {} : { landed }) },
			await ctx.card,
		);
	}

	/** One review or QA in the shared slot; `undefined` when aborted (waiting or running). */
	async #one(
		kind: GateKind,
		subject: GateSubject,
		policy: AutoLandPolicy,
		signal: AbortSignal,
	): Promise<LaneReview | LaneQa | undefined> {
		const { reviewer, now, log } = this.#deps;
		const slot = this.#deps.slot();
		const free = await untilAborted(slot, signal);
		if (free === undefined) {
			// Aborted while waiting: the place in the queue is given back when it comes.
			void slot.then((late) => late());
			return undefined;
		}
		try {
			if (signal.aborted) return undefined;
			const at = now();
			const { review, qa } = policy;
			if (kind === "review" && review !== undefined) {
				log.info("task_review_started", { task: subject.id, sha: subject.sha, model: review.model });
				if (reviewer === undefined) {
					const reason = "리뷰 실행기 없음";
					return { sha: subject.sha, verdict: "inconclusive", model: review.model, at, notes: "", reason };
				}
				return await reviewSubject(
					{ subject, model: review.model, timeoutMs: review.timeoutMs, signal },
					{ ...reviewer, headOf: (worktree) => this.#deps.headOf(worktree), now, log },
				);
			}
			if (kind !== "qa" || qa === undefined) return undefined;
			log.info("task_qa_started", { task: subject.id, sha: subject.sha, model: qa.model });
			const worktreesDir = this.#deps.qaWorktreesDir;
			if (reviewer === undefined || worktreesDir === undefined) {
				const reason = "QA 실행기 없음";
				return { sha: subject.sha, verdict: "inconclusive", findings: [], model: qa.model, at, reason };
			}
			return await runQa({ subject, policy: qa, signal }, qaDepsOf(reviewer, worktreesDir, now, log));
		} finally {
			free();
		}
	}
}
