import { homedir } from "node:os";
import { join } from "node:path";
import type { LaneModelTier, LaneModelTiers, WorkerAgyConfig } from "../config";
import { TASK_RISKS, type TaskRisk } from "./docs";

/** The worker tier a new [TASK] runs on, fixed in its row for the task's life. */
export interface WorkerTier {
	tier: LaneModelTier;
	tierReason: string;
	/** `lanes.models[tier]` at registration; null = that tier is not configured, the worker keeps omp's default. */
	model: string | null;
	/** The start reply's line when a lower tier was raised for the risk; absent otherwise. */
	note?: string;
}

/** What `tierReason` records when the session gave none. */
const DEFAULT_TIER_REASON = "기본값";

/**
 * The tier of a new task from its final risk (after the risk floor): L3 and above always run on high (a lower request
 * is raised and says so), anything else takes the requested tier; without one L0 and L1 run on low and L2 on middle.
 * `models` is the live `lanes.models`.
 */
export function resolveWorkerTier(
	risk: TaskRisk,
	requested: { tier?: LaneModelTier | undefined; tierReason?: string | undefined },
	models: LaneModelTiers | undefined,
): WorkerTier {
	const reason = requested.tierReason ?? DEFAULT_TIER_REASON;
	const pinned = TASK_RISKS.indexOf(risk) >= TASK_RISKS.indexOf("L3");
	const raised = pinned && requested.tier !== undefined && requested.tier !== "high";
	const tier: LaneModelTier = pinned ? "high" : (requested.tier ?? (risk === "L2" ? "middle" : "low"));
	return {
		tier,
		tierReason: raised ? `위험 L3 이상 상향(요청 ${requested.tier}: ${reason})` : reason,
		model: models?.[tier] ?? null,
		...(raised ? { note: "위험 L3 이상이라 워커를 high로 올렸습니다" } : {}),
	};
}

/**
 * The worker's omp arguments with its model: every `--model <v>` / `--model=<v>` of the configured arguments gives way
 * to one trailing `--model <model>`. A null model leaves the configured arguments exactly as they are.
 */
export function withWorkerModel(args: readonly string[] | undefined, model: string | null): string[] | undefined {
	if (model === null) return args === undefined ? undefined : [...args];
	const kept: string[] = [];
	const list = args ?? [];
	for (let i = 0; i < list.length; i++) {
		const arg = list[i] as string;
		if (arg === "--model") {
			i++; // its value goes with it
		} else if (!arg.startsWith("--model=")) {
			kept.push(arg);
		}
	}
	return [...kept, "--model", model];
}

/** The card and reply line of a task's worker; undefined for a task registered before tiers existed. */
export function workerLine(row: {
	tier: LaneModelTier | null;
	tierReason: string | null;
	workerModel: string | null;
}): string | undefined {
	if (row.tier === null) return undefined;
	if (row.workerModel === null) return `워커: 기본 모델 (${row.tier})`;
	const agy = agyModelOf(row.workerModel);
	if (agy !== undefined) return `워커: agy ${agy} (${row.tier})`;
	const short = row.workerModel.slice(row.workerModel.lastIndexOf("/") + 1);
	return `워커: ${short} (${row.tier} — ${row.tierReason ?? DEFAULT_TIER_REASON})`;
}

/**
 * `tasks.worker_model` of an agy (Antigravity CLI) worker: this prefix and the agy model id. The schema is unchanged,
 * so the prefix is the only mark of the worker kind (doc/plans/agy-task-worker.md).
 */
export const AGY_WORKER_PREFIX = "agy:";

/** The agy model id of an agy worker's `workerModel`; `undefined` for an omp worker. */
export function agyModelOf(workerModel: string | null): string | undefined {
	return workerModel?.startsWith(AGY_WORKER_PREFIX) === true ? workerModel.slice(AGY_WORKER_PREFIX.length) : undefined;
}

/**
 * Command prefixes an agy worker is refused (agy `permissions.deny` `command(…)`): measured on agy 1.5.9 to hold under
 * `--dangerously-skip-permissions`, compound commands included (PROGRESS of T-20261116-13).
 */
export const AGY_DENIED_COMMANDS = [
	"git push",
	"git reset --hard",
	"git clean",
	"systemctl",
	"ompbot",
	"bun src/main.ts",
	"rm -rf /",
] as const;

/**
 * The agy worker's session-only `--settings` (never saved to agy's settings.json): the task worktree as the one
 * trusted workspace (without it the start stops on agy's trust question) and the deny rules — the commands above and
 * `read_file` of each secrets directory.
 */
export function agySettings(worktree: string, secretsDirs: readonly string[]): string {
	const deny = [
		...AGY_DENIED_COMMANDS.map((command) => `command(${command})`),
		...secretsDirs.map((dir) => `read_file(${dir})`),
	];
	return JSON.stringify({ trustedWorkspaces: [worktree], permissions: { deny } });
}

/**
 * The secrets directories an agy worker's `read_file` is refused: this bot home's and the default `~/.ompbot/secrets`.
 * Concrete paths only — agy 1.5.9 does not expand a `*` in a `read_file(…)` rule (measured). A shell read (`cat`) is
 * not a `read_file` and passes; the worker floors forbid it.
 */
export function agySecretsDirs(secretsDir: string): string[] {
	const fallback = join(homedir(), ".ompbot", "secrets");
	return fallback === secretsDir ? [secretsDir] : [secretsDir, fallback];
}

/**
 * What agy gets after herdr's `--`: the model, no permission prompts (an unanswered one would hang the pane forever),
 * and the session settings.
 */
export function agyWorkerArgs(model: string, worktree: string, secretsDirs: readonly string[]): string[] {
	return ["--model", model, "--dangerously-skip-permissions", "--settings", agySettings(worktree, secretsDirs)];
}

/** Why a requested agy worker was not given; `undefined` when it was. */
function agyRefusal(input: {
	risk: TaskRisk;
	host: string | null;
	agy: WorkerAgyConfig | undefined;
	busy: string | undefined;
}): string | undefined {
	if (input.agy === undefined) return "설정 workerAgy 없음";
	if (input.risk !== "L0" && input.risk !== "L1") return `위험 ${input.risk}`;
	if (input.host !== null) return `host ${input.host}`;
	if (input.busy !== undefined) return `${input.busy} 점유 중`;
	return undefined;
}

/**
 * The worker of a new task that asked for agy (`taskSpec.worker: "agy"`): the trial runs only a local L0·L1 task, one
 * at a time (`busy`: an agy task still working or blocked), with `workerAgy` set. Within that it is the omp tier's row
 * on low with `agy:<model>`; outside it the omp worker as resolved, with a reply line saying why.
 */
export function resolveAgyWorker(
	omp: WorkerTier,
	input: { risk: TaskRisk; host: string | null; agy: WorkerAgyConfig | undefined; busy: string | undefined },
): WorkerTier {
	const refusal = agyRefusal(input);
	if (refusal === undefined && input.agy !== undefined) {
		return { tier: "low", tierReason: omp.tierReason, model: `${AGY_WORKER_PREFIX}${input.agy.model}` };
	}
	const line = `agy 워커는 L0·L1 로컬·동시 1개만 — omp ${omp.tier}로 띄움 (${refusal})`;
	return { ...omp, note: omp.note === undefined ? line : `${omp.note}\n${line}` };
}
