import { describe, expect, test } from "bun:test";
import { chunkText, cutCodePointSafe } from "../src/channel/text";

describe("chunkText qa-i low", () => {
	test("a CRLF body's closing fence is recognised, so prose after it is not wrapped as code", () => {
		const body = ["```js", "a();", "```", ...Array.from({ length: 30 }, (_, i) => `산문 ${i} ${"가".repeat(20)}`)].join(
			"\r\n",
		);
		const chunks = chunkText(body, 200);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks.slice(1)) {
			expect(chunk.startsWith("```")).toBe(false);
			expect(chunk.endsWith("```")).toBe(false);
		}
	});
});

describe("chunkText qa-l", () => {
	test("a 20-backtick fence cut across chunks is closed and reopened with 20 backticks, and prose after it stays prose (qa-l #23, #54)", () => {
		const fence = "`".repeat(20);
		const code = Array.from({ length: 12 }, (_, i) => `code ${i} ${"x".repeat(30)}`);
		const prose = Array.from({ length: 12 }, (_, i) => `산문 ${i} ${"가".repeat(20)}`);
		const chunks = chunkText([fence, ...code, fence, ...prose].join("\n"), 200);
		const proseStart = chunks.findIndex((chunk) => chunk.includes("산문 0"));
		expect(proseStart).toBeGreaterThan(1);
		for (const chunk of chunks.slice(0, proseStart)) {
			expect(chunk.startsWith(fence)).toBe(true);
		}
		for (const chunk of chunks.slice(proseStart + (chunks[proseStart]?.startsWith(fence) ? 1 : 0))) {
			expect(chunk.startsWith("`")).toBe(false);
			expect(chunk.endsWith("`")).toBe(false);
		}
		expect(chunks[1]?.startsWith(fence)).toBe(true);
	});
});

describe("cutCodePointSafe qa-l", () => {
	test("a negative or zero limit gives the empty string, never a cut from the end (qa-l #61)", () => {
		expect(cutCodePointSafe("abcdef", -3)).toBe("");
		expect(cutCodePointSafe("abcdef", 0)).toBe("");
		expect(cutCodePointSafe("abcdef", 3)).toBe("abc");
	});
});
