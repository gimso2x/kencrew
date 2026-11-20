import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpbotConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { LaneInputError } from "../src/lanes/manager";
import { RESERVATION_TTL_MS, reservationActionId } from "../src/lanes/reservations";
import type { LaneRow } from "../src/lanes/status";
import { buildWorkStartTool } from "../src/lanes/tools";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { CHANNEL, makeHome, OWNER, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import type { FakeDiscordCall } from "./helpers/discord-fake-transport";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// Lane start reservations (doc/plans/lane-after-queue.md): `ompbot_work_start` with `after` stores the arguments, the
// lane tick reads the prerequisite lanes again and posts a start card once all have landed; the owner starts or cancels.

const signal = new AbortController().signal;
const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';

type Post = Extract<FakeDiscordCall, { method: "createMessage" }>;

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("ompbot-lane-after-home-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

const customIds = (components: unknown): string[] =>
	((components as Array<{ components: Array<{ custom_id: string }> }> | undefined) ?? []).flatMap((row) =>
		row.components.map((button) => button.custom_id),
	);

describe("reservations over the lane manager", () => {
	let h: LaneHarness;
	let repo: string;

	beforeEach(() => {
		repo = makeRepo(repos);
		h = laneHarness(home.dir);
	});

	afterEach(() => h.close());

	async function lane(title: string, cwd = repo): Promise<LaneRow> {
		const started = await h.manager.start({ title, cwd, channel: CHANNEL });
		await h.settle();
		return started;
	}

	/** Puts the lane through claim and landing in the registry (what a landing leaves in `meta.land`). */
	function land(name: string, state: "landed" | "discarded" | "blocked" | "merged-not-pushed" | "pending"): void {
		h.store.transitionLane(name, "done-claimed", { event: "claimed" });
		h.store.transitionLane(name, "closed", { event: state }, { land: { state, attempts: 0 } });
	}

	const reserve = (a: LaneRow, after: unknown, extra: Record<string, unknown> = {}) =>
		h.manager.reserve({
			args: { title: "next step", cwd: repo, channel: CHANNEL, brief: "do the next thing", ...extra },
			after,
			originKey: "discord/dm/1",
			threadRef: a.threadRef,
		});

	const cards = (): Post[] => h.transport.posts((text) => text.includes("시작 가능")) as unknown as Post[];

	async function tick(): Promise<void> {
		await h.manager.tick();
		await h.settle();
	}

	test("waits for the prerequisite; once it landed one ready card with ▶ 시작 and ✖ 취소 goes to the reserved thread", async () => {
		const a = await lane("first");
		const reservation = await reserve(a, ["first"]);
		expect(reservation).toMatchObject({ state: "waiting", after: ["first"], repo: a.meta.repo });
		expect(reservation.expiresAt - reservation.createdAt).toBe(RESERVATION_TTL_MS);

		await tick();
		expect(cards()).toHaveLength(0);
		land("first", "pending");
		await tick();
		expect(cards()).toHaveLength(0);

		h.store.patchLane("first", undefined, { land: { state: "landed", attempts: 0 } });
		await tick();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("ready");
		expect(cards()).toHaveLength(1);
		const [card] = cards();
		expect(card?.channelId).toBe(a.threadRef.split(":")[1]);
		expect(customIds(card?.components)).toEqual([
			reservationActionId(reservation.id, "start"),
			reservationActionId(reservation.id, "cancel"),
		]);
		await tick();
		expect(cards()).toHaveLength(1);
	});

	test("▶ 시작 starts the lane with the arguments frozen at reservation time", async () => {
		const a = await lane("first");
		const reservation = await reserve(a, ["first"], {
			scope: ["src/**"],
			acceptance: [CHECK_A],
			risk: "L2",
		});
		land("first", "landed");
		await tick();
		const before = h.store.listLanes().length;

		const outcome = await h.manager.startReservation(reservation.id);
		await h.settle();
		expect(outcome.handled).toBeTrue();
		const started = h.store.getLaneReservation(reservation.id);
		expect(started?.state).toBe("started");
		const opened = h.store.getLane(started?.laneName ?? "");
		expect(h.store.listLanes()).toHaveLength(before + 1);
		expect(opened).toMatchObject({ title: "next step" });
		expect(opened?.meta).toMatchObject({
			brief: "do the next thing",
			scope: ["src/**"],
			risk: "L2",
			parentOrigin: "discord/dm/1",
			repo: a.meta.repo,
		});
		expect(opened?.meta.acceptance).toHaveLength(1);

		const again = await h.manager.startReservation(reservation.id);
		expect(again.handled).toBeFalse();
		expect(h.store.listLanes()).toHaveLength(before + 1);
	});

	test("✖ 취소 cancels a waiting or ready reservation; a cancelled one raises no card and cannot start", async () => {
		const a = await lane("first");
		const waiting = await reserve(a, ["first"]);
		expect(h.manager.cancelReservation(waiting.id)).toMatchObject({ handled: true });
		land("first", "landed");
		await tick();
		expect(cards()).toHaveLength(0);
		expect((await h.manager.startReservation(waiting.id)).handled).toBeFalse();
		expect(h.manager.cancelReservation(waiting.id).handled).toBeFalse();

		const ready = await reserve(a, ["first"]);
		await tick();
		expect(h.store.getLaneReservation(ready.id)?.state).toBe("ready");
		expect(h.manager.cancelReservation(ready.id).handled).toBeTrue();
		expect(h.store.getLaneReservation(ready.id)?.state).toBe("cancelled");
		expect((await h.manager.startReservation(ready.id)).handled).toBeFalse();
		expect(h.manager.cancelReservation(999).handled).toBeFalse();
	});

	test("24 hours: a waiting and a ready reservation expire with one notice each; a late ▶ 시작 starts nothing", async () => {
		const a = await lane("first");
		const waiting = await reserve(a, ["first"]);
		land("first", "landed");
		const ready = await reserve(a, ["first"], { title: "second step" });
		await tick();
		expect(h.store.getLaneReservation(ready.id)?.state).toBe("ready");
		const lanesBefore = h.store.listLanes().length;
		// Two reservations ready: both raised cards; now let a third stay waiting behind a pending prerequisite.
		const b = await lane("blocker");
		const stuck = await reserve(b, ["blocker"], { title: "third step" });

		h.advance(RESERVATION_TTL_MS + 1);
		await tick();
		expect(h.store.getLaneReservation(waiting.id)?.state).toBe("expired");
		expect(h.store.getLaneReservation(ready.id)?.state).toBe("expired");
		expect(h.store.getLaneReservation(stuck.id)?.state).toBe("expired");
		const notices = h.transport.posts((text) => text.includes("만료됐습니다"));
		expect(notices).toHaveLength(3);
		await tick();
		expect(h.transport.posts((text) => text.includes("만료됐습니다"))).toHaveLength(3);

		expect((await h.manager.startReservation(ready.id)).handled).toBeFalse();
		expect(h.store.listLanes()).toHaveLength(lanesBefore + 1);
	});

	test("a start at the moment of expiry is refused and marks the reservation expired", async () => {
		const a = await lane("first");
		land("first", "landed");
		const reservation = await reserve(a, ["first"]);
		await tick();
		h.advance(RESERVATION_TTL_MS);
		const outcome = await h.manager.startReservation(reservation.id);
		expect(outcome.handled).toBeFalse();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("expired");
	});

	test("a discarded, blocked or merged-not-pushed prerequisite keeps it waiting and is announced once, with ✖ 취소", async () => {
		for (const [title, state, text] of [
			["alpha", "discarded", "폐기됨"],
			["beta", "blocked", "머지 막힘"],
			["gamma", "merged-not-pushed", "push 안 됨"],
		] as const) {
			const a = await lane(title);
			const reservation = await reserve(a, [title], { title: `after ${title}` });
			land(title, state);
			await tick();
			await tick();
			expect(h.store.getLaneReservation(reservation.id)?.state).toBe("waiting");
			const notices = h.transport.posts((post) => post.includes(`예약 #${reservation.id}`) && post.includes(text));
			expect(notices).toHaveLength(1);
			expect(customIds((notices[0] as unknown as Post).components)).toEqual([
				reservationActionId(reservation.id, "cancel"),
			]);
		}
		expect(cards()).toHaveLength(0);
	});

	test("a blocked prerequisite that lands later is judged by the same rule: the card follows", async () => {
		const a = await lane("first");
		const reservation = await reserve(a, ["first"]);
		land("first", "blocked");
		await tick();
		h.store.patchLane("first", undefined, { land: { state: "landed", attempts: 1 } });
		await tick();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("ready");
		expect(cards()).toHaveLength(1);
	});

	test("all prerequisites must have landed: two of two", async () => {
		const a = await lane("one");
		await lane("two");
		const reservation = await reserve(a, ["one", "two"]);
		land("one", "landed");
		await tick();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("waiting");
		land("two", "landed");
		await tick();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("ready");
	});

	test("▶ 시작 reads the prerequisites again: one that stopped being landed sends the reservation back to waiting", async () => {
		const a = await lane("first");
		const reservation = await reserve(a, ["first"]);
		land("first", "landed");
		await tick();
		h.store.transitionLane("first", "working", { event: "reopened" });
		const before = h.store.listLanes().length;
		const outcome = await h.manager.startReservation(reservation.id);
		expect(outcome.handled).toBeFalse();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("waiting");
		expect(h.store.listLanes()).toHaveLength(before);
	});

	test("a start that fails leaves the reservation ready so the owner can click again", async () => {
		const a = await lane("first");
		const reservation = await reserve(a, ["first"]);
		land("first", "landed");
		await tick();
		const limited = laneHarness(home.dir, { maxLanes: 1 });
		// The store is shared by file: the same reservation row is read by a manager with a cap already reached.
		await lane("filler");
		const outcome = await limited.manager.startReservation(reservation.id);
		expect(outcome.handled).toBeFalse();
		expect(limited.store.getLaneReservation(reservation.id)?.state).toBe("ready");
		limited.close();
	});

	describe("outside merges", () => {
		const commitIn = (dir: string, file: string): string => {
			writeFileSync(join(dir, file), `${file}\n`);
			git(dir, "add", "--", file);
			git(dir, "commit", "-q", "-m", `add ${file}`);
			return git(dir, "rev-parse", "HEAD");
		};

		test("a not-done prerequisite merged into the base branch outside the lane closes landed and releases the reservation", async () => {
			const started = await h.manager.start({ title: "outside", cwd: repo, channel: CHANNEL, acceptance: [CHECK_A] });
			await h.settle();
			const sha = commitIn(started.cwd, "b.txt");
			const text = await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: sha, summary: "b.txt" });
			await h.settle();
			expect(text).toContain("[not-done]");
			const reservation = await reserve(started, ["outside"]);

			await tick();
			expect(h.store.getLaneReservation(reservation.id)?.state).toBe("waiting");
			git(repo, "merge", "-q", "--ff-only", started.meta.branch ?? "");
			await tick();
			expect(h.store.getLane("outside")?.meta.land?.state).toBe("landed");
			expect(h.store.getLaneReservation(reservation.id)?.state).toBe("ready");
			expect(cards()).toHaveLength(1);
		});
	});

	describe("refusals at reservation time", () => {
		test("a lane that does not exist", async () => {
			const a = await lane("first");
			await expect(reserve(a, ["nope"])).rejects.toThrow(LaneInputError);
			await expect(reserve(a, ["nope"])).rejects.toThrow("nope");
		});

		test("after must hold one to three distinct names", async () => {
			const a = await lane("first");
			for (const after of [[], "first", ["first", "first"], ["a", "b", "c", "d"], [""], [1]]) {
				await expect(reserve(a, after)).rejects.toThrow(LaneInputError);
			}
			expect(h.store.listLaneReservations(["waiting"])).toHaveLength(0);
		});

		test("a prerequisite of another repository", async () => {
			const a = await lane("first");
			const other = makeRepo(repos);
			await expect(reserve(a, ["first"], { cwd: other })).rejects.toThrow("다른 저장소");
		});

		test("an already discarded prerequisite", async () => {
			const a = await lane("first");
			land("first", "discarded");
			await expect(reserve(a, ["first"])).rejects.toThrow("폐기");
		});

		test("a cycle: the prerequisite is named like the lane the reservation would open", async () => {
			const a = await lane("first");
			await expect(reserve(a, ["first"], { title: "First" })).rejects.toThrow("순환");
		});

		test("no conversation to answer in", async () => {
			await lane("first");
			await expect(
				h.manager.reserve({
					args: { title: "next", cwd: repo, channel: CHANNEL },
					after: ["first"],
					originKey: "discord/dm/1",
					threadRef: undefined,
				}),
			).rejects.toThrow(LaneInputError);
		});

		test("nothing is stored by a refusal", async () => {
			const a = await lane("first");
			await reserve(a, ["nope"]).catch(() => undefined);
			expect(h.store.listLaneReservations(["waiting", "ready", "started", "cancelled", "expired"])).toHaveLength(0);
		});
	});
});

