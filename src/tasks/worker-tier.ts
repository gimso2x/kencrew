import type { LaneModelTier, LaneModelTiers } from "../config";
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
	const short = row.workerModel.slice(row.workerModel.lastIndexOf("/") + 1);
	return `워커: ${short} (${row.tier} — ${row.tierReason ?? DEFAULT_TIER_REASON})`;
}
