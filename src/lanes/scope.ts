import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { redact } from "../redact";
import { laneChangedFiles } from "./changes";
import type { LaneLeftover, LaneRow } from "./status";
import type { GitRunner } from "./verify";
import type { LaneCheck } from "./worktree";

/**
 * The scope and leftovers of a work lane (doc/plans/bot-org-risk-gates.md 단계 2): the start names the paths the lane
 * may change, the close lists every file the claim commit changed and keeps the ones outside, and the claim names what
 * it left undone. `laneLandBlockers` holds the auto-merge on either; a landing writes the non-blocking leftovers to the
 * follow-up ledger.
 */

const SCOPE_PATTERNS_MAX = 50;
const SCOPE_PATTERN_CHARS = 200;
/** Paths kept in `meta.scopeViolations`. */
export const SCOPE_VIOLATIONS_MAX = 20;
const SCOPE_ERROR_CHARS = 200;
export const LEFTOVERS_MAX = 20;
export const LEFTOVER_CHARS = 200;

/** `ompbot_work_start` `scope`: repository-relative globs (`src/lanes/**`); absent or empty = no scope check. */
export function parseLaneScope(raw: unknown): LaneCheck<string[]> {
	if (raw === undefined) return { ok: true, value: [] };
	if (!Array.isArray(raw) || raw.length > SCOPE_PATTERNS_MAX) {
		return { ok: false, problem: `scope는 글롭 문자열 배열이어야 합니다(최대 ${SCOPE_PATTERNS_MAX}개)` };
	}
	const value: string[] = [];
	for (const [index, item] of raw.entries()) {
		const pattern = typeof item === "string" ? item.trim().replace(/^\.\//, "") : "";
		if (pattern === "" || pattern.length > SCOPE_PATTERN_CHARS || pattern.startsWith("/")) {
			return {
				ok: false,
				problem: `scope[${index}]는 저장소 기준 상대 글롭이어야 합니다(비어 있지 않고 ${SCOPE_PATTERN_CHARS}자 이하)`,
			};
		}
		value.push(pattern);
	}
	return { ok: true, value };
}

/** `ompbot_claim_done` `leftovers`: `[{text, blocking}]`, at most 20, each text redacted and cut to 200 characters. */
export function parseLaneLeftovers(raw: unknown): LaneCheck<LaneLeftover[]> {
	if (raw === undefined) return { ok: true, value: [] };
	const problem = `leftovers는 {text: 문자열, blocking: 참/거짓} 배열이어야 합니다(최대 ${LEFTOVERS_MAX}개)`;
	if (!Array.isArray(raw) || raw.length > LEFTOVERS_MAX) return { ok: false, problem };
	const value: LaneLeftover[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) return { ok: false, problem };
		const { text, blocking } = item as Record<string, unknown>;
		if (typeof text !== "string" || typeof blocking !== "boolean") return { ok: false, problem };
		const shown = redact(text.replace(/\s+/g, " ").trim()).slice(0, LEFTOVER_CHARS);
		if (shown === "") return { ok: false, problem };
		value.push({ text: shown, blocking });
	}
	return { ok: true, value };
}

/** The paths of `files` no glob of `scope` matches (all of them, in order). */
export function outsideScope(files: readonly string[], scope: readonly string[]): string[] {
	const globs = scope.map((pattern) => new Bun.Glob(pattern));
	return files.filter((file) => !globs.some((glob) => glob.match(file)));
}

export type LaneScopeResult = { scopeViolations?: string[]; scopeError?: string };

/**
 * The scope check of a closing lane at its claim commit: the meta patch to record (both keys present, one or both
 * undefined). A lane without a scope gets neither; a git failure is `scopeError`, never a pass.
 */
export async function checkLaneScope(lane: LaneRow, sha: string, git?: GitRunner): Promise<LaneScopeResult> {
	const { scope, repo, baseBranch } = lane.meta;
	if (scope === undefined || scope.length === 0) return { scopeViolations: undefined, scopeError: undefined };
	if (repo === undefined || baseBranch === undefined) {
		return { scopeViolations: undefined, scopeError: "레인에 worktree가 없음" };
	}
	try {
		const outside = outsideScope(await laneChangedFiles(repo, baseBranch, sha, git), scope);
		return {
			scopeViolations: outside.length === 0 ? undefined : outside.slice(0, SCOPE_VIOLATIONS_MAX).map((p) => redact(p)),
			scopeError: undefined,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { scopeViolations: undefined, scopeError: redact(reason).slice(0, SCOPE_ERROR_CHARS) };
	}
}

/** One line of `$OMPBOT_HOME/followups.jsonl`: a non-blocking leftover of a lane that was merged. */
export interface FollowupRecord {
	at: number;
	laneId: string;
	title: string;
	repo: string;
	sha: string;
	text: string;
}

const followupKey = (record: Pick<FollowupRecord, "laneId" | "sha" | "text">): string =>
	JSON.stringify([record.laneId, record.sha, record.text]);

/**
 * Appends the merged lane's non-blocking leftovers to the follow-up ledger `file`, skipping any already there (key
 * laneId + sha + text: a landing run again writes nothing twice). Returns how many lines it wrote.
 */
export function appendFollowups(file: string, lane: LaneRow, at: number): number {
	const items = (lane.meta.leftovers ?? []).filter((item) => !item.blocking);
	const sha = lane.meta.sha;
	if (items.length === 0 || sha === undefined) return 0;
	const seen = new Set<string>();
	if (existsSync(file)) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				seen.add(followupKey(JSON.parse(line) as FollowupRecord));
			} catch {
				// A torn or foreign line keys nothing; the ledger is append-only and never rewritten here.
			}
		}
	}
	const laneId = lane.meta.laneId ?? lane.name;
	const lines: string[] = [];
	for (const item of items) {
		const record: FollowupRecord = {
			at,
			laneId,
			title: lane.title,
			repo: lane.meta.repo ?? lane.cwd,
			sha,
			text: item.text,
		};
		const key = followupKey(record);
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push(JSON.stringify(record));
	}
	if (lines.length > 0) appendFileSync(file, `${lines.join("\n")}\n`);
	return lines.length;
}
