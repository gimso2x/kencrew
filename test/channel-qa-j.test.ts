import { describe, expect, test } from "bun:test";
import { validateCard } from "../src/channel/card";
import { tableSpans } from "../src/channel/text";
import { cardToEmbed, fitEmbed } from "../src/discord/card";
import { renderDiscordParts } from "../src/discord/format";

const el = (type: string, props: Record<string, unknown> = {}, children: string[] = []) => ({ type, props, children });
const spec = (elements: Record<string, unknown>, root = "c"): string => JSON.stringify({ root, elements });
const issues = (json: string): string[] => {
	const checked = validateCard(json);
	return checked.ok ? [] : checked.issues;
};

describe("channel text qa-j", () => {
	test("29: a lone ``` inside prose does not hide the table after it from tableSpans", () => {
		const table = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");
		const spans = tableSpans(`그냥 문장 \`\`\` 하나\n\n${table}`);
		expect(spans).toHaveLength(1);
	});

	test("29: a table inside a real fence is still skipped", () => {
		const table = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");
		expect(tableSpans(`\`\`\`\n${table}\n\`\`\`\n`)).toHaveLength(0);
	});
});

describe("discord qa-j", () => {
	test("30: a CRLF body's closing fence is recognised, so a table after it is fenced", () => {
		const body = ["```js", "a();", "```", "", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\r\n");
		const out = renderDiscordParts(body, false).join("");
		expect(out).toContain("```\r\n\r\n```\n| a | b |");
		expect(out.endsWith("| 1 | 2 |\n```")).toBe(true);
	});

	test("31: a card table cut at 4096 characters closes a longer fence with the same length", () => {
		const rows = Array.from({ length: 99 }, () => ["```", "x".repeat(60)]);
		const card = { type: "card", children: [{ type: "table", headers: ["a", "b"], rows }] } as unknown as Parameters<
			typeof cardToEmbed
		>[0];
		const description = fitEmbed(cardToEmbed(card)).description ?? "";
		expect(description.length).toBeLessThanOrEqual(4096);
		const lines = description.split("\n");
		const fences = lines.filter((line) => /^`{4,}$/.test(line));
		expect(fences).toHaveLength(2);
		expect(lines.at(-1)).toBe("````");
	});
});

describe("validateCard qa-j", () => {
	test("34/75: a card nested 40,000 deep is refused, not thrown", () => {
		const depth = 40_000;
		const elements: Record<string, unknown> = { c: el("Card", { title: "t" }, ["n0"]) };
		for (let i = 0; i < depth; i++) elements[`n${i}`] = el("Section", {}, [`n${i + 1}`]);
		elements[`n${depth}`] = el("Section", {}, []);
		expect(() => validateCard(spec(elements))).not.toThrow();
		expect(validateCard(spec(elements)).ok).toBe(false);
	});

	test("78: children that is not an array of ids is refused", () => {
		const json = spec({ c: { type: "Card", props: { title: "t" }, children: "ab" }, a: el("Text", { text: "A" }) });
		expect(issues(json)).toEqual([expect.stringContaining("children must be an array")]);
	});

	test.each(["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd", "vbscript:x"])(
		"35/77/81: image url %s is refused",
		(url) => {
			const image = spec({ c: el("Card", { title: "t" }, ["i"]), i: el("Image", { url, alt: "x" }) });
			expect(issues(image)).toEqual([expect.stringContaining("must be an http(s) URL")]);
			const cardImage = spec({ c: el("Card", { title: "t", imageUrl: url }, []) });
			expect(issues(cardImage)).toEqual([expect.stringContaining("must be an http(s) URL")]);
		},
	);

	test("35/77/81: an https image url still passes", () => {
		const image = spec({
			c: el("Card", { title: "t", imageUrl: "https://x.test/a.png" }, ["i"]),
			i: el("Image", { url: "https://x.test/b.png", alt: "x" }),
		});
		expect(validateCard(image).ok).toBe(true);
	});
});
