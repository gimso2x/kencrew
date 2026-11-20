import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { type InboundRecord, parseCommand, promptTextOf } from "../src/core/types";
import { NamespacedDriver } from "../src/daemon/opref";
import { createLogger } from "../src/log";
import { OmpDriverError } from "../src/omp/driver";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { RpcOmpDriver } from "../src/omp/rpc-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";
import { FakeOmpPeer, fakeOmpExecutable } from "./helpers/fake-omp-rpc";

const ORIGIN = "discord/dm/200000000000000001";
const clock = { now: () => 1_000_000 };

/** A fake driver that supports side questions: every `btw` call stays open until the test settles it. */
class BtwFakeDriver extends FakeOmpDriver {
	readonly btwCalls: string[] = [];
	readonly asked: Array<PromiseWithResolvers<string>> = [];

	btw(question: string): Promise<string> {
		this.btwCalls.push(question);
		const answer = Promise.withResolvers<string>();
		this.asked.push(answer);
		return answer.promise;
	}
}

let dir: string;
let store: Store;
let router: OriginRouter;
let drivers: FakeOmpDriver[];
let driverOptions: FakeOmpDriverOptions;
let supportsBtw: boolean;
let counter = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-btw-"));
	store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
	drivers = [];
	driverOptions = { holdTurns: true };
	supportsBtw = true;
	const sessionStore = new FakeSessionStore();
	router = new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		log: createLogger({ sink: () => undefined, clock, redact }),
		statusProvider: () => "status",
		driverFactory: (_origin, sessionDir) => {
			const options = { ...driverOptions, sessionDir, store: sessionStore };
			const driver = supportsBtw ? new BtwFakeDriver(options) : new FakeOmpDriver(options);
			drivers.push(driver);
			return driver;
		},
	});
});

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function msg(text: string): InboundRecord {
	const id = `b${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: `t-${id}` };
}

function replyIn(threadRef: string): string {
	return store
		.listDeliveries({ originKey: ORIGIN })
		.filter((d) => d.threadRef === threadRef)
		.map((d) => d.body)
		.join("\n");
}

function btwDriver(): BtwFakeDriver {
	const driver = drivers.at(-1);
	if (!(driver instanceof BtwFakeDriver)) throw new Error("no btw driver started");
	return driver;
}

function plainDriver(): FakeOmpDriver {
	const driver = drivers.at(-1);
	if (!driver) throw new Error("no driver started");
	return driver;
}

/** Run `action` and wait until the driver's next final has been handled by the mailbox. */
async function untilFinal(driver: FakeOmpDriver, action: () => void): Promise<void> {
	const seen = Promise.withResolvers<void>();
	const off = driver.onFinal(() => {
		off();
		seen.resolve();
	});
	action();
	await seen.promise;
	await router.mailbox(ORIGIN).sweepIdle(); // queued behind the final handler on the actor chain
}

const steers = (driver: FakeOmpDriver): string[] => driver.calls.filter((call) => call.startsWith("steer:"));
const prompts = (driver: FakeOmpDriver): string[] => driver.calls.filter((call) => call.startsWith("prompt:"));

describe("AC-1 btw command parsing", () => {
	test("!btw and /btw-ompbot parse as the btw command and carry the question", () => {
		expect(parseCommand("!btw 왜 멈췄어?")).toEqual({ kind: "btw", arg: "왜 멈췄어?" });
		expect(parseCommand("/btw-ompbot 왜")?.kind).toBe("btw");
		expect(parseCommand("!btw")).toEqual({ kind: "btw", arg: "" });
		expect(promptTextOf("!btw 왜 멈췄어?")).toBe("왜 멈췄어?");
	});

	test("NamespacedDriver forwards btw only when the wrapped driver has it", async () => {
		const inner = new BtwFakeDriver();
		const wrapped = new NamespacedDriver(inner, "p1");
		const answer = wrapped.btw?.("질문");
		expect(inner.btwCalls).toEqual(["질문"]);
		inner.asked[0]?.resolve("답");
		expect(await answer).toBe("답");
		expect(new NamespacedDriver(new FakeOmpDriver(), "p2").btw).toBeUndefined();
	});
});

describe("AC-2 side question during a turn", () => {
	test("asks the driver once, never steers, answers in the question's thread and leaves the turn running", async () => {
		const first = msg("long job");
		await router.route(first);
		const question = msg("!btw 질문");
		await router.route(question);
		const driver = btwDriver();
		expect(driver.btwCalls).toEqual(["질문"]);
		expect(steers(driver)).toEqual([]);
		expect(store.getInbound(question.platformMessageId)?.opRef).toBe(`btw:${question.platformMessageId}`);

		const asked = driver.asked[0];
		if (!asked) throw new Error("btw was not asked");
		asked.resolve("지금 테스트를 돌리는 중");
		await asked.promise;
		expect(replyIn(question.threadRef)).toBe("💬 곁질문: 지금 테스트를 돌리는 중");
		expect(replyIn(first.threadRef)).toBe("");
		expect(router.mailbox(ORIGIN).state.busy).toBe(true);

		await untilFinal(driver, () => driver.release());
		expect(replyIn(first.threadRef)).toBe("ECHO long job");
		expect(prompts(driver)).toEqual(["prompt:long job"]);
	});

	test("a failed side question leaves a failure notice in its thread and the turn keeps running", async () => {
		const first = msg("long job");
		await router.route(first);
		const question = msg("!btw 질문");
		await router.route(question);
		const driver = btwDriver();
		const asked = driver.asked[0];
		if (!asked) throw new Error("btw was not asked");
		asked.reject(new OmpDriverError("rpc_error", "A /btw question is still running; cancel it first"));
		await asked.promise.catch(() => undefined);
		expect(replyIn(question.threadRef)).toContain("[turn failed] btw: A /btw question is still running");
		expect(router.mailbox(ORIGIN).state.busy).toBe(true);
		await untilFinal(driver, () => driver.release());
		expect(replyIn(first.threadRef)).toBe("ECHO long job");
	});
});

describe("AC-3 a pending side question does not hold the mailbox chain", () => {
	test("a later message is steered and the turn's final is handled while btw is still open", async () => {
		const first = msg("long job");
		await router.route(first);
		const question = msg("!btw 질문");
		await router.route(question);
		const driver = btwDriver();
		const asked = driver.asked[0];
		if (!asked) throw new Error("btw was not asked");

		// The side question is still open: the next message's enqueue resolves and it is steered.
		const extra = msg("추가 지시");
		await router.route(extra);
		expect(steers(driver)).toEqual(["steer:추가 지시"]);

		// Still open: the turn's final is handled and its answer recorded.
		await untilFinal(driver, () => driver.release());
		expect(replyIn(first.threadRef)).toBe("ECHO long job | 추가 지시");
		expect(router.mailbox(ORIGIN).state.busy).toBe(false);
		expect(replyIn(question.threadRef)).toBe("");

		// Only now does the side question finish; its answer lands in its own thread.
		asked.resolve("답");
		await asked.promise;
		expect(replyIn(question.threadRef)).toBe("💬 곁질문: 답");
		expect(driver.btwCalls).toEqual(["질문"]);
	});
});

describe("AC-4 no turn, unsupported driver, missing question", () => {
	test("without a running turn the question starts a normal turn, without the !btw word", async () => {
		driverOptions = {};
		const question = msg("!btw 질문");
		await router.route(question);
		const driver = btwDriver();
		expect(driver.btwCalls).toEqual([]);
		expect(prompts(driver)).toEqual(["prompt:질문"]);
		await router.mailbox(ORIGIN).sweepIdle();
		expect(replyIn(question.threadRef)).toBe("ECHO 질문");
	});

	test("a driver without btw answers that side questions are unsupported and nothing is steered", async () => {
		supportsBtw = false;
		await router.route(msg("long job"));
		const question = msg("!btw 질문");
		await router.route(question);
		expect(replyIn(question.threadRef)).toBe("이 대화의 에이전트는 곁질문을 지원하지 않습니다.");
		expect(steers(plainDriver())).toEqual([]);
		expect(prompts(plainDriver())).toEqual(["prompt:long job"]);
	});

	test("!btw without a question answers with the usage, with or without a turn", async () => {
		driverOptions = {};
		const idle = msg("!btw");
		await router.route(idle);
		expect(replyIn(idle.threadRef)).toContain("사용법: `!btw <질문>`");
		expect(drivers).toEqual([]);

		driverOptions = { holdTurns: true };
		await router.route(msg("long job"));
		const busy = msg("/btw-ompbot");
		await router.route(busy);
		expect(replyIn(busy.threadRef)).toContain("사용법: `!btw <질문>`");
		expect(btwDriver().btwCalls).toEqual([]);
		expect(steers(btwDriver())).toEqual([]);
	});
});

interface BtwRecord {
	id: string;
	status: string;
	answer: string;
	error?: string;
}

/**
 * The side-question wire of an in-memory omp peer: the `btw` command stays open until `answerBtw`/`failBtw`,
 * `emitBtwRecord` writes a `btw_record` frame; frames keep their stdout order, as on the real pipe.
 */
class BtwPeer extends FakeOmpPeer {
	constructor() {
		super();
		this.replies.set("btw", () => "hold");
	}
	get btwCalls(): unknown[] {
		return this.commands.filter((c) => c.type === "btw").map((c) => c.question);
	}
	get cancelCalls(): unknown[][] {
		return this.commands
			.filter((c) => c.type === "btw_cancel")
			.map((c) => (c.recordId === undefined ? [] : [c.recordId]));
	}
	emitBtwRecord(record: BtwRecord): void {
		this.push({ type: "btw_record", record });
	}
	async answerBtw(record: BtwRecord): Promise<void> {
		this.respond(await this.command((c) => c.type === "btw"), { data: { record } });
	}
	async failBtw(message: string): Promise<void> {
		this.respond(await this.command((c) => c.type === "btw"), { error: message });
	}
}

const record = (id: string, status: string, answer = "", error?: string): BtwRecord =>
	error === undefined ? { id, status, answer } : { id, status, answer, error };

describe("AC-5 RpcOmpDriver.btw", () => {
	let root: string;
	let driver: RpcOmpDriver;
	let client: BtwPeer;

	async function startDriver(btwTimeoutMs?: number): Promise<void> {
		root = mkdtempSync(join(tmpdir(), "ompbot-btw-rpc-"));
		client = new BtwPeer();
		driver = new RpcOmpDriver({
			ompExecutable: fakeOmpExecutable(root),
			cwd: root,
			sessionDir: join(root, "s"),
			spawn: client.spawn,
			...(btwTimeoutMs === undefined ? {} : { btwTimeoutMs }),
		});
		await driver.start();
	}

	afterEach(async () => {
		await driver.stop();
		rmSync(root, { recursive: true, force: true });
	});

	test("subscribes before asking and returns the trimmed answer of the complete record", async () => {
		await startDriver();
		const answer = driver.btw("질문");
		await client.command((c) => c.type === "btw");
		expect(client.btwCalls).toEqual(["질문"]);
		client.emitBtwRecord(record("r1", "running"));
		await client.answerBtw(record("r1", "running"));
		client.emitBtwRecord(record("r2", "complete", "다른 곁질문"));
		client.emitBtwRecord(record("r1", "running", "부분"));
		client.emitBtwRecord(record("r1", "complete", "  답입니다\n"));
		expect(await answer).toBe("답입니다");
		expect(client.cancelCalls).toEqual([]);
	});

	test("frames that arrive before the btw() response: running is ignored, the terminal one is kept", async () => {
		await startDriver();
		const answer = driver.btw("질문");
		client.emitBtwRecord(record("r0", "complete", "남의 답"));
		client.emitBtwRecord(record("r1", "running"));
		client.emitBtwRecord(record("r1", "complete", "먼저 온 답"));
		await client.answerBtw(record("r1", "running"));
		expect(await answer).toBe("먼저 온 답");
	});

	test("an empty answer becomes (빈 답)", async () => {
		await startDriver();
		const answer = driver.btw("질문");
		await client.answerBtw(record("r1", "running"));
		client.emitBtwRecord(record("r1", "complete", "  \n"));
		expect(await answer).toBe("(빈 답)");
	});

	for (const status of ["error", "cancelled", "interrupted"]) {
		test(`a ${status} record rejects with OmpDriverError naming the status and reason`, async () => {
			await startDriver();
			const answer = driver.btw("질문");
			client.emitBtwRecord(record("r1", "running"));
			client.emitBtwRecord(record("r1", status, "", "모델 호출 실패"));
			await client.answerBtw(record("r1", "running"));
			const error = await answer.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(OmpDriverError);
			expect(String(error)).toContain(status);
			expect(String(error)).toContain("모델 호출 실패");
		});
	}

	test("a rejected btw() command rejects with OmpDriverError", async () => {
		await startDriver();
		const answer = driver.btw("질문");
		await client.failBtw("A /btw question is still running; cancel it first");
		const error = await answer.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OmpDriverError);
		expect(String(error)).toContain("still running");
		expect(client.cancelCalls).toEqual([]);
	});

	test("a timeout after the id is known cancels that record", async () => {
		await startDriver(5);
		const answer = driver.btw("질문");
		await client.answerBtw(record("r1", "running"));
		const error = await answer.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OmpDriverError);
		expect(String(error)).toContain("btw timeout");
		await client.command((c) => c.type === "btw_cancel");
		expect(client.cancelCalls).toEqual([["r1"]]);
	});

	test("a timeout before the btw() response cancels without an id", async () => {
		await startDriver(5);
		const error = await driver.btw("질문").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OmpDriverError);
		expect(String(error)).toContain("btw timeout");
		await client.command((c) => c.type === "btw_cancel");
		expect(client.cancelCalls).toEqual([[]]);
	});
});
