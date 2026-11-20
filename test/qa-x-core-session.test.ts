// T-20261120-23: qa-x core session fixes (doc/plans/qa-x-core-session-fixes.md). One reproduction per defect.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { epochDirIsFresh, listSavedSessions } from "../src/core/sessions";
import { toolFingerprint } from "../src/core/stuck";
import { CURRENT_REQUEST_MARKER, type InboundRecord } from "../src/core/types";
import { readTurnTrace, type TurnTrace } from "../src/dashboard/trace";
import { dispatchEnv, type ProcessRunner } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import type { OmpEvent } from "../src/omp/driver";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { renderPng } from "../src/ops/screenshot";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-qa-x-core-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sessionLine = (id: string) => JSON.stringify({ type: "session", id });
const userLine = (text: string) =>
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const sessionFile = (id: string, text: string) => `${sessionLine(id)}\n${userLine(text)}\n`;

describe("listSavedSessions (/resume-ompbot)", () => {
	function origin(): { originDir: string; epoch: string } {
		const originDir = join(dir, "origin");
		const epoch = join(originDir, "e1");
		mkdirSync(epoch, { recursive: true });
		return { originDir, epoch };
	}

	test("#1 a FIFO named *.jsonl is skipped instead of blocking the process", async () => {
		const { originDir, epoch } = origin();
		writeFileSync(join(epoch, "good.jsonl"), sessionFile("good0000", "안녕"));
		const made = Bun.spawnSync(["mkfifo", join(epoch, "fifo.jsonl")]);
		expect(made.exitCode).toBe(0);
		// The unfixed code blocks in a synchronous open(): run it in a child the test can kill.
		const script = `import { listSavedSessions } from ${JSON.stringify(join(import.meta.dir, "../src/core/sessions"))};
console.log(JSON.stringify(listSavedSessions(${JSON.stringify(originDir)}).map((s) => s.id)));`;
		const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
		const out = await new Response(child.stdout).text();
		await child.exited;
		expect(JSON.parse(out)).toEqual(["good0000"]);
	}, 30_000);

	test("#2 a directory and a dangling symlink named *.jsonl are skipped, the command does not throw", () => {
		const { originDir, epoch } = origin();
		writeFileSync(join(epoch, "good.jsonl"), sessionFile("good0000", "안녕"));
		mkdirSync(join(epoch, "dir.jsonl"));
		symlinkSync(join(dir, "missing"), join(epoch, "dangling.jsonl"));
		expect(listSavedSessions(originDir).map((s) => s.id)).toEqual(["good0000"]);
	});

	test("#3 a symlink to another origin's session file is not listed", () => {
		const { originDir, epoch } = origin();
		const other = join(dir, "other", "e1");
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "foreign.jsonl"), sessionFile("foreign0", "남의 세션"));
		symlinkSync(join(other, "foreign.jsonl"), join(epoch, "link.jsonl"));
		writeFileSync(join(epoch, "good.jsonl"), sessionFile("good0000", "안녕"));
		expect(listSavedSessions(originDir).map((s) => s.id)).toEqual(["good0000"]);
		// A symlinked origin root itself is the origin's own root, not an escape.
		const linkedRoot = join(dir, "linked-origin");
		symlinkSync(realpathSync(originDir), linkedRoot);
		expect(listSavedSessions(linkedRoot).map((s) => s.id)).toEqual(["good0000"]);
	});

	test("#4 the preview of a session whose first prompt carries context blocks is the owner's request", () => {
		const { originDir, epoch } = origin();
		const prompt = `[스레드 맥락 — 머리말]\n- 앞부분\n\n${CURRENT_REQUEST_MARKER}\n배포 상태 알려줘`;
		writeFileSync(join(epoch, "blocks.jsonl"), sessionFile("blocks00", prompt));
		expect(listSavedSessions(originDir)[0]?.preview).toBe("배포 상태 알려줘");
	});
});

describe("#5 epochDirIsFresh", () => {
	test("an agy conversation pointer counts as an existing session", () => {
		const sessionDir = join(dir, "e1");
		mkdirSync(sessionDir);
		expect(epochDirIsFresh(sessionDir)).toBe(true);
		writeFileSync(join(sessionDir, "agy-conversation.json"), "{}");
		expect(epochDirIsFresh(sessionDir)).toBe(false);
	});
});

