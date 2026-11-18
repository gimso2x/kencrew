import { describe, expect, test } from "bun:test";
import { MARKDOWN_CHUNK_LIMIT, renderMarkdownParts, toMrkdwn } from "../src/slack/format";

describe("toMrkdwn qa-i low", () => {
	test("a link URL with balanced parentheses stays one link", () => {
		expect(toMrkdwn("[위키](https://ko.wikipedia.org/wiki/Foo_(bar))")).toBe(
			"<https://ko.wikipedia.org/wiki/Foo_(bar)|위키>",
		);
		expect(toMrkdwn("see [doc](https://x.test/a_(b)) now")).toBe("see <https://x.test/a_(b)|doc> now");
		expect(toMrkdwn("[a](https://x.test/p) (b)")).toBe("<https://x.test/p|a> (b)");
	});

	test("a table cell with a triple-backtick span still renders as one table", () => {
		const out = toMrkdwn("| a | b |\n| --- | --- |\n| ```x``` | y |");
		expect(out).toBe("```\n| a       | b   |\n| ------- | --- |\n| `\u200b`\u200b`x`\u200b`\u200b` | y   |\n```");
	});

	test("an unpaired triple backtick in a table cell does not break the table", () => {
		const out = toMrkdwn("| 문법 | 뜻 |\n| --- | --- |\n| ```js | js 코드 |\n\n뒤 본문");
		expect(out.startsWith("```\n| 문법")).toBe(true);
		expect(out).toContain("| `\u200b`\u200b`js");
		expect(out).toContain("```\n\n뒤 본문");
	});
});

describe("renderMarkdownParts qa-i low", () => {
	test("mention expansion after chunking keeps every markdown block within Slack's 12,000", () => {
		const names = { ownerUserId: "", peerBots: [{ userId: "U0123ABCD", name: "아주아주긴피어이름봇".repeat(3) }] };
		const body = Array.from({ length: 2_000 }, () => "<@U0123ABCD> 확인").join("\n");
		const parts = renderMarkdownParts(body, false, undefined, { names });
		expect(parts).toBeDefined();
		expect(MARKDOWN_CHUNK_LIMIT).toBeLessThan(12_000);
		for (const part of parts ?? []) {
			const block = part.blocks.find((b) => b.type === "markdown") as { text: string } | undefined;
			expect(block?.text.length).toBeLessThanOrEqual(12_000);
		}
	});
});

describe("toMrkdwn qa-l", () => {
	test("a link with nested square brackets in the label or nested parentheses in the url converts (qa-l #56)", () => {
		expect(toMrkdwn("[API [v2] 문서](https://x.test/p)")).toBe("<https://x.test/p|API [v2] 문서>");
		expect(toMrkdwn("[a](https://x.test/a_(b_(c)))")).toBe("<https://x.test/a_(b_(c))|a>");
		expect(toMrkdwn("[a](https://x.test/1) and [b](https://x.test/2)")).toBe(
			"<https://x.test/1|a> and <https://x.test/2|b>",
		);
		expect(toMrkdwn("[unclosed](https://x.test/a_(b")).toBe("[unclosed](https://x.test/a_(b");
	});
});

describe("table cell pipe (qa-q #17)", () => {
	test("a cell holding an escaped pipe stays one cell and shows as `a \\| b`", () => {
		const out = toMrkdwn("| h1 | h2 |\n|---|---|\n| a \\| b | c |\n");
		const rows = out.split("\n").filter((line) => line.startsWith("|") && !line.includes("---"));
		expect(rows).toHaveLength(2);
		expect(rows[1]).toBe("| a \\| b | c   |");
		expect(rows[0]).toBe("| h1     | h2  |");
	});

	test("qa-r #4: a table cell with a fence line cannot close the table fence in the body", () => {
		const out = toMrkdwn("| a | b |\n| --- | --- |\n| ``` | <!here> |");
		const lines = out.split("\n");
		expect(lines[0]).toBe("```");
		expect(lines.at(-1)).toBe("```");
		expect(lines.slice(1, -1).some((line) => line.includes("```"))).toBe(false);
	});
});
