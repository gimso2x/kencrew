import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ActionButton, ChannelPort, MessageRef, OutboundMessage, PostTarget } from "../src/channel/port";
import { renderBriefingHtml } from "../src/dashboard/briefing";
import { renderDashboardMain } from "../src/dashboard/html";
import { buildSnapshot, type SnapshotDeps } from "../src/dashboard/snapshot";
import { createLogger } from "../src/log";
import type { OmpAskQuestion, OmpDialogRequest, OmpDialogResponse } from "../src/omp/driver";
import { redact } from "../src/redact";
import { ApprovalBroker, type ApprovalTimers } from "../src/safety/approval";
import { answerDialog } from "../src/safety/choice";
import { openStore, type Store } from "../src/store/db";
import { makeHome, OWNER, OWNER_DM, type TestHome } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";

const ORIGIN = { originKey: `discord/dm/${OWNER_DM}`, channel: OWNER_DM, threadTs: "700000000000000001" };
const START = Date.parse("2026-11-20T03:00:00Z");
const clock = { now: () => START };
const HOUR = 3_600_000;

/** Records card writes and lets a test await the one carrying buttons for a given ts (no polling). */
class RecordingPort implements ChannelPort {
	readonly platform = "discord" as const;
	readonly buttons: Array<{ ts: string; buttons: readonly ActionButton[]; text: string }> = [];
	#waiters: Array<(entry: { ts: string; buttons: readonly ActionButton[]; text: string }) => void> = [];
	#next = 1;

	#note(ts: string, msg: OutboundMessage): void {
		if ((msg.buttons?.length ?? 0) === 0) return;
		const entry = { ts, buttons: msg.buttons ?? [], text: msg.text };
		this.buttons.push(entry);
		for (const waiter of this.#waiters.splice(0)) waiter(entry);
	}

	async post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef> {
		const ts = String(900_000_000_000_000_000n + BigInt(this.#next++));
		this.#note(ts, msg);
		return { platform: "discord", conversationId: target.conversationId, messageId: ts };
	}
	async edit(ref: MessageRef, msg: OutboundMessage): Promise<void> {
		this.#note(ref.messageId, msg);
	}
	async react(): Promise<void> {}
	async uploadFile(): Promise<{ fileId: string }> {
		return { fileId: "F1" };
	}
	async permalink(): Promise<string | undefined> {
		return undefined;
	}
	mentionUser(userId: string): string {
		return `<@${userId}>`;
	}

	/** The next card version with buttons that arrives after `seen` of them. */
	nextButtons(seen: number): Promise<{ ts: string; buttons: readonly ActionButton[]; text: string }> {
		const found = this.buttons[seen];
		if (found !== undefined) return Promise.resolve(found);
		const { promise, resolve, reject } = Promise.withResolvers<{
			ts: string;
			buttons: readonly ActionButton[];
			text: string;
		}>();
		// sleep-ok: 카드가 안 올 때 실패시키는 제한 시간일 뿐, 도착은 이벤트로 기다린다
		const timer = setTimeout(() => reject(new Error("card did not arrive")), 2_000);
		this.#waiters.push((entry) => {
			clearTimeout(timer);
			resolve(entry);
		});
		return promise;
	}
}

class ManualTimers implements ApprovalTimers {
	readonly armed = new Map<number, () => void>();
	#next = 1;
	set(fn: () => void): unknown {
		const id = this.#next++;
		this.armed.set(id, fn);
		return id;
	}
	clear(handle: unknown): void {
		this.armed.delete(handle as number);
	}
	fireAll(): void {
		for (const fn of [...this.armed.values()]) fn();
	}
}

const q = (id: string, question: string, labels: string[], extra: Partial<OmpAskQuestion> = {}): OmpAskQuestion => ({
	id,
	question,
	options: labels.map((label) => ({ label })),
	...extra,
});

let home: TestHome;
let store: Store;
let dbPath: string;
let port: RecordingPort;
let timers: ManualTimers;
let broker: ApprovalBroker;

beforeEach(() => {
	home = makeHome("ompbot-auto-choice-");
	dbPath = join(home.dir, "ompbot.db");
	store = openStore({ timezone: "Asia/Seoul", path: dbPath, clock, redact });
	port = new RecordingPort();
	timers = new ManualTimers();
	broker = new ApprovalBroker({
		timezone: "Asia/Seoul",
		channels: registryOf(port),
		ownerUserId: OWNER,
		log: createLogger({ sink: () => undefined, clock, redact }),
		store,
		clock,
		timers,
	});
});
afterEach(() => {
	store.close();
	home.remove();
});

const ask = (questions: OmpAskQuestion[]): Promise<OmpDialogResponse> => {
	const request: OmpDialogRequest = { method: "ask", id: "a1", questions };
	return answerDialog(broker, ORIGIN, request, new AbortController().signal);
};

function recorded(): Array<{
	origin_key: string;
	thread_ref: string;
	question: string;
	chosen: string;
	created_at: number;
}> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query("SELECT origin_key, thread_ref, question, chosen, created_at FROM auto_choices ORDER BY id")
			.all() as never;
	} finally {
		db.close();
	}
}

