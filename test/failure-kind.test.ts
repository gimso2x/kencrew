import { describe, expect, test } from "bun:test";
import { classifyFailure, formatResetHint, PROVIDER_LIMIT } from "../src/core/failure-kind";
import { isProviderLimit } from "../src/core/mailbox";

describe("classifyFailure", () => {
	test("provider_limit: zai 429 with reset timestamp extracts kind and resetAt", () => {
		const res = classifyFailure("429 Usage limit reached for 5 hour. Your limit will reset at 2026-11-20 12:15:02");
		expect(res).toEqual({ kind: "provider_limit", resetAt: "2026-11-20 12:15:02" });
		expect(formatResetHint(res.resetAt ?? "")).toBe("12:15 이후");
	});

	test("provider_limit: resets in <duration> keeps '<기간> 뒤' text verbatim", () => {
		const res = classifyFailure("Rate-limit exceeded, resets in 1h 30m");
		expect(res).toEqual({ kind: "provider_limit", resetAt: "1h 30m 뒤" });
		expect(formatResetHint(res.resetAt ?? "")).toBe("1h 30m 뒤");
	});

	test("provider_limit: too many requests and rate-limit classify as provider_limit before transient", () => {
		for (const msg of [
			"Too Many Requests",
			"HTTP rate-limit error",
			"429 Too Many Requests",
			"usage_limit reached",
			"You exceeded your quota",
			"Limit Exhausted",
		]) {
			expect(classifyFailure(msg).kind).toBe("provider_limit");
			expect(PROVIDER_LIMIT.test(msg)).toBe(true);
			expect(isProviderLimit(msg)).toBe(true);
		}
	});

	test("provider_limit: ISO reset timestamp formats HH:MM 이후", () => {
		const res = classifyFailure("429 rate limit, resets at 2026-11-20T09:45:10Z");
		expect(res).toEqual({ kind: "provider_limit", resetAt: "2026-11-20T09:45:10Z" });
		expect(formatResetHint(res.resetAt ?? "")).toBe("09:45 이후");
	});

	test("context_overflow: Anthropic prompt is too long and other context window errors", () => {
		for (const msg of [
			"prompt is too long: 215000 tokens > 200000 maximum",
			"This model's maximum context length is 128000 tokens",
			"context_length_exceeded",
			"Exceeds context window size",
			"Too many tokens in input",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "context_overflow" });
		}
	});

	test("auth: 401, 403, unauthorized, invalid api key, authentication", () => {
		for (const msg of [
			"401 invalid api key",
			"403 Forbidden",
			"Request failed: Unauthorized",
			"authentication_error: bad credentials",
			"invalid_api_key provided",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "auth" });
		}
	});

	test("transient: socket hang up, ECONNRESET, timeouts, 502/503/504 reuse stuck TRANSIENT", () => {
		for (const msg of [
			"socket hang up",
			"read ECONNRESET",
			"Request timed out after 30s",
			"502 Bad Gateway",
			"503 Service Unavailable",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "transient" });
		}
	});

	test("unknown: unrelated messages fall back to unknown", () => {
		for (const msg of [
			"boom",
			"omp_executable_missing",
			"error 14290",
			"port 4010 already in use",
			"무관한 오류 문장입니다",
			"",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "unknown" });
		}
	});
});
