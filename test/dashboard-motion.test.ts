import { describe, expect, test } from "bun:test";
import {
	expireStack,
	freshCards,
	freshSteps,
	pillMotion,
	pushStack,
	renderDashboardPage,
	rollDiff,
	rollEffects,
	rollLabel,
	type StackCard,
	stackHtml,
} from "../src/dashboard/html";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { STYLE } from "../src/dashboard/style";

const off = { ok: false as const, error: "not in this test" };
const EMPTY: DashboardSnapshot = {
	generatedAt: "2026-11-16T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		ompVersion: "1",
		origins: 1,
		busy: 0,
		ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0, uncertain: 0 },
		monitors: { count: 0, next: null },
		openGates: [{ name: "g", since: "2026-11-16T09:00:00+09:00" } as never],
	},
	turns: off,
	tasks: { ok: true, items: [] },
	lanes: off,
	herdr: { ok: true, hosts: [] },
	approvals: off,
	monitors: off,
	alerts: off,
	gates: off,
	backup: off,
	jobs: off,
};

describe("header number roll", () => {
	test("AC-2: the first draw changes nothing, later draws name the changed keys with their step", () => {
		const first = rollDiff(new Map(), [{ key: "gate", value: 1 }]);
		expect(first.changes).toEqual([]);
		expect([...first.next]).toEqual([["gate", 1]]);
		const next = rollDiff(first.next, [
			{ key: "gate", value: 3 },
			{ key: "lim:x:5h", value: 40 },
		]);
		expect(next.changes).toEqual([{ key: "gate", from: 1, to: 3, delta: 2 }]);
		expect(rollDiff(next.next, [{ key: "gate", value: 3 }]).changes).toEqual([]);
	});

	test("AC-2: the step reads +n or −n and is bad in the direction the key names", () => {
		const up = { key: "gate", from: 1, to: 3, delta: 2 };
		const down = { key: "lim", from: 50, to: 40, delta: -10 };
		expect(rollLabel(up, "up")).toEqual({ text: "+2", tone: "bad" });
		expect(rollLabel(down, "down")).toEqual({ text: "−10", tone: "bad" });
		expect(rollLabel(down, "up")).toEqual({ text: "−10", tone: "good" });
		expect(rollLabel(up, undefined).tone).toBe("good");
	});

	test("AC-3: with reduced motion no effect is played, so the final numbers stay", () => {
		const changes = [{ key: "gate", from: 1, to: 3, delta: 2 }];
		expect(rollEffects(changes, true)).toEqual([]);
		expect(rollEffects(changes, false)).toEqual(changes);
	});
});

