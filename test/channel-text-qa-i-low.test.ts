import { describe, expect, test } from "bun:test";
import { chunkText, cutCodePointSafe } from "../src/channel/text";
import { runBounded } from "./helpers/bounded-child";

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

describe("chunkText limits (qa-q #3, #4)", () => {
	test("a mid-line 16-backtick run on a chunk boundary never pushes a chunk past limit 2000 or 3900", () => {
		for (const limit of [2000, 3900]) {
			for (let pad = 0; pad < 40; pad++) {
				const line = `${"a".repeat(limit - 40 + pad)} ${"`".repeat(16)} ${"b".repeat(60)}`;
				for (const text of [`${line}\n${line}`, `\`\`\`\n${line}\n${line}\n\`\`\``]) {
					for (const chunk of chunkText(text, limit)) expect(chunk.length).toBeLessThanOrEqual(limit);
				}
			}
		}
	});

	test("every limit from 1 to 7 returns, within the limit (a lone code point at 1), emoji and fences included", async () => {
		const result = await runBounded(
			`
			import { chunkText } from "./src/channel/text";
			const inputs = ["abcdef", "😀a😀bc😀", "x\\n\\ny \`\`\`js\\nz\`\`\` w", "\`\`\`\\n" + "😀".repeat(9) + "\\n\`\`\`"];
			const out: string[][][] = [];
			for (let limit = 1; limit <= 7; limit++) out.push(inputs.map((input) => chunkText(input, limit)));
			console.log(JSON.stringify(out));
		`,
			3000,
		);
		expect(result.timedOut).toBe(false);
		const all = JSON.parse(result.stdout) as string[][][];
		expect(all).toHaveLength(7);
		all.forEach((perInput, i) => {
			const limit = i + 1;
			for (const chunks of perInput) {
				expect(chunks.length).toBeGreaterThan(0);
				for (const chunk of chunks) {
					if (limit === 1) expect([...chunk]).toHaveLength(1);
					else expect(chunk.length).toBeLessThanOrEqual(limit);
				}
			}
		});
		expect(all[0]?.[0]).toEqual(["a", "b", "c", "d", "e", "f"]);
	});
});
