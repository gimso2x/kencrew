import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginRouter, openBotStore } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { OmpDriverError } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

const ORIGIN = "discord/dm/200000000000000001";

/** A child whose first steer throws after (maybe) reading it: the mailbox cannot tell, so the row is uncertain. */
class FlakySteerDriver extends FakeOmpDriver {
	failSteers = 1;
	override async steer(text: string): Promise<void> {
		if (this.failSteers > 0) {
			this.failSteers--;
			throw new OmpDriverError("rpc_error", "connection reset");
		}
		return super.steer(text);
	}
}

let dir: string;
let store: Store;
let router: OriginRouter;
let driver: FlakySteerDriver;
let counter = 0;
const clock = { now: () => 1_000_000 };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-uncertain-"));
	store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
	const sessionStore = new FakeSessionStore();
	router = new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		log: createLogger({ sink: () => undefined, clock, redact }),
		statusProvider: () => "status",
		driverFactory: (_origin, sessionDir) => {
			driver = new FlakySteerDriver({ holdTurns: true, sessionDir, store: sessionStore });
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
	const id = `m${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: `t-${id}` };
}

async function send(text: string): Promise<string> {
	const record = msg(text);
	await router.route(record);
	return store
		.listDeliveries({ originKey: ORIGIN })
		.filter((d) => d.threadRef === record.threadRef)
		.map((d) => d.body)
		.join("\n");
}

/** A running turn plus one steered row that came back uncertain. */
async function parked(): Promise<InboundRecord> {
	await router.route(msg("긴 작업"));
	const row = msg("이미 읽었을지 모르는 지시");
	await router.route(row);
	expect(store.getInbound(row.platformMessageId)?.state).toBe("uncertain");
	return row;
}

describe("/queue with uncertain rows", () => {
	test("lists them in their own section, numbered after the waiting rows, with the reason", async () => {
		await router.route(msg("긴 작업"));
		await router.route(msg("/followup-ompbot 다음 일"));
		await router.route(msg("이미 읽었을지 모르는 지시"));
		const queue = await send("/queue-ompbot");
		expect(queue).toContain("1. [다음 작업] 다음 일");
		expect(queue).toContain("⚠ 전달 불확실");
		expect(queue).toContain("2. [끼워넣기 전송 오류 · 불확실] 이미 읽었을지 모르는 지시");
		expect(queue).toContain("close <번호>");
		expect(queue).toContain("retry <번호>");
	});

	test("an empty queue still shows the uncertain section", async () => {
		await parked();
		const queue = await send("!queue");
		expect(queue).toContain("대기열 비어 있음");
		expect(queue).toContain("1. [끼워넣기 전송 오류 · 불확실] 이미 읽었을지 모르는 지시");
	});

	test("drop refuses an uncertain number and points to close/retry; the row stays", async () => {
		const row = await parked();
		const reply = await send("!queue drop 1");
		expect(reply).toContain("전달 불확실 항목");
		expect(reply).toContain("close 1");
		expect(store.getInbound(row.platformMessageId)?.state).toBe("uncertain");
	});

	test("close discards without replaying and links the row to the command op", async () => {
		const row = await parked();
		const command = msg("!queue close 1");
		await router.route(command);
		const closed = store.getInbound(row.platformMessageId);
		expect(closed?.state).toBe("discarded");
		expect(closed?.opRef).toBe(`queue:${command.platformMessageId}`);
		expect(driver.calls.filter((c) => c.startsWith("steer:") || c.startsWith("prompt:"))).toEqual(["prompt:긴 작업"]);
		expect(await send("!queue")).not.toContain("전달 불확실");
	});

	test("retry makes the row pending and sends it once more, with a double-answer warning", async () => {
		const row = await parked();
		const reply = await send("!queue retry 1");
		expect(reply).toContain("두 번 나올 수 있습니다");
		expect(store.getInbound(row.platformMessageId)?.state).toBe("dispatched");
		expect(driver.calls.filter((c) => c.startsWith("steer:"))).toEqual(["steer:이미 읽었을지 모르는 지시"]);
	});

	test("close and retry with an unknown or waiting-row number change nothing", async () => {
		const row = await parked();
		expect(await send("!queue close 7")).toContain("전달 불확실 7번이 없습니다");
		expect(await send("!queue retry 0")).toContain("전달 불확실 0번이 없습니다");
		expect(store.getInbound(row.platformMessageId)?.state).toBe("uncertain");
	});
});