describe("event stack", () => {
	const row = (id: string, col: string) => ({ id, kind: "card" as const, col, title: `제목 ${id}` });

	test("AC-2: the first draw and the read marks' first visit give no card; later draws give new and moved cards", () => {
		expect(freshCards(new Map(), [row("a", "working")], false).cards).toEqual([]);
		const prev = new Map([["a", "working"]]);
		expect(freshCards(prev, [row("a", "working"), row("b", "wait")], true).cards).toEqual([]);
		const got = freshCards(prev, [row("a", "attention"), row("b", "wait")], false);
		expect(got.cards.map((card) => [card.id, card.why])).toEqual([
			["a", "moved"],
			["b", "new"],
		]);
		expect([...got.next]).toEqual([
			["a", "attention"],
			["b", "wait"],
		]);
		expect(freshCards(got.next, [row("a", "attention"), row("b", "wait")], false).cards).toEqual([]);
	});

	test("AC-2: newest first, one card per id, six kept, three drawn", () => {
		let list: StackCard[] = [];
		for (let i = 0; i < 8; i++) {
			list = pushStack(list, [{ ...row(`c${i}`, "wait"), why: "new" }], 1000 + i);
		}
		expect(list.map((card) => card.id)).toEqual(["c7", "c6", "c5", "c4", "c3", "c2"]);
		list = pushStack(list, [{ ...row("c4", "attention"), why: "moved" }], 2000);
		expect(list.map((card) => card.id).slice(0, 2)).toEqual(["c4", "c7"]);
		expect(list.length).toBe(6);
		const out = stackHtml(list);
		expect(out.html.match(/class="es-card/g)?.length).toBe(3);
		expect(out.say).toContain("상태 바뀜: 제목 c4 외 5건");
	});

	test("AC-2: a card title is escaped and links to its detail", () => {
		const out = stackHtml([{ id: "k/1", kind: "card", col: "attention", title: "<img src=x>", why: "new", at: 1 }]);
		expect(out.html).not.toContain("<img");
		expect(out.html).toContain('href="?card=k%2F1"');
		expect(out.html).toContain('data-card="k/1"');
		expect(stackHtml([]).html).toBe("");
	});

	test("AC-2: the oldest card goes after 6 s untouched, one at a time; touch delays it", () => {
		const list: StackCard[] = [
			{ id: "new", kind: "card", col: "wait", title: "n", why: "new", at: 10_000 },
			{ id: "old", kind: "card", col: "wait", title: "o", why: "new", at: 1_000 },
		];
		expect(expireStack(list, 6_999, 0, 6_000, false)).toBe(list);
		expect(expireStack(list, 7_000, 0, 6_000, false).map((card) => card.id)).toEqual(["new"]);
		expect(expireStack(list, 7_000, 5_000, 6_000, false)).toBe(list);
	});

	test("AC-3: with reduced motion the cards stay until they are closed", () => {
		const list: StackCard[] = [{ id: "a", kind: "card", col: "wait", title: "a", why: "new", at: 0 }];
		expect(expireStack(list, 999_999, 0, 6_000, true)).toBe(list);
	});

	test("AC-2: #event-stack is a direct child of body, outside #main, beside the toast", () => {
		const page = renderDashboardPage(EMPTY);
		const stackAt = page.indexOf('id="event-stack"');
		expect(stackAt).toBeGreaterThan(0);
		const mainOpen = page.indexOf('id="main"');
		const search = page.indexOf('<div class="search">');
		expect(stackAt).toBeGreaterThan(search);
		expect(mainOpen).toBeLessThan(search);
		expect(page.indexOf('id="toast"')).toBeLessThan(stackAt);
		expect(page.slice(stackAt - 5, stackAt)).toBe("<div ");
		expect(page).toContain('aria-live="polite"');
	});
});

describe("state pill and live steps", () => {
	test("AC-2: a pill checks when the new status is done, shakes when failed, and is plain otherwise", () => {
		expect(pillMotion(undefined, "wait:done:")).toBe("");
		expect(pillMotion("wait:done:", "wait:done:")).toBe("");
		expect(pillMotion("working:working:", "wait:done:")).toBe("ok");
		expect(pillMotion("working::working", "wait::done-claimed")).toBe("ok");
		expect(pillMotion("working:working:", "attention:failed:")).toBe("bad");
		expect(pillMotion("working:working:", "attention:blocked:")).toBe("");
	});

	test("AC-2: the first look at a block pops nothing; a step seen before never pops again", () => {
		const a = { name: "read", summary: "x", ms: 10, failed: false };
		const b = { name: "read", summary: "x", ms: 10, failed: false };
		const first = freshSteps(null, [a]);
		expect(first.fresh).toEqual([]);
		const next = freshSteps(new Set(first.keys), [a, b]);
		expect(next.fresh).toEqual([1]);
		expect(new Set(next.keys).size).toBe(2);
		expect(freshSteps(new Set(next.keys), [a, b]).fresh).toEqual([]);
	});
});

describe("reduced motion", () => {
	const script = /<script>([\s\S]*?)<\/script>/.exec(renderDashboardPage(EMPTY))?.[1] ?? "";

	test("AC-3: the global reduced-motion rule stops animations and transitions, and the new keyframes sit outside it", () => {
		const block = STYLE.slice(STYLE.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(block).toContain("animation-duration: 0s !important");
		expect(block).toContain("transition-duration: 0s !important");
		for (const name of ["pill-draw", "pill-pop", "pill-shake", "step-pop", "step-shimmer", "roll-delta", "es-in"]) {
			expect(STYLE).toContain(`@keyframes ${name}`);
			expect(block).not.toContain(`@keyframes ${name}`);
		}
		expect(STYLE).toContain("--ease-spring: cubic-bezier(0.34, 1.4, 0.64, 1)");
	});

	test("AC-3: the page script asks matchMedia before rolling, popping or timing the stack", () => {
		expect(script).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
		expect(script).toContain("rollEffects(result.changes, reducedMotion())");
		expect(script).toContain("expireStack(stack, now, Math.max(stackTouched, stackDropped), 6000, reducedMotion())");
		expect(script).toContain("if (!reducedMotion()) for (const i of result.fresh)");
	});
});

describe("header numbers carry roll keys", () => {
	test("AC-2: the gate count is a data-roll cell with its value and bad direction", () => {
		const page = renderDashboardPage(EMPTY);
		expect(page).toContain('data-roll="gate" data-roll-v="1" data-roll-bad="up"');
	});
});
