import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordAdapter } from "../src/discord/adapter";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { monitorOrigin } from "../src/monitors/ledger";
import { rotatingFileSink } from "../src/ops/logfile";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";
import { BOT, GUILD, OWNER } from "./helpers/bot-home";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const LOG = "678901234567890123";
const WORK = "111111111111111111";
const WORK_THREAD = "711111111111111111";
const DM = "123456789012345678";
const DM_MSG = "700000000000000001";
const clock = { now: () => 1_000_000 };

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-log-routing-"));
	store = openStore({
		timezone: "Asia/Seoul",
		path: join(dir, "ompbot.db"),
		clock,
		redact,
		logChannel: { discord: LOG },
	});
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** One dispatched owner message on `originKey` answered with `text`; returns the copies written to the log channel. */
function answer(originKey: string, threadRef: string, text: string, opRef = "op1"): string[] {
	store.ensureOrigin(originKey, `sess/${originKey}`);
	const platformMessageId = `${threadRef}:${opRef}`;
	store.recordInbound({ originKey, platformMessageId, textRef: "do it", threadRef });
	store.markDispatched(platformMessageId, { opRef, entryCursor: null });
	store.recordAnswer({ originKey, opRef, threadRef, parts: [text] });
	return copies();
}

const copies = () =>
	store
		.listDeliveries()
		.filter((row) => row.threadRef === `${LOG}:-`)
		.map((row) => row.body);

describe("completion copies to the log channel", () => {
	test.each(["✅ 완료: 배포 끝", ":white_check_mark: 완료 — 배포 끝"])(
		"a first line starting `%s` is copied once",
		(first) => {
			const body = `${first}\n\n세부 내용`;
			const written = answer(`discord/ch/${WORK}/t/${WORK_THREAD}`, `${WORK}:${WORK_THREAD}`, body);
			expect(written).toHaveLength(1);
			expect(written[0]).toBe(`📒 완료 보고 사본 · <#${WORK}>{{thread-link:${WORK}:${WORK_THREAD}}}\n${body}`);
			// The original answer is delivered unchanged to its own thread.
			expect(
				store.listDeliveries({ originKey: `discord/ch/${WORK}/t/${WORK_THREAD}` }).map((row) => row.body),
			).toContain(body);
		},
	);

	test("a DM answer is labelled DM; a top-level answer carries no thread link; the first non-empty line counts", () => {
		expect(answer(`discord/dm/${DM}`, `${DM}:${DM_MSG}`, "\n\n✅ 완료\nok")[0]).toStartWith(
			`📒 완료 보고 사본 · DM{{thread-link:${DM}:${DM_MSG}}}\n`,
		);
		expect(answer(`discord/dm/${DM}`, `${DM}:-`, "✅ 완료\nok2", "op2")[1]).toStartWith("📒 완료 보고 사본 · DM\n");
	});

	test("a work lane's answer is copied with the lane name, linking its Discord thread", () => {
		expect(answer("ompbot/work/demo", `${WORK}:${WORK_THREAD}`, "✅ 완료: 레인 끝")[0]).toStartWith(
			`📒 완료 보고 사본 · 작업 레인 demo{{thread-link:${WORK}:${WORK_THREAD}}}\n`,
		);
	});

	test("the marker anywhere but the first line, or a different first line, is not copied", () => {
		expect(answer(`discord/dm/${DM}`, `${DM}:1`, "작업합니다\n✅ 완료")).toEqual([]);
		expect(answer(`discord/dm/${DM}`, `${DM}:2`, "완료했습니다", "op2")).toEqual([]);
		expect(answer(`discord/dm/${DM}`, `${DM}:3`, "  ✅ 완료됨", "op3")).toHaveLength(1);
	});

	test("commands, notices and monitor answers are never copied", () => {
		// A chat command's reply (op ref `new:…`) even if it starts with the marker.
		expect(answer(`discord/dm/${DM}`, `${DM}:1`, "✅ 완료 초기화", "new:1")).toEqual([]);
		// A turn failure notice.
		store.ensureOrigin(`discord/dm/${DM}`, "sess");
		store.recordInbound({
			originKey: `discord/dm/${DM}`,
			platformMessageId: `${DM}:4`,
			textRef: "x",
			threadRef: `${DM}:4`,
		});
		store.markDispatched(`${DM}:4`, { opRef: "opf", entryCursor: null });
		store.recordTurnFailure({
			originKey: `discord/dm/${DM}`,
			opRef: "opf",
			threadRef: `${DM}:4`,
			notice: "✅ 완료 아님",
		});
		expect(copies()).toEqual([]);
		// A monitor's answer.
		const monitor = store.monitors.addMonitor({
			name: "daily",
			trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		expect(monitor.id).toBeTruthy();
		expect(answer(monitorOrigin(monitor.id), `${DM}:-`, "✅ 완료 모니터")).toEqual([]);
	});

	test("recording the same answer again adds no second copy; without logChannel nothing is copied", () => {
		answer(`discord/dm/${DM}`, `${DM}:${DM_MSG}`, "✅ 완료 한 번");
		store.recordAnswer({
			originKey: `discord/dm/${DM}`,
			opRef: "op1",
			threadRef: `${DM}:${DM_MSG}`,
			parts: ["✅ 완료 한 번"],
		});
		expect(copies()).toHaveLength(1);

		const plain = openStore({ timezone: "Asia/Seoul", path: join(dir, "plain.db"), clock, redact });
		try {
			plain.ensureOrigin(`discord/dm/${DM}`, "sess");
			plain.recordAnswer({
				originKey: `discord/dm/${DM}`,
				opRef: "op1",
				threadRef: `${DM}:${DM_MSG}`,
				parts: ["✅ 완료"],
			});
			expect(plain.listDeliveries()).toHaveLength(1);
		} finally {
			plain.close();
		}
	});

	test("a past slack row's answer is never copied: the Slack platform has no log channel", () => {
		answer("slack/dm/D1", "D1:1700.000001", "✅ 완료 지난 행");
		answer("ompbot/work/slack-lane", "D1:1700.000002", "✅ 완료: 지난 레인", "op2");
		expect(copies()).toEqual([]);
	});
});

function makeAdapter(
	transport: FakeDiscordTransport,
	recorded: string[],
	deliveries: ConstructorParameters<typeof DiscordAdapter>[0]["deliveries"] = {
		claimDue: () => [],
		confirm: () => undefined,
		fail: () => undefined,
		defer: () => undefined,
	},
): DiscordAdapter {
	const adapter = new DiscordAdapter({
		channel: new DiscordChannel(transport, { ownerUserId: OWNER }),
		core: {
			onInbound: (message) => {
				recorded.push(message.text);
				return {};
			},
			onCommand: () => "",
			onAction: () => undefined,
			knowsThread: () => false,
		},
		deliveries,
		ownerUserId: OWNER,
		clock: { now: () => 1_800_000_000_000 },
		log: createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact }),
		logChannel: LOG,
	});
	void adapter.start();
	return adapter;
}

