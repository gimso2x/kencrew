/*
 * Turn failure reason classification (`doc/plans/turn-failure-kinds.md`).
 * Pure functions: no clock, no I/O. `provider_limit` is checked before `transient` because `TRANSIENT` in
 * `stuck.ts` also matches 429 / rate-limit / too many requests.
 */

import { TRANSIENT } from "./stuck";

export type FailureKind = "provider_limit" | "context_overflow" | "auth" | "transient" | "unknown";

export interface FailureClassification {
	kind: FailureKind;
	/** Raw extracted reset moment (e.g. `"2026-11-20 12:15:02"`) or relative text (`"<기간> 뒤"`), only for `provider_limit`. */
	resetAt?: string;
}

/** Provider usage/rate limits (429, rate-limit, too many requests, usage limit, quota). */
export const PROVIDER_LIMIT =
	/\b429\b|rate[\s_-]?limit|too\s+many\s+requests|usage[\s_-]?limit|limit\s+exhausted|quota/i;

const CONTEXT_OVERFLOW =
	/context[\s_-]?(?:length|window)|maximum\s+context|prompt\s+is\s+too\s+long|too\s+many\s+tokens/i;

const AUTH_ERROR = /\b401\b|\b403\b|unauthorized|unauthenticated|invalid[\s_-]?api[\s_-]?key|authentication/i;

const RESET_AT_PATTERN =
	/resets?\s+at\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}:\d{2}(?::\d{2})?)/i;

const RESET_IN_PATTERN =
	/resets?\s+in\s+(\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)(?:(?:\s*,?\s*and\s+|\s*)\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))*)/i;

const RESET_HHMM_PATTERN = /(?:^|[\sT])(\d{1,2}:\d{2})(?::\d{2})?/;

/** Extracts a raw reset timestamp or `"<duration> 뒤"` phrase when present. */
export function extractResetAt(reason: string): string | undefined {
	const atMatch = RESET_AT_PATTERN.exec(reason);
	if (atMatch?.[1] !== undefined) return atMatch[1];
	const inMatch = RESET_IN_PATTERN.exec(reason);
	if (inMatch?.[1] !== undefined) return `${inMatch[1].trim()} 뒤`;
	return undefined;
}

/** Formats an extracted reset value into the notice phrase (`"HH:MM 이후"` or `"<기간> 뒤"`). */
export function formatResetHint(resetAt: string): string {
	if (resetAt.endsWith(" 뒤")) return resetAt;
	const hhmm = RESET_HHMM_PATTERN.exec(resetAt)?.[1];
	return `${hhmm ?? resetAt} 이후`;
}

/** Classifies a turn failure reason into one of the five failure kinds. */
export function classifyFailure(reason: string): FailureClassification {
	if (PROVIDER_LIMIT.test(reason)) {
		const resetAt = extractResetAt(reason);
		return resetAt === undefined ? { kind: "provider_limit" } : { kind: "provider_limit", resetAt };
	}
	if (CONTEXT_OVERFLOW.test(reason)) return { kind: "context_overflow" };
	if (AUTH_ERROR.test(reason)) return { kind: "auth" };
	if (TRANSIENT.test(reason)) return { kind: "transient" };
	return { kind: "unknown" };
}
