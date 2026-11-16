// T-20261116-04 (doc/plans/usage-limits-card.md): the system view's "모델 한도" card from config
// `dashboard.usageLimits`, its parsers, failure isolation and the module-level 15-minute cache.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { renderDashboardMain, renderDashboardPage } from "../src/dashboard/html";
import { buildSnapshot, type DashboardConfig, type SnapshotDeps } from "../src/dashboard/snapshot";
import { assembleSnapshotDeps } from "../src/dashboard/snapshot-assembly";
import {
	clearUsageLimitsCache,
	parseAgy,
	parseOmp,
	readUsageLimits,
	USAGE_LIMITS_TTL_MS,
	type UsageLimitsConfig,
} from "../src/dashboard/usage-limits";
import type { ProcessRunner, RunProcessResult } from "../src/dispatch/omp";

/** 2026-11-16 12:00 KST. */
const NOW = Date.parse("2026-11-16T03:00:00Z");
const EMAIL = "sg*@example.test";

const limit = (id: string, label: string, window: string, used: number, resetsAt?: number) => ({
	id: `p:${id}`,
	label,
	scope: { provider: "p", windowId: window },
	window: { id: window, label: `${window} label`, ...(resetsAt === undefined ? {} : { resetsAt }) },
	amount: { used: used * 100, limit: 100, usedFraction: used, unit: "percent" },
	status: "ok",
});
const report = (provider: string, limits: unknown[]) => ({
	provider,
	limits,
	metadata: { accountId: "3f*", email: EMAIL, orgId: "25*" },
});
const ompJson = (...reports: unknown[]) => JSON.stringify({ generatedAt: NOW, reports });
const anthropic = ompJson(
	report("anthropic", [
		limit("5h", "Claude 5 Hour", "5h", 0.07, NOW + 6_360_000),
		limit("7d", "Claude 7 Day", "7d", 0.69, NOW + 4 * 86_400_000 + 6 * 3_600_000),
		limit("7d:fable", "Claude 7 Day (Fable)", "7d", 0.28, NOW + 86_400_000),
	]),
);
// Window ids as `omp usage --json` printed them on 2026-11-16: Anthropic `5h`/`7d`, Zai `5h`/`1w`/`1mo`.
const zai = ompJson(
	report("zai", [
		limit("5h", "GLM 5 Hour", "5h", 0.97),
		limit("weekly", "GLM Weekly", "1w", 0.85, NOW + 3_600_000),
		limit("mcp", "GLM MCP Monthly", "1mo", 0.1),
	]),
);
const AGY = [
	"Gemini Models\tWeekly Limit Remaining\t65%\t2026-11-20T23:00:32Z",
	"Gemini Models\tFive Hour Limit Remaining\t28%\t2026-11-16T03:16:53Z",
	"Claude and GPT models\tWeekly Limit Remaining\t91%\t2026-11-16T22:44:39Z",
	"Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-16T04:20:23Z",
	"Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t97%\t2026-11-21T05:29:29Z",
	"",
].join("\n");

const CONFIG: UsageLimitsConfig = {
	omp: [
		["omp", "usage", "--json", "-r", "-p", "anthropic"],
		["omp", "usage", "--json", "-r", "-p", "zai"],
	],
	agy: ["agy", "-p", "/usage", "--print-timeout", "20s"],
};

