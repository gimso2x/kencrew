import { describe, expect, test } from "bun:test";
import { CARD_TONE_COLORS, MAX_CARDS, splitCards, tableToAscii, validateCard } from "../src/channel/card";

const el = (type: string, props: Record<string, unknown> = {}, children: string[] = []) => ({ type, props, children });
const spec = (elements: Record<string, unknown>, root = "c"): string => JSON.stringify({ root, elements });
const fence = (json: string): string => `\`\`\`card\n${json}\n\`\`\``;
const FIELDS = spec({
	c: el("Card", { title: "요약" }, ["f"]),
	f: el("Fields", {}, ["a", "b"]),
	a: el("Field", { label: "성공", value: "12" }),
	b: el("Field", { label: "실패", value: 1 }),
});

describe("validateCard", () => {
	test("root Card tone: a palette value is kept; an unknown one is ignored without an issue", () => {
		const toned = (tone: unknown) =>
			spec({
				c: el("Card", { title: "요약", tone }, ["f"]),
				f: el("Fields", {}, ["a"]),
				a: el("Field", { label: "x", value: "1" }),
			});
		for (const tone of ["ok", "warn", "danger", "info"] as const) {
			const validated = validateCard(toned(tone));
			expect(validated.ok && validated.tone).toBe(tone);
		}
		expect(CARD_TONE_COLORS).toEqual({ ok: "#2EB67D", warn: "#ECB22E", danger: "#E01E5A", info: "#36C5F0" });
		for (const tone of ["purple", 3, null]) {
			const validated = validateCard(toned(tone));
			expect(validated.ok).toBe(true);
			expect("tone" in validated).toBe(false);
		}
		expect(validateCard(FIELDS)).toEqual({ ok: true, card: expect.anything() });
		expect("tone" in validateCard(FIELDS)).toBe(false);
	});

	test("elements without children or props, and a spec without root but one Card, are repaired and validate", () => {
		const bare = JSON.stringify({
			root: "c",
			elements: {
				c: { type: "Card", props: { title: "요약" }, children: ["d", "t"] },
				d: { type: "Divider" },
				t: { type: "Text", props: { content: "본문" } },
			},
		});
		expect(validateCard(bare)).toMatchObject({ ok: true });
		const rootless = JSON.stringify({
			elements: { box: { type: "Card", props: { title: "제목" }, children: ["t"] }, t: el("Text", { content: "x" }) },
		});
		expect(validateCard(rootless)).toMatchObject({ ok: true, card: { title: "제목" } });
		const twoCards = JSON.stringify({ elements: { a: el("Card", { title: "a" }), b: el("Card", { title: "b" }) } });
		expect(validateCard(twoCards).ok).toBe(false);
	});

	test("one closing bracket too many after a whole spec is dropped; other trailing text still fails", () => {
		expect(validateCard(`${FIELDS}}`)).toMatchObject({ ok: true, card: { title: "요약" } });
		expect(validateCard(`${FIELDS} }\n]`)).toMatchObject({ ok: true });
		const braceInString = spec({ c: el("Card", { title: "a}b" }, ["t"]), t: el("Text", { content: "{" }) });
		expect(validateCard(`${braceInString}}`)).toMatchObject({ ok: true, card: { title: "a}b" } });
		expect(validateCard(`${FIELDS} 끝`).ok).toBe(false);
		expect(validateCard(`${FIELDS}{}`).ok).toBe(false);
	});

	test("root Text, unknown component, bad JSON, Button and two tables each fail with issues and never throw", () => {
		const table = el("Table", { headers: ["a"], rows: [["1"]] });
		const cases = {
			rootText: spec({ t: el("Text", { content: "x" }) }, "t"),
			unknown: spec({ c: el("Card", {}, ["x"]), x: el("Gauge", { value: 3 }) }),
			badJson: '{"root":"c","elements":{',
			button: spec({ c: el("Card", {}, ["a"]), a: el("Actions", {}, ["b"]), b: el("Button", { id: "x", label: "y" }) }),
			twoTables: spec({ c: el("Card", {}, ["t1", "t2"]), t1: table, t2: table }),
		};
		for (const json of Object.values(cases)) {
			const validated = validateCard(json);
			expect(validated.ok).toBe(false);
			if (!validated.ok) expect(validated.issues.length).toBeGreaterThan(0);
		}
	});

	test("an element id __proto__, constructor or prototype is refused with an issue naming it", () => {
		for (const id of ["__proto__", "constructor", "prototype"]) {
			const json = `{"root":"c","elements":{"c":{"type":"Card","props":{"title":"오염"},"children":["${id}"]},"${id}":{"type":"Text","props":{"content":"x"},"children":[]}}}`;
			const validated = validateCard(json);
			expect(validated.ok).toBe(false);
			if (!validated.ok) expect(validated.issues.join(" ")).toContain(id);
		}
		const asRoot = `{"root":"constructor","elements":{"constructor":{"type":"Card","props":{"title":"x"},"children":[]}}}`;
		expect(validateCard(asRoot).ok).toBe(false);
	});

	test("K-16: a too-long chart label is reported in UTF-16 units, not characters", () => {
		const label = "😀".repeat(11);
		const result = validateCard(
			spec({
				c: el("Card", {}, ["p"]),
				p: el("Chart", { title: "t", chart: { type: "pie", segments: [{ label, value: 1 }] } }),
			}),
		);
		expect(result.ok).toBe(false);
		const issues = result.ok ? [] : result.issues;
		expect(issues.some((issue) => issue.includes("UTF-16"))).toBe(true);
		expect(issues.some((issue) => /\bcharacters\b/.test(issue))).toBe(false);
	});
});

