import type { ProcessRunner } from "../dispatch/omp";
import { isRecord } from "../omp/type-guards";
import { redact } from "../redact";
import type { Section } from "./snapshot";

/**
 * The "모델 한도" card's data (`doc/plans/usage-limits-card.md`): config `dashboard.usageLimits` lists commands, each
 * one a source. `omp usage --json -r -p <provider>` (Claude, GLM) prints JSON; `agy -p /usage` (Antigravity) prints
 * tab-separated lines. Both are read here at this boundary (outside-controlled output): a source whose output has an
 * unexpected shape fails alone, and no account identifier (the `-r` masked e-mail, ids) is carried out.
 */

/** A run is reused this long, failed runs too: the dashboard polls every 60 seconds even from a hidden tab. */
export const USAGE_LIMITS_TTL_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 20_000;
const STDOUT_CAP = 1_000_000;
const ERROR_CHARS = 200;

export interface UsageRow {
	label: string;
	window: "5h" | "weekly" | "other";
	windowLabel: string;
	remainingPct: number;
	/** Epoch ms of the window's reset, when the source tells. */
	resetsAt?: number;
}

/** `account`: the Antigravity account label from config `agyAccount` (the agy output names none). */
export type UsageSource = { name: string; account?: string } & (
	| { ok: true; rows: UsageRow[] }
	| { ok: false; error: string }
);

export interface UsageLimitsInfo {
	sources: UsageSource[];
	fetchedAt: number;
}

export interface UsageLimitsConfig {
	omp?: string[][];
	agy?: string[];
	/** A command printing the logged-in agy account's label on its first line (e.g. `cat ~/.agy-accounts/current`). */
	agyAccount?: string[];
}

type Kind = "omp" | "agy";

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Claude", zai: "GLM" };

const cache = new Map<string, { at: number; result: Promise<Section<UsageLimitsInfo>> }>();

/** Test only: forget every cached run. */
export function clearUsageLimitsCache(): void {
	cache.clear();
}

/**
 * The card's section. Cached per config at module level (a `snapshotReader` is made anew for every `!brief`): a run
 * younger than {@link USAGE_LIMITS_TTL_MS}, finished or still running, is shared. Never rejects.
 */
export function readUsageLimits(
	config: UsageLimitsConfig,
	run: ProcessRunner,
	now: () => number,
): Promise<Section<UsageLimitsInfo>> {
	const key = JSON.stringify(config);
	const started = now();
	const hit = cache.get(key);
	if (hit !== undefined && started - hit.at >= 0 && started - hit.at < USAGE_LIMITS_TTL_MS) return hit.result;
	const result = collect(config, run, now).catch(
		(error: unknown): Section<UsageLimitsInfo> => ({
			ok: false,
			error: clean(error instanceof Error ? error.message : String(error)),
		}),
	);
	cache.set(key, { at: started, result });
	return result;
}

async function collect(
	config: UsageLimitsConfig,
	run: ProcessRunner,
	now: () => number,
): Promise<Section<UsageLimitsInfo>> {
	const jobs: Array<{ kind: Kind; argv: string[] }> = [
		...(config.omp ?? []).map((argv) => ({ kind: "omp" as const, argv })),
		...(config.agy === undefined ? [] : [{ kind: "agy" as const, argv: config.agy }]),
	];
	const account =
		config.agy === undefined || config.agyAccount === undefined ? undefined : readAccount(config.agyAccount, run);
	const sources = await Promise.all(
		jobs.map(async (job) => {
			const source = await readSource(job.kind, job.argv, run);
			return job.kind === "agy" && account !== undefined ? { ...source, account: await account } : source;
		}),
	);
	return { ok: true, sources, fetchedAt: now() };
}

const ACCOUNT_CHARS = 40;

/** The first non-empty stdout line, cut to {@link ACCOUNT_CHARS}; a failed or empty run reads `계정 확인 실패`. */
async function readAccount(argv: string[], run: ProcessRunner): Promise<string> {
	const unknown = "계정 확인 실패";
	try {
		const out = await run(argv, { timeoutMs: COMMAND_TIMEOUT_MS });
		if (out.timedOut || out.code !== 0) return unknown;
		const line = out.stdout
			.split("\n")
			.find((part) => part.trim() !== "")
			?.trim();
		return line === undefined ? unknown : redact(line).slice(0, ACCOUNT_CHARS);
	} catch {
		return unknown;
	}
}

/** The provider after `-p` in an omp argv; `omp` when there is none. */
function providerOf(argv: string[]): string {
	const i = argv.indexOf("-p");
	return (i >= 0 ? argv[i + 1] : undefined) ?? "omp";
}

const displayName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;