function fakeRun(answers: Record<string, Partial<RunProcessResult>>) {
	const calls: string[][] = [];
	const run: ProcessRunner = async (cmd) => {
		const key = cmd[0] === "agy" ? "agy" : (cmd[cmd.indexOf("-p") + 1] ?? "");
		if (!(key in answers)) return { code: 1, stdout: "", timedOut: false };
		calls.push(cmd);
		return { code: 0, stdout: "", timedOut: false, ...answers[key] };
	};
	return { run, calls };
}
const healthy = { anthropic: { stdout: anthropic }, zai: { stdout: zai }, agy: { stdout: AGY } };

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-usage-"));
	chmodSync(home, 0o700);
	clearUsageLimitsCache();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("AC-1: omp parser", () => {
	test("rows by window, remaining percent and reset; no account key anywhere", () => {
		const rows = parseOmp(JSON.parse(anthropic));
		expect(rows).toEqual([
			{ label: "Claude 5 Hour", window: "5h", windowLabel: "5h label", remainingPct: 93, resetsAt: NOW + 6_360_000 },
			{
				label: "Claude 7 Day",
				window: "weekly",
				windowLabel: "7d label",
				remainingPct: 31,
				resetsAt: NOW + 4 * 86_400_000 + 6 * 3_600_000,
			},
			{
				label: "Claude 7 Day (Fable)",
				window: "weekly",
				windowLabel: "7d label",
				remainingPct: 72,
				resetsAt: NOW + 86_400_000,
			},
		]);
		expect(JSON.stringify(rows)).not.toMatch(/email|account|org|sg\*/i);
		const glm = parseOmp(JSON.parse(zai));
		if (typeof glm === "string") throw new Error(glm);
		expect(glm.map((r) => r.window)).toEqual(["5h", "weekly", "other"]);
	});

	test("a limit missing a field is a mismatch, as is a report-less document", () => {
		const broken = { reports: [{ provider: "zai", limits: [{ label: "x", window: { id: "5h" } }] }] };
		expect(typeof parseOmp(broken)).toBe("string");
		expect(typeof parseOmp({ reports: [] })).toBe("string");
		expect(typeof parseOmp([])).toBe("string");
	});
});

describe("AC-1: agy parser", () => {
	test("the 2026-11-16 output: two 5h rows, three weekly rows, none other", () => {
		const rows = parseAgy(AGY);
		if (typeof rows === "string") throw new Error(rows);
		expect(rows.filter((r) => r.window === "5h")).toHaveLength(2);
		expect(rows.filter((r) => r.window === "weekly")).toHaveLength(3);
		expect(rows.filter((r) => r.window === "other")).toHaveLength(0);
		expect(rows.map((r) => r.remainingPct)).toEqual([65, 28, 91, 100, 97]);
		expect(rows[0]?.resetsAt).toBe(Date.parse("2026-11-20T23:00:32Z"));
	});

	test("one line with another column count or a non-numeric percent fails the source", () => {
		expect(typeof parseAgy(`${AGY}Gemini Models\tWeekly\t65%\n`)).toBe("string");
		expect(typeof parseAgy("A\tWeekly Limit\tmany\t2026-11-20T23:00:32Z\n")).toBe("string");
	});
});