describe("splitCards", () => {
	test("segments join back to the body; fences elsewhere, unclosed fences and cards past the cap stay text", () => {
		const bodies = [
			`앞\n${fence(FIELDS)}\n뒤`,
			`\`\`\`md\n${fence(FIELDS)}\n\`\`\`\n끝`,
			`앞\n\`\`\`card\n{"root":"c"`,
			Array.from({ length: MAX_CARDS + 1 }, () => fence(FIELDS)).join("\n\n"),
		];
		for (const body of bodies) {
			const segments = splitCards(body);
			expect(segments.map((s) => (s.kind === "text" ? s.text : s.raw)).join("\n")).toBe(body);
		}
		expect(splitCards(bodies[0] ?? "").map((s) => s.kind)).toEqual(["text", "card", "text"]);
		expect(splitCards(bodies[1] ?? "").map((s) => s.kind)).toEqual(["text"]);
		expect(splitCards(bodies[2] ?? "").map((s) => s.kind)).toEqual(["text"]);
		expect(splitCards(bodies[3] ?? "").filter((s) => s.kind === "card")).toHaveLength(MAX_CARDS);
	});

	test("K-10: a 4-backtick fence closes only on 4+ backticks, so a card fence after it is a card", () => {
		const kinds = splitCards("````md\nhello\n````\n```card\n{}\n```\n").map((s) => s.kind);
		expect(kinds).toEqual(["text", "card", "text"]);
		const inside = splitCards("````md\n```card\n{}\n```\n````").map((s) => s.kind);
		expect(inside).toEqual(["text"]);
	});
});

describe("tableToAscii", () => {
	test("K-11: pads by display width, so Hangul columns line up", () => {
		const lines = tableToAscii({
			headers: ["이름", "n"],
			rows: [
				["가나다라", "1"],
				["ab", "2"],
			],
		}).split("\n");
		const bar = (line: string): number => {
			let width = 0;
			for (const ch of line.slice(0, line.indexOf(" | "))) width += /[\uac00-\ud7a3]/.test(ch) ? 2 : 1;
			return width;
		};
		expect(lines.map(bar)).toEqual([8, 8, 8]);
	});

	test("rule option inserts a -+- separator under the header while default stays unchanged", () => {
		const table = {
			headers: ["도구", "횟수"],
			rows: [
				["bash", "10"],
				["읽기", "7"],
			],
		};
		expect(tableToAscii(table)).toBe("도구 | 횟수\nbash | 10\n읽기 | 7");
		expect(tableToAscii(table, { rule: true })).toBe("도구 | 횟수\n-----+-----\nbash | 10\n읽기 | 7");
	});
});