async function readSource(kind: Kind, argv: string[], run: ProcessRunner): Promise<UsageSource> {
	const name = kind === "agy" ? "Antigravity" : displayName(providerOf(argv));
	const failed = (error: string): UsageSource => ({ name, ok: false, error: clean(error) });
	let out: Awaited<ReturnType<ProcessRunner>>;
	try {
		out = await run(argv, { timeoutMs: COMMAND_TIMEOUT_MS, stdoutCap: STDOUT_CAP });
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
	if (out.timedOut) return failed(`${COMMAND_TIMEOUT_MS / 1000}초 안에 끝나지 않음`);
	if (out.code !== 0) {
		const reason = (out.stderr ?? "").trim().split("\n").at(-1) ?? "";
		return failed(`종료 코드 ${out.code}${reason === "" ? "" : `: ${reason}`}`);
	}
	if (out.stdout.trim() === "") return failed("빈 출력");
	if (kind === "agy") {
		const rows = parseAgy(out.stdout);
		return typeof rows === "string" ? failed(`모양이 다름: ${rows}`) : { name, ok: true, rows };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(out.stdout);
	} catch {
		return failed("JSON이 아닌 출력");
	}
	const rows = parseOmp(parsed);
	return typeof rows === "string" ? failed(`모양이 다름: ${rows}`) : { name, ok: true, rows };
}

/** Weekly `window.id`s: `7d` is Anthropic's, `1w` Zai's (2026-11-16 `omp usage --json`). */
const WEEKLY_IDS: Record<string, true> = { weekly: true, "7d": true, "1w": true };

/**
 * `omp usage --json` rows of every report (one provider per command), or the path of the first mismatching field.
 * `window.id` `5h` is the five-hour window, {@link WEEKLY_IDS} the weekly one, anything else `other`.
 */
export function parseOmp(value: unknown): UsageRow[] | string {
	if (!isRecord(value) || !Array.isArray(value.reports)) return "reports";
	const rows: UsageRow[] = [];
	for (const [r, report] of value.reports.entries()) {
		if (!isRecord(report) || !Array.isArray(report.limits)) return `reports.${r}.limits`;
		for (const [l, limit] of report.limits.entries()) {
			const at = `reports.${r}.limits.${l}`;
			if (!isRecord(limit) || typeof limit.label !== "string") return `${at}.label`;
			const window = limit.window;
			if (!isRecord(window) || typeof window.id !== "string") return `${at}.window.id`;
			const amount = limit.amount;
			if (!isRecord(amount) || typeof amount.usedFraction !== "number" || !Number.isFinite(amount.usedFraction)) {
				return `${at}.amount.usedFraction`;
			}
			if (window.resetsAt !== undefined && (typeof window.resetsAt !== "number" || !Number.isFinite(window.resetsAt))) {
				return `${at}.window.resetsAt`;
			}
			rows.push({
				label: limit.label,
				window: window.id === "5h" ? "5h" : WEEKLY_IDS[window.id] === true ? "weekly" : "other",
				windowLabel: typeof window.label === "string" ? window.label : window.id,
				remainingPct: clampPct(Math.round((1 - amount.usedFraction) * 100)),
				...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}),
			});
		}
	}
	return rows.length === 0 ? "reports" : rows;
}

/**
 * `agy -p /usage` lines `group\tlimit name\tremaining %\tISO time`. Assumes non-TTY pipe output (a terminal run draws a
 * different layout). Blank lines are skipped; any other line that is not four fields with a numeric percent makes the
 * whole source a mismatch, so a changed output is never drawn wrongly.
 */
export function parseAgy(stdout: string): UsageRow[] | string {
	const rows: UsageRow[] = [];
	for (const [i, line] of stdout.split("\n").entries()) {
		if (line.trim() === "") continue;
		const cols = line.replace(/\r$/, "").split("\t");
		const [group, limit, pct, time] = cols;
		if (cols.length !== 4 || group === undefined || limit === undefined || pct === undefined || time === undefined) {
			return `${i + 1}번째 줄 칸 수`;
		}
		const match = /^(\d{1,3}(?:\.\d+)?)%$/.exec(pct.trim());
		if (match?.[1] === undefined) return `${i + 1}번째 줄 남은 %`;
		const resetsAt = Date.parse(time.trim());
		rows.push({
			label: group,
			window: /five hour/i.test(limit) ? "5h" : /weekly/i.test(limit) ? "weekly" : "other",
			windowLabel: limit,
			remainingPct: clampPct(Math.round(Number(match[1]))),
			...(Number.isNaN(resetsAt) ? {} : { resetsAt }),
		});
	}
	return rows.length === 0 ? "빈 출력" : rows;
}

function clampPct(pct: number): number {
	return Math.min(100, Math.max(0, pct));
}

/** `warn` under 20% remaining, `danger` under 5%; serialized into the page script, so it stays self-contained. */
export function usageLevel(remainingPct: number): "ok" | "warn" | "danger" {
	return remainingPct < 5 ? "danger" : remainingPct < 20 ? "warn" : "ok";
}

/** Time until a reset as `1h46m`, `4d6h`, `12m`; empty once it has passed. Self-contained for the page script. */
export function resetIn(resetsAt: number | undefined, now: number): string {
	if (resetsAt === undefined || resetsAt <= now) return "";
	const minutes = Math.floor((resetsAt - now) / 60_000);
	const hours = Math.floor(minutes / 60);
	if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
	return hours >= 1 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

function clean(error: string): string {
	return redact(error).replace(/\s+/g, " ").trim().slice(0, ERROR_CHARS);
}
