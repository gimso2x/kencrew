import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";

const DISCORD_CH = "111111111111111111";
const DISCORD_THREAD = "222222222222222222";
/** Teams conversation alias (the ledger's stand-in for a Teams conversation id) and an Activity id. */
const TEAMS_A = "t0123456789abcdef";
const TEAMS_B = "tfedcba9876543210";

let dir: string;
let now: number;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-delivery-platform-"));
	now = 1_800_000_000_000;
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock: { now: () => now }, redact });
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** One owner message on `originKey` in `threadRef`, answered with `body` (a pending delivery). */
function answer(originKey: string, threadRef: string, messageId: string, body: string): void {
	store.ensureOrigin(originKey, join(dir, "sessions", messageId));
	store.recordInbound({ originKey, platformMessageId: messageId, textRef: `질문 ${body}`, threadRef });
	store.markDispatched(messageId, { opRef: `op-${messageId}`, entryCursor: null });
	store.recordAnswer({ originKey, opRef: `op-${messageId}`, threadRef, parts: [body] });
}

describe("claimDue by platform", () => {
	beforeEach(() => {
		answer(`teams/ch/${TEAMS_A}/t/1.2`, `${TEAMS_A}:1.2`, `${TEAMS_A}:1.2`, "teams thread");
		answer(`teams/dm/${TEAMS_B}`, `${TEAMS_B}:-`, `${TEAMS_B}:9.9`, "teams top level");
		// A monitor answer: its origin is no chat key, its thread ref is the owner's Teams DM.
		store.recordInterim({
			originKey: "monitor/x",
			opRef: "mon-1",
			threadRef: `${TEAMS_B}:-`,
			index: 0,
			body: "monitor",
		});
		answer(
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			"discord thread",
		);
	});

	const bodies = (rows: Array<{ body: string }>) => rows.map((row) => row.body);
	const states = () => Object.fromEntries(store.listDeliveries().map((row) => [row.body, row.state]));

	test("teams takes the Teams thread refs (the monitor delivery included) and leaves the Discord one pending", () => {
		expect(bodies(store.claimDue(20, "teams"))).toEqual(["teams thread", "teams top level", "monitor"]);
		expect(states()).toEqual({
			"teams thread": "inflight",
			"teams top level": "inflight",
			monitor: "inflight",
			"discord thread": "pending",
		});
	});

	test("discord takes only the Discord thread ref", () => {
		expect(bodies(store.claimDue(20, "discord"))).toEqual(["discord thread"]);
		expect(states()).toEqual({
			"teams thread": "pending",
			"teams top level": "pending",
			monitor: "pending",
			"discord thread": "inflight",
		});
	});

	test("the limit counts only the platform's rows; without a platform every due row is claimed as before", () => {
		expect(bodies(store.claimDue(1, "discord"))).toEqual(["discord thread"]);
		expect(bodies(store.claimDue())).toEqual(["teams thread", "teams top level", "monitor"]);
	});

	test("without a platform every due row of every platform is claimed, in delivery order", () => {
		expect(bodies(store.claimDue())).toEqual(["teams thread", "teams top level", "monitor", "discord thread"]);
		expect(states()).toEqual({
			"teams thread": "inflight",
			"teams top level": "inflight",
			monitor: "inflight",
			"discord thread": "inflight",
		});
	});
});

describe("ledger reads by platform", () => {
	beforeEach(() => {
		answer(`teams/dm/${TEAMS_B}`, `${TEAMS_B}:1.1`, `${TEAMS_B}:1.1`, "teams dm answer");
		answer(`teams/ch/${TEAMS_A}/t/1.2`, `${TEAMS_A}:1.2`, `${TEAMS_A}:1.2`, "teams thread answer");
		answer(`discord/dm/${DISCORD_CH}`, `${DISCORD_CH}:333333333333333333`, `${DISCORD_CH}:333`, "discord dm answer");
		answer(
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			"discord thread answer",
		);
		for (const row of store.claimDue()) store.confirmDelivery(row.deliveryId);
	});

	test("listOrigins returns the platform's origin keys only", () => {
		expect(store.listOrigins("discord")).toEqual([
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`discord/dm/${DISCORD_CH}`,
		]);
		expect(store.listOrigins("teams")).toEqual([`teams/ch/${TEAMS_A}/t/1.2`, `teams/dm/${TEAMS_B}`]);
	});

	test("listThreadTargets returns the platform's answered threads only", () => {
		const sorted = (targets: Array<{ channel: string; rootTs: string }>) =>
			targets.map((t) => `${t.channel}:${t.rootTs}`).sort();
		expect(sorted(store.listThreadTargets("discord", 0, 50))).toEqual([
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:333333333333333333`,
		]);
		expect(sorted(store.listThreadTargets("teams", 0, 50))).toEqual([`${TEAMS_A}:1.2`, `${TEAMS_B}:1.1`]);
	});

	test("listRecallCandidates of a Discord conversation reads its Discord rows and no Teams row", () => {
		const candidates = store.listRecallCandidates(DISCORD_CH, "none", 50);
		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) expect(candidate.originKey.startsWith(`discord/`)).toBe(true);
		expect(new Set(candidates.map((c) => c.originKey))).toEqual(
			new Set([`discord/dm/${DISCORD_CH}`, `discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`]),
		);
		expect(candidates.map((c) => c.text)).toContain("discord thread answer");
		const teams = store.listRecallCandidates(TEAMS_B, "none", 50);
		expect(teams.map((c) => c.originKey)).toEqual([`teams/dm/${TEAMS_B}`, `teams/dm/${TEAMS_B}`]);
	});

	test("ownerDmOrigin reads the platform's DM origin", () => {
		expect(store.ownerDmOrigin("discord")).toBe(`discord/dm/${DISCORD_CH}`);
		expect(store.ownerDmOrigin("teams")).toBe(`teams/dm/${TEAMS_B}`);
	});
});

describe("expired rows go back to their platform's adapter", () => {
	const DAY = 24 * 60 * 60_000;
	const bodies = (rows: Array<{ body: string }>) => rows.map((row) => row.body);

	test("a row the sweep expired is handed once to the adapter of its platform, whichever adapter swept", () => {
		answer(`teams/dm/${TEAMS_B}`, `${TEAMS_B}:1.1`, `${TEAMS_B}:1.1`, "teams answer");
		answer(
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			"discord answer",
		);
		now += DAY;
		expect(store.claimDue(20, "teams")).toEqual([]);
		expect(store.listDeliveries().map((row) => row.state)).toEqual(["expired", "expired"]);
		expect(bodies(store.takeExpired("teams"))).toEqual(["teams answer"]);
		expect(store.takeExpired("teams")).toEqual([]);
		expect(bodies(store.takeExpired("discord"))).toEqual(["discord answer"]);
		expect(store.takeExpired("discord")).toEqual([]);
	});

	test("a failed send that expires is not handed over again: the pump already finished it", () => {
		answer(`teams/dm/${TEAMS_B}`, `${TEAMS_B}:1.1`, `${TEAMS_B}:1.1`, "teams answer");
		const [claimed] = store.claimDue(20, "teams");
		if (claimed === undefined) throw new Error("nothing claimed");
		now += DAY;
		expect(store.failDelivery(claimed.deliveryId, "channel_not_found").state).toBe("expired");
		expect(store.claimDue(20, "teams")).toEqual([]);
		expect(store.takeExpired("teams")).toEqual([]);
	});
});