/** Runs one `ask` to its deadline; `click` is the option button the owner presses first (index into the card's buttons). */
async function timeOut(questions: OmpAskQuestion[], click?: number): Promise<OmpDialogResponse> {
	const seen = port.buttons.length;
	const done = ask(questions);
	const card = await port.nextButtons(seen);
	if (click !== undefined) {
		expect(broker.handleAction({ actionId: card.buttons[click]?.actionId ?? "", userId: OWNER })).toBe(true);
	}
	timers.fireAll();
	return done;
}

describe("ask auto choices are recorded", () => {
	test("a timed-out ask files one row per unanswered question: the recommended option, else the first", async () => {
		const response = await timeOut([
			q("q1", "환경", ["dev", "prod"], { recommended: 1 }),
			q("q2", "알림", ["on", "off"]),
		]);
		expect(response).toEqual({ cancelled: true, timedOut: true });
		expect(recorded()).toEqual([
			{
				origin_key: ORIGIN.originKey,
				thread_ref: `${OWNER_DM}:${ORIGIN.threadTs}`,
				question: "환경",
				chosen: "prod",
				created_at: START,
			},
			{
				origin_key: ORIGIN.originKey,
				thread_ref: `${OWNER_DM}:${ORIGIN.threadTs}`,
				question: "알림",
				chosen: "on",
				created_at: START,
			},
		]);
	});

	test("a question the owner answered is not recorded; the one left to the deadline is", async () => {
		await timeOut([q("q1", "환경", ["dev", "prod"]), q("q2", "로그", ["short", "long"], { recommended: 1 })], 1);
		expect(recorded().map((row) => [row.question, row.chosen])).toEqual([["로그", "long"]]);
	});

	test("an ask the owner fully answered records nothing", async () => {
		const seen = port.buttons.length;
		const done = ask([q("q1", "환경", ["dev", "prod"])]);
		const card = await port.nextButtons(seen);
		expect(broker.handleAction({ actionId: card.buttons[0]?.actionId ?? "", userId: OWNER })).toBe(true);
		expect(await done).toEqual({ answers: [{ id: "q1", selectedOptions: ["dev"] }] });
		expect(recorded()).toEqual([]);
	});

	test("a select that times out records nothing", async () => {
		const seen = port.buttons.length;
		const done = answerDialog(
			broker,
			ORIGIN,
			{ method: "select", id: "s1", title: "배포 방식", options: ["blue-green", "canary"] },
			new AbortController().signal,
		);
		await port.nextButtons(seen);
		timers.fireAll();
		expect(await done).toEqual({ cancelled: true, timedOut: true });
		expect(recorded()).toEqual([]);
	});
});

describe("auto choices are shown", () => {
	test("the approvals view lists them with the thread link and the briefing counts the last 24 hours", async () => {
		await timeOut([
			q("q1", "환경 토큰 xoxb-TEST-0", ["dev", "prod"], { recommended: 1 }),
			q("q2", "알림", ["on", "off"]),
		]);
		const now = START + HOUR;
		const deps: SnapshotDeps = {
			homeDir: home.dir,
			repoDir: home.dir,
			timezone: "Asia/Seoul",
			config: { channels: { discord: { guildIds: ["400000000000000001"] } } } as never,
			now: () => now,
			callDaemon: async () => Promise.reject(new Error("no daemon")),
			run: async () => ({ code: 0, stdout: "", timedOut: false }),
			ompVersion: async () => "omp-stub 0.0.0",
			hostOps: () => {
				throw new Error("no host ops");
			},
		};
		const snapshot = await buildSnapshot(deps);
		if (!snapshot.autoChoices?.ok) throw new Error("autoChoices section missing");
		expect(snapshot.autoChoices.last24h).toBe(2);

		const html = renderDashboardMain(snapshot, undefined, now, { view: "approvals" });
		const list = html.slice(html.indexOf('data-list="auto-choices"'));
		expect(html).toContain("최근 자동 선택(7일)");
		expect(list).toContain("→ prod");
		expect(list).toContain("→ on");
		expect(list).toContain(`https://discord.com/channels/@me/${OWNER_DM}/${ORIGIN.threadTs}`);
		expect(html).not.toContain("xoxb-TEST-0");

		const briefing = renderBriefingHtml(snapshot, now);
		expect(briefing).toContain("지난 24시간 시간 초과로 자동 선택된 질문 2건");

		// Past 24 hours: still listed (7 days), no longer counted, so the briefing line is gone.
		const later = await buildSnapshot({ ...deps, now: () => START + 30 * HOUR });
		if (!later.autoChoices?.ok) throw new Error("autoChoices section missing");
		expect(later.autoChoices.items).toHaveLength(2);
		expect(renderBriefingHtml(later, START + 30 * HOUR)).not.toContain("자동 선택된 질문");
		// Past 7 days: gone from the list.
		const old = await buildSnapshot({ ...deps, now: () => START + 8 * 24 * HOUR });
		if (!old.autoChoices?.ok) throw new Error("autoChoices section missing");
		expect(old.autoChoices.items).toEqual([]);
	});
});