describe("AC-1: source isolation and the 15-minute cache", () => {
	test("timeout, exit 1 and empty output each fail only their source", async () => {
		for (const bad of [{ timedOut: true }, { code: 1, stderr: "boom token xoxb-TEST-0\n" }, { stdout: "" }]) {
			clearUsageLimitsCache();
			const fake = fakeRun({ ...healthy, zai: bad });
			const section = await readUsageLimits(CONFIG, fake.run, () => NOW);
			if (!section.ok) throw new Error(section.error);
			expect(section.sources.map((s) => [s.name, s.ok])).toEqual([
				["Claude", true],
				["GLM", false],
				["Antigravity", true],
			]);
		}
	});

	test("exit 1 of `-p anthropic` is named Claude with the reason", async () => {
		const fake = fakeRun({ ...healthy, anthropic: { code: 1, stderr: "login required\n" } });
		const section = await readUsageLimits(CONFIG, fake.run, () => NOW);
		if (!section.ok) throw new Error(section.error);
		expect(section.sources[0]).toEqual({ name: "Claude", ok: false, error: "종료 코드 1: login required" });
	});

	test("agyAccount labels only the Antigravity source; a failed account command reads 계정 확인 실패", async () => {
		const withAccount = { ...CONFIG, agyAccount: ["cat", "/accounts/current"] };
		const fake = fakeRun({ ...healthy, cat: { stdout: "\n setall \nsecond\n" } });
		const section = await readUsageLimits(withAccount, fake.run, () => NOW);
		if (!section.ok) throw new Error(section.error);
		expect(section.sources.map((s) => [s.name, s.account])).toEqual([
			["Claude", undefined],
			["GLM", undefined],
			["Antigravity", "setall"],
		]);

		clearUsageLimitsCache();
		const broken = await readUsageLimits(withAccount, fakeRun({ ...healthy, cat: { code: 1 } }).run, () => NOW);
		if (!broken.ok) throw new Error(broken.error);
		expect(broken.sources[2]?.account).toBe("계정 확인 실패");
	});

	test("a command without -p is named omp; an unknown provider keeps its own name", async () => {
		const run: ProcessRunner = async () => ({ code: 1, stdout: "", timedOut: false });
		const section = await readUsageLimits(
			{
				omp: [
					["omp", "usage"],
					["omp", "usage", "-p", "kimi"],
				],
			},
			run,
			() => NOW,
		);
		if (!section.ok) throw new Error(section.error);
		expect(section.sources.map((s) => s.name)).toEqual(["omp", "kimi"]);
	});

	test("the second call within 15 minutes runs nothing; after it, everything again", async () => {
		const fake = fakeRun(healthy);
		await readUsageLimits(CONFIG, fake.run, () => NOW);
		expect(fake.calls).toHaveLength(3);
		await readUsageLimits(CONFIG, fake.run, () => NOW + USAGE_LIMITS_TTL_MS - 1);
		expect(fake.calls).toHaveLength(3);
		await readUsageLimits(CONFIG, fake.run, () => NOW + USAGE_LIMITS_TTL_MS);
		expect(fake.calls).toHaveLength(6);
	});

	test("a snapshot without deps.usageLimits (the !brief path) never runs a limit command", async () => {
		const fake = fakeRun(healthy);
		const config: DashboardConfig = { dashboard: { port: 7331, usageLimits: CONFIG } };
		const base = (extra: Partial<SnapshotDeps>): SnapshotDeps => ({
			homeDir: home,
			repoDir: "/srv/ompbot",
			timezone: "Asia/Seoul",
			config,
			now: () => NOW,
			callDaemon: async () => {
				throw new Error("no daemon");
			},
			run: fake.run,
			ompVersion: async () => "omp-stub 0.0.0",
			hostOps: () => {
				throw new Error("no hosts");
			},
			collectGates: () => [],
			...extra,
		});
		const off = await buildSnapshot(base({}));
		expect("usageLimits" in off).toBe(false);
		expect(fake.calls).toHaveLength(0);
		const on = await buildSnapshot(base({ usageLimits: true }));
		expect(on.usageLimits?.ok).toBe(true);
		expect(fake.calls).toHaveLength(3);
		// The daemon's assembly leaves it off; the dashboard CLI's turns it on.
		const assembled = (usageLimits?: boolean) =>
			assembleSnapshotDeps({ homeDir: home, config: undefined, ...(usageLimits === undefined ? {} : { usageLimits }) });
		expect(assembled().usageLimits).toBeUndefined();
		expect(assembled(true).usageLimits).toBe(true);
	});
});

describe("AC-1: config validation", () => {
	const load = (usageLimits: unknown) => {
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: { slack: { ownerUserId: "UOWNER0" } },
				slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" },
				ompExecutable: "/usr/local/bin/omp",
				workspaceDir: "workspace",
				dashboard: { port: 7331, usageLimits },
			}),
		);
		return loadConfig(home, { checkTokens: false });
	};

	test("a valid block loads; unknown keys, empty argv and non-string items are config errors", () => {
		expect(load({ omp: [["omp", "usage"]], agy: ["agy", "-p", "/usage"] }).dashboard?.usageLimits?.agy).toEqual([
			"agy",
			"-p",
			"/usage",
		]);
		expect(load({ agy: ["agy"], agyAccount: ["cat", "/a"] }).dashboard?.usageLimits?.agyAccount).toEqual(["cat", "/a"]);
		for (const bad of [
			{ other: 1 },
			{ agy: [] },
			{ agyAccount: [] },
			{ agyAccount: [1] },
			{ omp: [[]] },
			{ omp: [["omp", 1]] },
			{ omp: ["omp"] },
			[],
			"x",
		]) {
			expect(() => load(bad), JSON.stringify(bad)).toThrow(/usageLimits/);
		}
	});

	test("absent usageLimits: no section, no card", async () => {
		const fake = fakeRun(healthy);
		const snapshot = await buildSnapshot({
			homeDir: home,
			repoDir: "/srv/ompbot",
			timezone: "Asia/Seoul",
			config: { dashboard: { port: 7331 } },
			now: () => NOW,
			callDaemon: async () => {
				throw new Error("no daemon");
			},
			run: fake.run,
			ompVersion: async () => "omp-stub 0.0.0",
			hostOps: () => {
				throw new Error("no hosts");
			},
			collectGates: () => [],
			usageLimits: true,
		});
		expect(snapshot.usageLimits).toBeUndefined();
		expect(renderDashboardMain(snapshot, undefined, NOW, { view: "system" })).not.toContain("limits-pop");
		expect(fake.calls).toHaveLength(0);
	});
});