describe("log channel in the Discord adapter", () => {
	test("an owner message in the log channel never becomes a turn, even with a mention", async () => {
		const transport = new FakeDiscordTransport({ botUserId: BOT });
		transport.setChannel({ id: LOG, type: 0, guildId: GUILD });
		transport.setChannel({ id: WORK, type: 0, guildId: GUILD });
		const recorded: string[] = [];
		makeAdapter(transport, recorded);
		const message = (id: string, content: string, channel: string) => ({
			id,
			channel_id: channel,
			guild_id: GUILD,
			author: { id: OWNER, username: "owner" },
			content,
			type: 0,
		});
		await transport.emitMessage(message("700000000000000011", `<@${BOT}> 이거 해줘`, LOG));
		await transport.emitMessage(message("700000000000000012", "답글", LOG));
		expect(recorded).toEqual([]);
		// Other channels still work for a mention.
		await transport.emitMessage(message("700000000000000013", `<@${BOT}> 이거 해줘`, WORK));
		expect(recorded).toEqual(["이거 해줘"]);
	});

	test("the thread-link placeholder of a copy becomes a permalink when it is posted", async () => {
		const transport = new FakeDiscordTransport({ botUserId: BOT });
		transport.setChannel({ id: LOG, type: 0, guildId: GUILD });
		transport.setChannel({ id: WORK, type: 0, guildId: GUILD });
		transport.setChannel({ id: WORK_THREAD, type: 11, parentId: WORK, guildId: GUILD });
		const body = `📒 완료 보고 사본 · <#${WORK}>{{thread-link:${WORK}:${WORK_THREAD}}}\n✅ 완료`;
		const queue = [
			{
				deliveryId: 1,
				originKey: `discord/ch/${WORK}/t/${WORK_THREAD}`,
				threadRef: `${LOG}:-`,
				body,
				redelivered: false,
				finishUntracked: false,
			},
		];
		const adapter = makeAdapter(transport, [], {
			claimDue: () => queue.splice(0),
			confirm: () => undefined,
			fail: () => undefined,
			defer: () => undefined,
		});
		await adapter.pumpDeliveries();
		const first = transport.calls.find((c) => c.method === "createMessage");
		expect(first && "content" in first ? first.content : "").toBe(
			`📒 완료 보고 사본 · <#${WORK}> · [스레드 보기](https://discord.com/channels/${GUILD}/${WORK_THREAD}/${WORK_THREAD})\n✅ 완료`,
		);
	});
});

describe("the live log file deleted from outside (#43)", () => {
	test("writes keep landing and no archive is lost", () => {
		const path = join(dir, "ompbot.log");
		const sink = rotatingFileSink(path, { maxBytes: 100, files: 3 });
		const line = (n: number) => `L${String(n).padStart(2, "0")}${"x".repeat(36)}`; // 39 bytes + newline = 40
		for (let n = 1; n <= 6; n++) sink(line(n));
		const logs = () => readdirSync(dir).filter((name) => name.startsWith("ompbot.log"));
		expect(logs().sort()).toEqual(["ompbot.log", "ompbot.log.1", "ompbot.log.2"]);
		const archived = [readFileSync(`${path}.1`, "utf8"), readFileSync(`${path}.2`, "utf8")];
		rmSync(path);

		// The counter still says the live file is full: the next write must start a fresh live file, not rotate.
		sink(line(7));
		expect(readFileSync(path, "utf8")).toBe(`${line(7)}\n`);
		expect([readFileSync(`${path}.1`, "utf8"), readFileSync(`${path}.2`, "utf8")]).toEqual(archived);

		for (let n = 8; n <= 12; n++) sink(line(n));
		expect(logs().sort()).toEqual(["ompbot.log", "ompbot.log.1", "ompbot.log.2"]);
		expect(readFileSync(path, "utf8")).toBe(`${line(11)}\n${line(12)}\n`);
	});
});
