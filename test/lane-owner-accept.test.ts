import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscordChannelConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { buildLaneOutcomeCard } from "../src/lanes/card";
import { createLaneLander, type LandLane, type LandRequest, laneLandBlockers } from "../src/lanes/land";
import { type LaneRow, OWNER_ACCEPTED } from "../src/lanes/status";
import { isOwnerAcceptText } from "../src/lanes/trigger";
import { defaultGit } from "../src/lanes/verify";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { createTaskHostOps, type TaskHostOps } from "../src/tasks/host";
import {
	CHANNEL,
	discordBinding,
	GUILD,
	makeHome,
	OWNER,
	OWNER_DM,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';
const CHECK_B = 'b.txt가 있다 [check: command ["sh","-c","test -f b.txt"]]';

let home: TestHome;
let repos: string[];
let daemons: Daemon[];

beforeEach(() => {
	home = makeHome("ompbot-lane-owner-accept-");
	repos = [];
	daemons = [];
});

afterEach(async () => {
	for (const daemon of daemons) await daemon.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

function commitIn(dir: string, ...files: string[]): string {
	for (const file of files) writeFileSync(join(dir, file), `${file}\n`);
	git(dir, "add", "--", ...files);
	git(dir, "commit", "-q", "-m", `add ${files.join(" ")}`);
	return git(dir, "rev-parse", "HEAD");
}

function countingLand(): { land: LandLane; calls: LandRequest[] } {
	const real = createLaneLander({
		git: defaultGit,
		pushGit: defaultGit,
		removeWorktree: (input) => createTaskHostOps().removeWorktree(input),
	});
	const calls: LandRequest[] = [];
	return {
		calls,
		land: (request, hooks) => {
			calls.push(request);
			return real(request, hooks);
		},
	};
}

function requireLane(h: LaneHarness, name: string): LaneRow {
	const lane = h.store.getLane(name);
	if (!lane) throw new Error(`missing lane ${name}`);
	return lane;
}

function updatesOf(h: LaneHarness, ts: string): string[] {
	return h.transport.calls.flatMap((call) =>
		call.method === "editMessage" && call.messageId === ts ? [call.content ?? ""] : [],
	);
}

async function notDoneWithFailedCheck(
	h: LaneHarness,
	repo: string,
	acceptance = [CHECK_A, CHECK_B],
): Promise<{ lane: LaneRow; sha: string }> {
	const started = await h.manager.start({
		title: "deferred-check",
		cwd: repo,
		channel: CHANNEL,
		acceptance,
		risk: "L1",
	});
	await h.settle();
	const sha = commitIn(started.cwd, "a.txt");
	const text = await h.manager.claimDone(started.originKey, {
		repo: started.cwd,
		commit: "HEAD",
		summary: "a.txt 추가",
	});
	await h.settle();
	expect(text).toContain("[not-done]");
	expect(text).toContain("check AC-2 실패");
	const lane = requireLane(h, started.name);
	expect(lane.status).toBe("not-done");
	return { lane, sha };
}

describe("isOwnerAcceptText (AC-1)", () => {
	test("exact '닫아' with surrounding whitespace only is true; phrases and other commands are false", () => {
		expect(isOwnerAcceptText("닫아")).toBe(true);
		expect(isOwnerAcceptText(" 닫아 ")).toBe(true);
		expect(isOwnerAcceptText("  닫아\n")).toBe(true);
		expect(isOwnerAcceptText("닫아 줘")).toBe(false);
		expect(isOwnerAcceptText("닫아?")).toBe(false);
		expect(isOwnerAcceptText("닫아야 하나")).toBe(false);
		expect(isOwnerAcceptText("")).toBe(false);
		expect(isOwnerAcceptText("머지해")).toBe(false);
	});
});

describe("LaneManager.acceptByOwner and status hints (AC-2)", () => {
	test("acceptByOwner closes a not-done lane with failed checks, holds auto-merge, posts card and logs", async () => {
		const repo = makeRepo(repos);
		const counted = countingLand();
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
			repoMatches: async () => true,
			ownerUserId: OWNER,
		});
		const { lane, sha } = await notDoneWithFailedCheck(h, repo);

		const outcome = await h.manager.acceptByOwner(lane.name);
		await h.settle();

		expect(outcome.handled).toBe(true);
		expect(outcome.text.startsWith("오너 수락으로 닫았습니다")).toBe(true);
		expect(outcome.text).toContain(sha);

		const closed = requireLane(h, lane.name);
		expect(closed.status).toBe("closed");
		expect(closed.meta.sha).toBe(sha);
		expect(closed.meta.land?.autoLandHeld).toBe(OWNER_ACCEPTED);
		expect(closed.meta.land?.state).toBe("pending");
		const closedEntry = closed.history.findLast((entry) => entry.event === "closed");
		expect(closedEntry).toMatchObject({
			event: "closed",
			sha,
			detail: "오너 수락 · 실패 검사 AC-2",
		});

		expect(
			h.logs.some(
				(line) =>
					line.includes("level=warn") &&
					line.includes("event=lane_owner_accepted") &&
					line.includes(`lane=${lane.name}`) &&
					line.includes(`sha=${sha}`),
			),
		).toBe(true);

		expect(counted.calls).toHaveLength(0);
		const cardPost = h.transport.posts((text) => text.startsWith("🔍 머지 대기"));
		expect(cardPost).toHaveLength(1);
		expect(cardPost[0]?.content).toContain("⚠️ 오너 수락으로 닫힌 레인입니다(실패한 검사를 오너가 수락).");
		expect(cardPost[0]?.content).toContain("오너 수락으로 통과");
		expect(JSON.stringify(cardPost[0]?.components)).toContain("ompbot:lane:merge:");
		expect(JSON.stringify(cardPost[0]?.components)).toContain("ompbot:lane:discard:");

		// Owner can still explicitly discard or merge the closed lane.
		const discarded = await h.manager.discard(lane.name);
		expect(discarded.handled).toBe(true);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("discarded");
		h.close();
	});

	test("refuses working, closed, HEAD-changed, dirty worktree, non-check-failure not-done, and laneBusy lanes", async () => {
		const repo = makeRepo(repos);
		let busyOrigin: string | undefined;
		const h = laneHarness(home.dir, {
			laneBusy: (originKey) => originKey === busyOrigin,
		});

		// 1. working lane
		const working = await h.manager.start({
			title: "working-lane",
			cwd: repo,
			channel: CHANNEL,
			acceptance: [CHECK_A],
		});
		await h.settle();
		const rWorking = await h.manager.acceptByOwner(working.name);
		expect(rWorking.handled).toBe(false);
		expect(rWorking.text).toContain("(working)");
		expect(requireLane(h, working.name).status).toBe("working");

		// 2. closed lane
		const closedLane = await h.manager.start({
			title: "closed-lane",
			cwd: repo,
			channel: CHANNEL,
			acceptance: [CHECK_A],
		});
		await h.settle();
		commitIn(closedLane.cwd, "a.txt");
		await h.manager.claimDone(closedLane.originKey, { repo: closedLane.cwd, commit: "HEAD", summary: "완료" });
		await h.settle();
		expect(requireLane(h, closedLane.name).status).toBe("closed");
		const rClosed = await h.manager.acceptByOwner(closedLane.name);
		expect(rClosed.handled).toBe(false);
		expect(rClosed.text).toContain("(closed)");
		expect(requireLane(h, closedLane.name).status).toBe("closed");

		// 3. not-done without failed checks (HEAD mismatch before any checks run)
		const noFail = await h.manager.start({
			title: "head-mismatch",
			cwd: repo,
			channel: CHANNEL,
			acceptance: [CHECK_A],
		});
		await h.settle();
		const first = commitIn(noFail.cwd, "a.txt");
		commitIn(noFail.cwd, "extra.txt");
		await h.manager.claimDone(noFail.originKey, { repo: noFail.cwd, commit: first, summary: "mismatch" });
		await h.settle();
		const noFailBefore = requireLane(h, noFail.name);
		expect(noFailBefore.status).toBe("not-done");
		const rNoFail = await h.manager.acceptByOwner(noFail.name);
		expect(rNoFail.handled).toBe(false);
		expect(rNoFail.text).toContain("실패한 검사가 없습니다");
		expect(requireLane(h, noFail.name)).toEqual(noFailBefore);

		// 4. not-done with failed check, then laneBusy true
		const { lane: failedLane } = await notDoneWithFailedCheck(h, repo);
		const failedBefore = requireLane(h, failedLane.name);
		busyOrigin = failedLane.originKey;
		const rBusy = await h.manager.acceptByOwner(failedLane.name);
		expect(rBusy.handled).toBe(false);
		expect(rBusy.text).toContain("작업 중");
		expect(requireLane(h, failedLane.name)).toEqual(failedBefore);
		busyOrigin = undefined;

		// 5. not-done with failed check, then uncommitted dirty change in worktree
		writeFileSync(join(failedLane.cwd, "dirty.txt"), "dirty\n");
		const rDirty = await h.manager.acceptByOwner(failedLane.name);
		expect(rDirty.handled).toBe(false);
		expect(rDirty.text).toContain("커밋하지 않은 변경");
		expect(requireLane(h, failedLane.name)).toEqual(failedBefore);
		git(failedLane.cwd, "clean", "-fd", "-q");

		// 6. not-done with failed check, then new commit moved HEAD past checks.head
		commitIn(failedLane.cwd, "newer.txt");
		const rHeadMoved = await h.manager.acceptByOwner(failedLane.name);
		expect(rHeadMoved.handled).toBe(false);
		expect(rHeadMoved.text).toContain("HEAD가 마지막 검사 커밋이 아닙니다");
		expect(requireLane(h, failedLane.name)).toEqual(failedBefore);

		h.close();
	});

	test("refuses not-done lane whose checks are only inconclusive (timed out)", async () => {
		const repo = makeRepo(repos);
		const real = createTaskHostOps();
		const h = laneHarness(home.dir, {
			hostOps: {
				...real,
				runCheck: async () => ({ code: null, output: "", timedOut: true }),
			},
		});
		const started = await h.manager.start({
			title: "timed-out-only",
			cwd: repo,
			channel: CHANNEL,
			acceptance: [CHECK_A],
		});
		await h.settle();
		commitIn(started.cwd, "a.txt");
		await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "slow" });
		h.advance(5 * 60_000);
		await h.manager.tick();
		await h.settle();
		const lane = requireLane(h, started.name);
		expect(lane.status).toBe("not-done");
		const outcome = await h.manager.acceptByOwner(lane.name);
		expect(outcome.handled).toBe(false);
		expect(outcome.text).toContain("실패한 검사가 없습니다");
		expect(requireLane(h, lane.name).status).toBe("not-done");
		h.close();
	});

	test("if lane transitions to working while headOf awaits, acceptByOwner returns handled:false and does not close", async () => {
		const repo = makeRepo(repos);
		const real = createTaskHostOps();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let holdHead = false;
		const ops: TaskHostOps = {
			...real,
			async headOf(worktree) {
				if (holdHead) {
					entered.resolve();
					await release.promise;
				}
				return real.headOf(worktree);
			},
		};
		const h = laneHarness(home.dir, { hostOps: ops });
		const { lane } = await notDoneWithFailedCheck(h, repo);

		holdHead = true;
		const accepting = h.manager.acceptByOwner(lane.name);
		await entered.promise;

		// Concurrent acceptByOwner sees #landing lock and refuses immediately.
		const overlap = await h.manager.acceptByOwner(lane.name);
		expect(overlap.handled).toBe(false);

		// Meanwhile the lane moves back to working before headOf resolves.
		h.store.transitionLane(lane.name, "working", { event: "resumed_work" }, {});
		release.resolve();

		const outcome = await accepting;
		await h.settle();
		expect(outcome.handled).toBe(false);
		expect(outcome.text).toContain("(working)");
		expect(requireLane(h, lane.name).status).toBe("working");
		h.close();
	});

	test("laneLandBlockers holds auto-merge with '오너 수락으로 통과' and card renders owner-accepted notice", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const { lane, sha } = await notDoneWithFailedCheck(h, repo);
		const outcome = await h.manager.acceptByOwner(lane.name);
		await h.settle();
		expect(outcome.handled).toBe(true);

		const closed = requireLane(h, lane.name);
		const blockers = laneLandBlockers(closed, { repos: [repo], maxRisk: "L2" }, true, false);
		expect(blockers).toContain("오너 수락으로 통과");

		const card = buildLaneOutcomeCard(closed, { kind: "ask", ownerUserId: OWNER, skipped: blockers });
		expect(card.text).toContain("⚠️ 오너 수락으로 닫힌 레인입니다(실패한 검사를 오너가 수락).");
		expect(card.text).toContain("오너 수락으로 통과");
		expect(sha.length).toBeGreaterThan(0);
		h.close();
	});

	test("status line shows '닫아' hint only on not-done lanes with failed checks, not on working or non-check not-done", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);

		const working = await h.manager.start({
			title: "working-hint",
			cwd: repo,
			channel: CHANNEL,
			acceptance: [CHECK_A],
		});
		await h.settle();
		await h.manager.tick();
		expect(updatesOf(h, working.meta.statusTs ?? "")).toEqual([]);
		expect(requireLane(h, working.name).meta.renderedStatus).not.toContain("닫아");

		// not-done without failed checks (HEAD mismatch): no hint
		const noFail = await h.manager.start({ title: "nofail-hint", cwd: repo, channel: CHANNEL, acceptance: [CHECK_A] });
		await h.settle();
		const first = commitIn(noFail.cwd, "a.txt");
		commitIn(noFail.cwd, "b.txt");
		await h.manager.claimDone(noFail.originKey, { repo: noFail.cwd, commit: first, summary: "mismatch" });
		await h.settle();
		expect(requireLane(h, noFail.name).status).toBe("not-done");
		expect(updatesOf(h, noFail.meta.statusTs ?? "").at(-1)).not.toContain("닫아");

		// not-done with failed check: hint appears in status line immediately
		const { lane: failedLane } = await notDoneWithFailedCheck(h, repo);
		const lastStatus = updatesOf(h, failedLane.meta.statusTs ?? "").at(-1) ?? "";
		expect(lastStatus).toContain(' · 계획대로 보류한 검사면 "닫아"');
		expect(requireLane(h, failedLane.name).meta.renderedStatus).toContain(' · 계획대로 보류한 검사면 "닫아"');

		h.close();
	});

	test("existing done-claimed #close behavior and '검증 통과' reply remain unchanged", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const started = await h.manager.start({
			title: "normal-close",
			cwd: repo,
			channel: CHANNEL,
			acceptance: [CHECK_A],
		});
		await h.settle();
		const sha = commitIn(started.cwd, "a.txt");
		const reply = await h.manager.claimDone(started.originKey, {
			repo: started.cwd,
			commit: "HEAD",
			summary: "a.txt 추가",
		});
		await h.settle();
		expect(reply.startsWith(`검증 통과: 커밋 ${sha}.`)).toBe(true);
		const closed = requireLane(h, started.name);
		expect(closed.status).toBe("closed");
		expect(closed.meta.land?.autoLandHeld).toBeUndefined();
		h.close();
	});
});