describe("AC-1: html strip", () => {
	async function snapshotWith(answers: Record<string, Partial<RunProcessResult>>) {
		const fake = fakeRun(answers);
		return buildSnapshot({
			homeDir: home,
			repoDir: "/srv/ompbot",
			timezone: "Asia/Seoul",
			config: { dashboard: { port: 7331, usageLimits: CONFIG } },
			now: () => NOW,
			callDaemon: async () => {
				throw new Error("no daemon");
			},
			run: fake.run,
			ompVersion: async () => "omp-stub 0.0.0",
			hostOps: () => {
				throw new Error("no hosts");
			},
			collectGates: () => [],
			usageLimits: true,
		});
	}
	// The top bar's limit chips and their panel: everything from the pop to the header's end.
	const strip = (html: string) => /<div class="limits-pop">[\s\S]*?(?=<div class="top-tools">)/.exec(html)?.[0] ?? "";
	const chipOf = (html: string, name: string) =>
		new RegExp(
			`<span class="limit-chip[^"]*" data-source="${name}">[\\s\\S]*?</span>(?=<span class="limit-chip|</button>)`,
		).exec(html)?.[0] ?? "";
	const rowsOf = (html: string) => [...html.matchAll(/<div class="limit-row[^"]*"[\s\S]*?<\/div>/g)].map((m) => m[0]);
	const rowOf = (html: string, name: string) => rowsOf(html).find((r) => r.includes(`>${name}<`)) ?? "";

	test("the chips sit in every view's top bar; 15% warns, 3% is danger, a failed source shows its reason", async () => {
		const snapshot = await snapshotWith({
			anthropic: { stdout: anthropic },
			zai: { code: 1, stderr: "zai login required" },
			agy: { stdout: AGY.replace("65%", "15%").replace("28%", "3%") },
		});
		for (const view of ["inbox", "turns", "system"]) {
			const main = renderDashboardMain(snapshot, undefined, NOW, { view });
			expect(main, view).toMatch(/<header class="topbar">[\s\S]*<div class="limits-pop">[\s\S]*<\/header>/);
			expect(main, view).not.toMatch(/<main [^>]*>[\s\S]*limit-tile/);
		}
		const html = strip(renderDashboardMain(snapshot, undefined, NOW, { view: "system" }));
		expect(rowOf(html, "5시간")).toMatch(/is-ok/);
		expect(rowOf(html, "Gemini 주간")).toMatch(/is-warn[\s\S]*15%/);
		expect(rowOf(html, "Gemini 5시간")).toMatch(/is-danger[\s\S]*3%/);
		expect(rowOf(html, "Claude·GPT 주간")).toContain("91%");
		expect(html).toMatch(/limit-tile is-danger" data-source="Antigravity"/);
		expect(html).toContain('title="1h46m 뒤 초기화"');
		expect(html).toContain(">4d6h<");
		expect(html).toMatch(/limit-tile is-failed" data-source="GLM"[\s\S]*?zai login required/);
		// Each share sits in a roll cell (`data-roll`) whose text is the number.
		const shares = (chip: string): string => chip.replace(/<span class="roll-n"[^>]*>(\d+)<\/span>/g, "$1");
		expect(shares(chipOf(html, "Antigravity"))).toMatch(
			/limit-chip is-danger[\s\S]*<small>5h<\/small>3<small>주<\/small>15/,
		);
		expect(shares(chipOf(html, "Claude"))).toMatch(/limit-chip is-ok[\s\S]*<small>5h<\/small>93<small>주<\/small>31/);
		expect(chipOf(html, "GLM")).toMatch(/limit-chip is-muted[\s\S]*GLM \?/);
		// The narrow-bar summary: one dot per source in source order and the least share overall.
		expect(shares(html)).toContain(
			'<span class="limit-sum limit-chip is-danger"><i class="dot is-ok" aria-hidden="true"></i><i class="dot is-muted" aria-hidden="true"></i><i class="dot is-danger" aria-hidden="true"></i>3%</span></button>',
		);
		expect(html).not.toContain(EMAIL);
		expect(renderDashboardMain(snapshot, undefined, NOW, { view: "system" })).not.toContain('data-card="usage"');
	});

	test("Claude rows: five-hour first, the Fable weekly window grouped by its parenthesis; other windows left out", async () => {
		const snapshot = await snapshotWith(healthy);
		const html = strip(renderDashboardMain(snapshot, undefined, NOW, { view: "inbox" }));
		const claude =
			/<div class="limit-tile[^"]*" data-source="Claude"[\s\S]*?(?=<div class="limit-tile|$)/.exec(html)?.[0] ?? "";
		expect([...claude.matchAll(/class="limit-name">([^<]+)</g)].map((m) => m[1])).toEqual([
			"5시간",
			"주간",
			"Fable 주간",
		]);
		const glm =
			/<div class="limit-tile[^"]*" data-source="GLM"[\s\S]*?(?=<div class="limit-tile|$)/.exec(html)?.[0] ?? "";
		expect([...glm.matchAll(/class="limit-name">([^<]+)</g)].map((m) => m[1])).toEqual(["5시간", "주간"]);
	});

	test("an account label shows beside its source name only", async () => {
		const snapshot = await snapshotWith(healthy);
		if (snapshot.usageLimits?.ok !== true) throw new Error("no usage section");
		const sources = snapshot.usageLimits.sources.map((s) =>
			s.name === "Antigravity" ? { ...s, account: "setall" } : s,
		);
		const html = strip(
			renderDashboardMain({ ...snapshot, usageLimits: { ...snapshot.usageLimits, sources } }, undefined, NOW, {
				view: "system",
			}),
		);
		expect(html).toMatch(
			/data-source="Antigravity"><div class="limit-head">[\s\S]*?<b>Antigravity<\/b><span class="limit-acct">setall<\/span><\/div>/,
		);
		expect(html.match(/limit-acct/g)).toHaveLength(1);
	});

	test("an unreadable section is one muted chip and one failed tile", async () => {
		const snapshot = await snapshotWith(healthy);
		const html = strip(
			renderDashboardMain({ ...snapshot, usageLimits: { ok: false, error: "boom" } }, undefined, NOW, {
				view: "inbox",
			}),
		);
		expect(html).toContain("읽지 못했어요: boom");
		expect(html).toContain('<span class="limit-chip is-muted">');
	});

	test("the page script re-renders the same strip without an exception", async () => {
		const snapshot = await snapshotWith({
			anthropic: { stdout: anthropic },
			zai: { code: 1 },
			agy: { stdout: AGY.replace("28%", "3%") },
		});
		const server = renderDashboardMain(snapshot, undefined, NOW, { view: "system" });
		const page = renderDashboardPage(snapshot, undefined);
		const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
		const client = new Function("document", "setInterval", `${script}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		expect(() => client(snapshot, undefined, NOW, { view: "system" })).not.toThrow();
		expect(strip(server)).not.toBe("");
		expect(strip(client(snapshot, undefined, NOW, { view: "system" }))).toBe(strip(server));
	});
});