describe("reservations inside the daemon: the tool and the buttons", () => {
	const GUILD = "900000000000000000";
	const LANE_CH = "333333333333333333";
	const DM = "123456789012345678";
	const STRANGER = "999999999999999999";
	let daemons: Daemon[];
	let discord: WaitingDiscordTransport;
	let seq: bigint;

	beforeEach(() => {
		daemons = [];
		seq = 0n;
		discord = new WaitingDiscordTransport();
		discord.setChannel({ id: LANE_CH, type: 0, guildId: GUILD });
	});

	afterEach(async () => {
		for (const daemon of daemons) await daemon.stop();
	});

	const nextId = (): string => {
		seq += 1n;
		return String(720_000_000_000_000_000n + seq);
	};

	async function boot(): Promise<Daemon> {
		const discordConfig = home.config.channels.discord as NonNullable<OmpbotConfig["channels"]["discord"]>;
		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			config: { ...home.config, channels: { discord: { ...discordConfig, laneChannelId: LANE_CH } } },
			channels: [new DiscordBinding(new DiscordChannel(discord, { ownerUserId: OWNER }))],
			log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			stopDrainMs: 10,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		daemons.push(daemon);
		await daemon.start();
		return daemon;
	}

	function click(customId: string, message: Post, userId: string): Promise<void> {
		const id = nextId();
		return discord.emitInteraction({
			id,
			application_id: "600000000000000000",
			type: 3,
			token: `token-${id}`,
			channel_id: message.channelId,
			guild_id: GUILD,
			member: { user: { id: userId } },
			data: { custom_id: customId, component_type: 2 },
			message: { id: message.id, channel_id: message.channelId },
		});
	}

	test("the tool reserves; after the prerequisite landed the card appears; a stranger's click is refused, the owner's starts the lane", async () => {
		const daemon = await boot();
		const repo = makeRepo(repos);
		await discord.emitMessage({
			id: nextId(),
			channel_id: DM,
			author: { id: OWNER },
			content: `작업: lane-a @${repo}`,
			type: 0,
		});
		await discord.waitForPosts((text) => text.includes("작업 레인 `lane-a`을 시작했습니다"));

		const origin = `discord/dm/${DM}`;
		const tool = daemon.hostToolsFor(origin).find((candidate) => candidate.name === "ompbot_work_start");
		const reply = await tool?.execute({ title: "lane-b", cwd: repo, brief: "continue", after: ["lane-a"] }, { signal });
		expect(reply).toContain("예약됨 #1");
		expect(daemon.store.getLane("lane-b")).toBeUndefined();
		expect(daemon.store.getLaneReservation(1)).toMatchObject({
			state: "waiting",
			after: ["lane-a"],
			threadRef: expect.any(String),
		});
		await expect(tool?.execute({ title: "lane-c", cwd: repo, after: ["missing"] }, { signal })).rejects.toThrow(
			"missing",
		);

		daemon.store.transitionLane("lane-a", "done-claimed", { event: "claimed" });
		daemon.store.transitionLane("lane-a", "closed", { event: "landed" }, { land: { state: "landed", attempts: 0 } });
		await daemon.sweep();
		await discord.waitForPosts((text) => text.includes("시작 가능"));
		expect(daemon.store.getLaneReservation(1)?.state).toBe("ready");
		const card = discord.posts((text) => text.includes("시작 가능"))[0] as unknown as Post;
		expect(card.channelId).toBe(DM);
		expect(customIds(card.components)).toEqual([reservationActionId(1, "start"), reservationActionId(1, "cancel")]);

		await click(reservationActionId(1, "start"), card, STRANGER);
		expect(daemon.store.getLaneReservation(1)?.state).toBe("ready");
		expect(daemon.store.getLane("lane-b")).toBeUndefined();
		await click(reservationActionId(1, "cancel"), card, STRANGER);
		expect(daemon.store.getLaneReservation(1)?.state).toBe("ready");

		await click(reservationActionId(1, "start"), card, OWNER);
		expect(daemon.store.getLaneReservation(1)).toMatchObject({ state: "started", laneName: "lane-b" });
		expect(daemon.store.getLane("lane-b")?.meta.brief).toBe("continue");
		const redrawn = discord.calls
			.filter((call): call is Extract<FakeDiscordCall, { method: "editMessage" }> => call.method === "editMessage")
			.filter((call) => call.messageId === card.id)
			.at(-1);
		expect(redrawn?.components).toEqual([]);
	});

	test("the tool only builds with after as an optional argument", () => {
		const tool = buildWorkStartTool({} as Parameters<typeof buildWorkStartTool>[0], LANE_CH, "discord/dm/1");
		const properties = tool.parameters.properties as Record<string, unknown>;
		expect(properties.after).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
		expect(tool.parameters.required).toEqual(["title", "cwd"]);
	});
});