describe("#8 toolFingerprint on deeply nested args", () => {
	test("20000 levels of nesting neither throw nor drop the equality of equal calls", () => {
		const nest = (depth: number): unknown => {
			let value: unknown = "leaf";
			for (let level = 0; level < depth; level++) value = [value];
			return value;
		};
		const result = { content: [{ type: "text", text: "ok" }] };
		const a = toolFingerprint("bash", nest(20_000), result, false);
		expect(a).toBe(toolFingerprint("bash", nest(20_000), result, false));
		expect(a).not.toBe(toolFingerprint("bash", nest(3), result, false));
	});
});

const ORIGIN = "discord/dm/200000000000000001";
const clock = { now: () => 1_000_000 };
let counter = 0;
function msg(text: string): InboundRecord {
	const id = `q${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: `t-${id}` };
}

/** A fake driver whose side questions stay open until the test settles them. */
class BtwFakeDriver extends FakeOmpDriver {
	readonly asked: Array<PromiseWithResolvers<string>> = [];
	/** Resolves at the child's first final, whenever it comes (the events option plays after a macrotask hop). */
	readonly firstFinal = Promise.withResolvers<void>();
	constructor(options: FakeOmpDriverOptions) {
		super(options);
		this.onFinal(() => this.firstFinal.resolve());
	}
	btw(_question: string): Promise<string> {
		const answer = Promise.withResolvers<string>();
		this.asked.push(answer);
		return answer.promise;
	}
}

describe("mailbox turns", () => {
	let store: Store;
	let router: OriginRouter;
	let drivers: FakeOmpDriver[];
	let driverOptions: FakeOmpDriverOptions;
	let place: { channelName?: string; topic?: string } | undefined;

	beforeEach(() => {
		store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
		drivers = [];
		driverOptions = {};
		place = undefined;
		const sessions = new FakeSessionStore();
		router = new OriginRouter({
			conversationContext: () => place,
			timezone: "Asia/Seoul",
			store,
			clock,
			sessionsRoot: join(dir, "sessions"),
			log: createLogger({ sink: () => undefined, clock, redact }),
			statusProvider: () => "status",
			driverFactory: (_origin, sessionDir) => {
				const driver = new BtwFakeDriver({ ...driverOptions, sessionDir, store: sessions });
				drivers.push(driver);
				return driver;
			},
		});
	});
	afterEach(async () => {
		for (const driver of drivers) driver.release();
		await router.close();
		store.close();
	});

	const bodies = (threadRef: string): string =>
		store
			.listDeliveries({ originKey: ORIGIN })
			.filter((d) => d.threadRef === threadRef)
			.map((d) => d.body)
			.join("\n");

	test("#6 a side question answered after /new is not delivered", async () => {
		driverOptions = { holdTurns: true };
		await router.route(msg("long job"));
		const question = msg("!btw 질문");
		await router.route(question);
		const driver = drivers[0] as BtwFakeDriver;
		const asked = driver.asked[0];
		if (!asked) throw new Error("btw was not asked");
		await router.route(msg("!new"));
		expect(store.getInbound(question.platformMessageId)?.state).toBe("discarded");
		asked.resolve("늦은 답");
		await asked.promise;
		await router.mailbox(ORIGIN).sweepIdle();
		expect(bodies(question.threadRef)).toBe("");
	});

	test("#7 a channel topic holding a private key cut by the length limit leaks no key body into the prompt", async () => {
		const body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(12);
		const begin = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
		const end = ["-----END", "PRIVATE KEY-----"].join(" ");
		place = { channelName: "ops", topic: `${begin}\n${body}\n${end}` };
		await router.route(msg("안녕"));
		const prompt = (drivers[0] as FakeOmpDriver).calls.find((call) => call.startsWith("prompt:")) ?? "";
		expect(prompt).toContain("채널 설명:");
		expect(prompt).not.toContain("QUJDREVGR0hJSktM");
	});

	test("#8 a tool call with 20000-level args does not fail the turn", async () => {
		let args: unknown = "leaf";
		for (let level = 0; level < 20_000; level++) args = [args];
		const events: OmpEvent[] = [
			{ type: "tool_execution_start", toolCallId: "deep", toolName: "bash", args },
			{
				type: "tool_execution_end",
				toolCallId: "deep",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			},
		];
		driverOptions = { events };
		const row = msg("깊은 인자");
		await router.route(row);
		await (drivers[0] as BtwFakeDriver).firstFinal.promise;
		await router.mailbox(ORIGIN).sweepIdle();
		expect(store.getInbound(row.platformMessageId)?.state).toBe("answered");
		expect(bodies(row.threadRef)).toBe("ECHO 깊은 인자");
	});
});

describe("#10 !brief chromium environment", () => {
	test("the child gets the bot's sanitized environment, not Slack/bot credentials", async () => {
		const envs: Array<Record<string, string> | undefined> = [];
		const run: ProcessRunner = async (cmd, opts) => {
			envs.push(opts.env);
			const out = cmd.find((arg) => arg.startsWith("--screenshot="))?.slice("--screenshot=".length);
			if (out !== undefined) await Bun.write(out, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
			return { code: 0, stdout: "<html><head><title>1234</title></head></html>", timedOut: false };
		};
		const before = { slack: process.env.SLACK_BOT_TOKEN, bot: process.env.OMPBOT_TEST_SECRET };
		process.env.SLACK_BOT_TOKEN = "xoxb-TEST-0";
		process.env.OMPBOT_TEST_SECRET = "secret-TEST";
		try {
			await renderPng("<html></html>", join(dir, "out.png"), {
				chromium: "chromium",
				width: 1080,
				timeoutMs: 1000,
				run,
			});
		} finally {
			for (const [key, value] of [
				["SLACK_BOT_TOKEN", before.slack],
				["OMPBOT_TEST_SECRET", before.bot],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		expect(envs).toHaveLength(2);
		for (const env of envs) {
			expect(env).toBeDefined();
			expect(Object.keys(env ?? {}).filter((key) => key.startsWith("SLACK_") || key.startsWith("OMPBOT_"))).toEqual([]);
		}
		expect(dispatchEnv({ SLACK_BOT_TOKEN: "x" }).SLACK_BOT_TOKEN).toBeUndefined();
	});
});

describe("#11 turn trace worker tierReason", () => {
	test("an email and a phone number in a task's tier reason come out masked", () => {
		const T0 = Date.parse("2026-11-05T10:00:00Z");
		const dbPath = join(dir, "ompbot.db");
		openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => T0 }, redact: (text) => text }).close();
		const sessionDir = join(dir, "sessions", "o", "e1");
		mkdirSync(sessionDir, { recursive: true });
		const file = join(sessionDir, "s.jsonl");
		appendFileSync(file, `${JSON.stringify({ type: "session", timestamp: new Date(T0 - 60_000).toISOString() })}\n`);
		const db = new Database(dbPath, { strict: true });
		db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
			ORIGIN,
			sessionDir,
			T0,
		]);
		db.run(
			`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, op_ref, entry_cursor)
			 VALUES ('m1', ?, 1, 'x', 'answered', ?, ?, 'op-m1', 'cursor-m1')`,
			[ORIGIN, T0 - 1000, T0],
		);
		db.run(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
			   acceptance_json, created_at, updated_at, worker_model, tier, tier_reason)
			 VALUES ('T-PII', 't', 'L2', ?, 'D1:1', NULL, '/r', ?, 'b', 'agent-pii', 'working', '[]', ?, ?, 'zai/glm-5.3', 'middle', ?)`,
			[ORIGIN, join(dir, "wt"), T0 + 1000, T0 + 1000, "문의 hong@example.com 010-1234-5678 때문에"],
		);
		db.close();
		const trace: TurnTrace = readTurnTrace(dir, 1, T0 + 60_000, {
			userHome: join(dir, "user"),
			sessionsRoot: join(dir, "omp-sessions"),
		});
		if (!trace.ok) throw new Error(trace.error);
		const reason = trace.root.children?.find((span) => span.id === "T-PII")?.worker?.tierReason ?? "";
		expect(reason).not.toContain("hong@example.com");
		expect(reason).not.toContain("010-1234-5678");
	});
});
