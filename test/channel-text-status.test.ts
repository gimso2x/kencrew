import { describe, expect, test } from "bun:test";
import { progressLine, runningStatusText, STALL_STATUS_TEXT } from "../src/channel/text";

const recent = ["read path=a.ts", "bash command=bun test", "edit path=b.ts"];

describe("runningStatusText", () => {
	test("tool count, todo done/total and current item, steers, retries, the last 3 tools; zero lines left out", () => {
		expect(
			runningStatusText(false, 15_000, {
				tools: 7,
				recentTools: recent,
				todo: { done: 3, total: 7, current: "진행 카드 렌더" },
				steers: 2,
				retries: 1,
			}),
		).toBe(
			[
				"⏳ 작업 중 · 00:15 · 도구 7회",
				"📋 3/7 · 진행 카드 렌더",
				"📨 추가 메시지 2건 반영",
				"🔁 모델 재시도 1회",
				"· read path=a.ts",
				"· bash command=bun test",
				"· edit path=b.ts",
			].join("\n"),
		);
		expect(
			runningStatusText(false, 30_000, {
				tools: 8,
				recentTools: recent,
				todo: { done: 0, total: 0 },
				steers: 0,
				retries: 0,
			}),
		).toBe(["⏳ 작업 중 · 00:30 · 도구 8회", ...recent.map((t) => `· ${t}`)].join("\n"));
	});

	test("stalled: the stall text leads and the progress lines stay", () => {
		expect(runningStatusText(true, 45_000, { tools: 8, recentTools: recent, steers: 0, retries: 0 })).toBe(
			[`${STALL_STATUS_TEXT} · 00:45`, ...recent.map((t) => `· ${t}`)].join("\n"),
		);
	});

	test("each progress line is one line of at most 60 characters", () => {
		const text = runningStatusText(false, 15_000, {
			tools: 1,
			recentTools: [`bash command=${"x".repeat(100)}\nrm -rf /`],
			todo: { done: 1, total: 2, current: "둘째\n줄" },
			steers: 0,
			retries: 0,
		});
		expect(text.split("\n")).toEqual([
			"⏳ 작업 중 · 00:15 · 도구 1회",
			"📋 1/2 · 둘째 줄",
			`· bash command=${"x".repeat(47)}`,
		]);
	});
});

describe("progressLine", () => {
	test("never ends in a lone high surrogate", () => {
		const line = progressLine(`${"a".repeat(59)}😀`);
		expect(line).toBe("a".repeat(59));
	});
});