describe("daemon thread '닫아' routing (AC-3)", () => {
	test("not-done lane thread '닫아' is settled by core (op_ref lane:) without reaching omp; working lane thread '닫아' goes to omp", async () => {
		const repo = makeRepo(repos);
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		const sessions = new FakeSessionStore();
		const drivers = new Map<string, FakeOmpDriver>();
		const clock = { now: () => Date.now() };
		const logs: string[] = [];
		const daemon = new Daemon({
			config: {
				...home.config,
				channels: { discord: { ...(home.config.channels.discord as DiscordChannelConfig), laneChannelId: CHANNEL } },
				lanes: { completionNudges: 0 },
			},
			channels: [discordBinding(transport)],
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions });
				drivers.set(origin, driver);
				return driver;
			},
		});
		daemons.push(daemon);
		await daemon.start();

		const sendThread = (content: string, id: string, rootId: string) =>
			transport.emitMessage({ id, channel_id: rootId, guild_id: GUILD, author: { id: OWNER }, content, type: 0 });

		// 1. working lane: '닫아' goes to lane omp session
		await daemon.inject({ origin: `discord/dm/${OWNER_DM}`, asOwner: true, text: `작업: work-lane @${repo}` });
		await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore") && text.includes("work-lane"), 1, 1500);
		const workRootId = transport.posts((text) => text === "🔄 work-lane")[0]?.id ?? "";
		await sendThread("닫아", "7100000000000000100", workRootId);
		await transport.waitForPosts((text) => text.startsWith("ECHO 닫아"), 1, 1500);
		const workPrompts = drivers.get("ompbot/work/work-lane")?.calls.filter((c) => c.startsWith("prompt:")) ?? [];
		expect(workPrompts.some((call) => call === "prompt:닫아")).toBe(true);
		expect(daemon.store.getLane("work-lane")?.status).toBe("working");

		// 2. not-done lane with failed check: '닫아' settles by core (op_ref lane:), never reaches omp
		const acceptTool = daemon.hostToolsFor(`discord/dm/${OWNER_DM}`).find((tool) => tool.name === "ompbot_work_start");
		const signal = new AbortController().signal;
		const startedText = await acceptTool?.execute(
			{ title: "accept-lane", cwd: repo, acceptance: [CHECK_A, CHECK_B] },
			{ signal },
		);
		expect(startedText).toContain("accept-lane");
		await transport.waitForPosts(
			(text) => text.startsWith("ECHO ulw explore") && text.includes("accept-lane"),
			1,
			1500,
		);
		const acceptLane = daemon.store.getLane("accept-lane");
		const acceptRootId = acceptLane?.threadRef.slice(acceptLane.threadRef.indexOf(":") + 1) ?? "";
		const sha = commitIn(acceptLane?.cwd ?? "", "a.txt");
		const claimTool = daemon.hostToolsFor("ompbot/work/accept-lane").find((tool) => tool.name === "ompbot_claim_done");
		const claimResult = await claimTool?.execute(
			{ repo: acceptLane?.cwd ?? "", commit: "HEAD", summary: "a.txt만 추가" },
			{ signal },
		);
		expect(claimResult).toContain("[not-done]");
		expect(daemon.store.getLane("accept-lane")?.status).toBe("not-done");
		// Wait for the core's not-done steer turn to finish before the owner sends '닫아'.
		await transport.waitForPosts(
			(text) => text.startsWith("ECHO [ompbot] 완료 주장이 검증을 통과하지 못했습니다"),
			1,
			1500,
		);

		const promptsBefore =
			drivers.get("ompbot/work/accept-lane")?.calls.filter((c) => c.startsWith("prompt:") && c === "prompt:닫아") ?? [];
		expect(promptsBefore).toHaveLength(0);

		await sendThread("닫아", "7100000000000000200", acceptRootId);
		await transport.waitForPosts((text) => text.startsWith("오너 수락으로 닫았습니다"), 1, 1500);

		const inbound = daemon.store.getInbound(`${CHANNEL}:7100000000000000200`);
		expect(inbound?.originKey).toBe("ompbot/work/accept-lane");
		expect(inbound?.state).toBe("answered");
		expect(inbound?.opRef).toBe(`lane:${CHANNEL}:7100000000000000200`);

		const promptsAfter =
			drivers.get("ompbot/work/accept-lane")?.calls.filter((c) => c.startsWith("prompt:") && c.includes("닫아")) ?? [];
		expect(promptsAfter).toHaveLength(0);

		const closed = daemon.store.getLane("accept-lane");
		expect(closed?.status).toBe("closed");
		expect(closed?.meta.sha).toBe(sha);
		expect(closed?.meta.land?.autoLandHeld).toBe(OWNER_ACCEPTED);
		await transport.waitForPosts((text) => text.startsWith("🔍 머지 대기"), 1, 1500);
	});
});
