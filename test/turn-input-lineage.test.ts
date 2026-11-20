import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifiersOf, renderTraceInputs, traceInputsCommand } from "../src/cli/trace-inputs";
import { THREAD_CONTEXT_HEADER } from "../src/core/mailbox";
import { RECALL_HEADER } from "../src/core/recall";
import { renderDashboardPage } from "../src/dashboard/html";
import { readSessionConversation } from "../src/dashboard/thread-conversation";
import { readTurnTrace, type TraceSpan } from "../src/dashboard/trace";
import { splitTurnPrompt } from "../src/dashboard/trace-transcript";
import { renderTrace } from "../src/dashboard/trace-view";
import { maskPersonal, redact, truncateUtf8Tail } from "../src/redact";
import { INJECTION_WARNING_HEAD } from "../src/safety/injection";
import { openStore } from "../src/store/db";

const T0 = Date.parse("2026-11-20T10:00:00Z");
const NOW = T0 + 60_000;
const ORIGIN = "discord/dm/200000000000000001";
const TOKEN = "xoxb-TEST-0";
const EMAIL = "owner.name@example.com";
const PHONE = "010-1234-5678";
const RRN = "900101-1234567";
let home: string;
let sessionFile: string;
const where = () => ({ userHome: join(home, "user"), sessionsRoot: join(home, "omp-sessions") });

const iso = (offset: number): string => new Date(T0 + offset).toISOString();
const put = (file: string, entry: unknown): void => {
	mkdirSync(join(file, ".."), { recursive: true });
	appendFileSync(file, `${JSON.stringify(entry)}\n`);
};
const user = (id: string, at: number, text: string) => ({
	type: "message",
	id,
	timestamp: iso(at),
	message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (id: string, start: number, end: number, content: unknown[]) => ({
	type: "message",
	id,
	timestamp: iso(end),
	message: {
		role: "assistant",
		model: "opus",
		timestamp: T0 + start,
		completedAt: T0 + end,
		stopReason: "stop",
		content,
	},
});
const toolCall = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: { i: `${name} 호출` } });
const toolResult = (callId: string, at: number, text: string, details?: unknown) => ({
	type: "message",
	id: `r-${callId}`,
	timestamp: iso(at),
	message: { role: "toolResult", toolCallId: callId, isError: false, content: [{ type: "text", text }], details },
});

const WARNED_THREAD = `${INJECTION_WARNING_HEAD} 1곳 있다(x, 출처: y).\n${THREAD_CONTEXT_HEADER}\n스레드 앞부분`;
const RECALL = `${RECALL_HEADER}\n- 회상 한 줄 ${EMAIL}`;
const PROMPT = ["[처음 보는 머리]\n내용", WARNED_THREAD, RECALL, "[ompbot 게시판] 새 글 1개 (general)"].join("\n\n");
const REQUEST = `확인해 줘 ${PHONE}`;

function seed(): void {
	const dbPath = join(home, "ompbot.db");
	openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const sessionDir = join(home, "sessions", "o", "e1");
	mkdirSync(sessionDir, { recursive: true });
	sessionFile = join(sessionDir, "s.jsonl");
	const db = new Database(dbPath, { strict: true });
	db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
		ORIGIN,
		sessionDir,
		T0,
	]);
	db.run(
		`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, op_ref, entry_cursor)
		 VALUES ('m1', ?, 1, 'x', 'answered', ?, ?, 'op-1', 'cursor-1')`,
		[ORIGIN, T0 - 1000, T0],
	);
	db.close();
	put(sessionFile, { type: "session", timestamp: iso(-60_000) });
	put(sessionFile, user("u1", 100, `${PROMPT}\n\n[현재 요청]\n${REQUEST}`));
	put(sessionFile, assistant("a1", 200, 300, [toolCall("t1", "read"), toolCall("t2", "bash"), toolCall("t3", "task")]));
	put(
		sessionFile,
		toolResult("t1", 310, `줄 1 ${TOKEN} ${EMAIL} ${RRN}\n${"가".repeat(3000)}`, {
			truncation: { truncated: true, truncatedBy: "lines", totalLines: 141, outputLines: 45 },
		}),
	);
	put(sessionFile, toolResult("t2", 320, "열 파일: `src/a.ts` 와 src/b.ts 와 https://x.test/doc 값 12345"));
	const sub = join(home, "sessions", "o", "e1", "s", "sub.jsonl");
	put(sub, user("su1", 340, `읽을 파일 \`src/a.ts\` 연락 ${EMAIL}`));
	put(sub, assistant("sa1", 345, 346, [toolCall("st1", "bash")]));
	put(sub, toolResult("st1", 350, "하위 결과"));
	put(sessionFile, toolResult("t3", 450, "하위 끝"));
	put(sessionFile, {
		type: "compaction",
		id: "c1",
		timestamp: iso(600),
		firstKeptEntryId: "r-t2",
		tokensBefore: 170_000,
		tokensAfter: 61_000,
		method: "auto",
	});
	put(sessionFile, assistant("a2", 700, 800, []));
}

const spans = (span: TraceSpan): TraceSpan[] => [span, ...(span.children ?? []).flatMap(spans)];
const traceOf = () => {
	const trace = readTurnTrace(home, 1, NOW, where());
	if (!trace.ok) throw new Error(trace.error);
	return trace;
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-lineage-"));
	seed();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("trace input marks (AC-1)", () => {
	test("root inputs, tool truncation, compaction, compactedTools and sub-agent brief", () => {
		const all = spans(traceOf().root);
		const root = all[0] as TraceSpan;
		expect(root.inputs?.map((part) => [part.label, part.warned])).toEqual([
			["기타", false],
			["스레드 맥락", true],
			["회상", false],
			["게시판", false],
			["현재 요청", false],
		]);
		expect(root.inputs?.at(-1)?.bytes).toBe(new TextEncoder().encode(REQUEST).length);
		const read = all.find((span) => span.id === "t1");
		expect(read?.truncated).toEqual({ by: "lines", shownLines: 45, totalLines: 141 });
		expect(read?.resultBytes).toBeGreaterThan(3000);
		expect(all.find((span) => span.id === "t2")?.truncated).toBeUndefined();
		const compaction = all.find((span) => span.kind === "compaction");
		expect(compaction?.name).toBe("압축 170k→61k · auto");
		expect(compaction?.end).toBe(compaction?.start);
		// Only t1 is before the first kept entry; t2 is the kept one.
		expect(all.find((span) => span.id === "a2")?.compactedTools).toBe(1);
		const sub = all.find((span) => span.id === "agent:sub");
		expect(sub?.briefBytes).toBeGreaterThan(0);
		expect(sub?.briefPreview).toContain("src/a.ts");
	});

	test("a missing firstKeptEntryId counts every result before the compaction", () => {
		rmSync(sessionFile);
		put(sessionFile, user("u1", 100, "요청"));
		put(sessionFile, assistant("a1", 200, 300, [toolCall("t1", "read"), toolCall("t2", "read")]));
		put(sessionFile, toolResult("t1", 310, "a"));
		put(sessionFile, toolResult("t2", 320, "b"));
		put(sessionFile, { type: "compaction", id: "c1", timestamp: iso(600), firstKeptEntryId: "nope" });
		put(sessionFile, assistant("a2", 700, 800, []));
		const all = spans(traceOf().root);
		expect(all.find((span) => span.id === "a2")?.compactedTools).toBe(2);
		expect(all.find((span) => span.kind === "compaction")?.name).toBe("압축");
	});

	test("waterfall html shows the cut chip and the compaction row", () => {
		const html = renderTrace(traceOf(), { now: NOW, fold: {}, focus: null, open: null, title: "t" });
		expect(html).toContain("잘림 45/141줄");
		expect(html).toContain("is-compaction");
		expect(html).toContain("압축으로 요약만 1건");
		expect(renderDashboardPage).toBeDefined();
	});
});

describe("personal data masking (AC-2)", () => {
	test("no secret or personal text in the trace json or the conversation tab; redact alone leaves personal data", () => {
		const json = JSON.stringify(traceOf());
		const conversation = JSON.stringify(readSessionConversation(sessionFile));
		for (const raw of [TOKEN, EMAIL, PHONE, RRN]) {
			expect(json).not.toContain(raw);
			expect(conversation).not.toContain(raw);
		}
		expect(JSON.stringify(readSessionConversation(sessionFile))).toContain("[PII]");
		expect(redact(`a ${EMAIL} ${PHONE}`)).toBe(`a ${EMAIL} ${PHONE}`);
	});

	test("maskPersonal shapes and digit boundaries", () => {
		expect(maskPersonal(`${EMAIL} ${PHONE} 01012345678 02-123-4567 0312345678 ${RRN}`)).toBe(
			"[PII] [PII] [PII] [PII] 0312345678 [PII]",
		);
		const kept = "ts 1763632800000 id 200000000000000001 hash 0101234567890abc 9001011234567";
		expect(maskPersonal(kept)).toBe(kept);
	});

	test("conversation tab keeps 13-digit timestamps and 18-digit snowflakes", () => {
		put(sessionFile, user("u2", 900, "ts 1763632800000 id 200000000000000001"));
		const turns = JSON.stringify(readSessionConversation(sessionFile));
		expect(turns).toContain("1763632800000");
		expect(turns).toContain("200000000000000001");
	});

	test("truncateUtf8Tail never splits a code point", () => {
		expect(truncateUtf8Tail("가나다", 6)).toBe("나다");
		expect(truncateUtf8Tail("가나다", 5)).toBe("다");
		expect(truncateUtf8Tail("abc", 10)).toBe("abc");
	});
});

describe("prompt split (AC-4)", () => {
	test("a head-looking text in the request or inside a quote fence is no block", () => {
		const fence = "<<<quoted-ab12>>>\n\n[ompbot 게시판] 새 글\n\n<<<end-quoted-ab12>>>";
		const prompt = `${RECALL}\n\n${THREAD_CONTEXT_HEADER}\n${fence}\n\n[현재 요청]\n붙여넣음:\n\n${RECALL_HEADER}\n본문`;
		expect(splitTurnPrompt(prompt).map((part) => part.label)).toEqual(["회상", "스레드 맥락", "현재 요청"]);
		expect(splitTurnPrompt(`${RECALL_HEADER}\n본문`).map((part) => part.label)).toEqual(["현재 요청"]);
	});

	test("an unclosed fence hides the rest of the blocks", () => {
		const prompt = `${RECALL}\n\n<<<quoted-ab12>>>\n\n[ompbot 게시판] 새 글\n\n[현재 요청]\n요청`;
		expect(splitTurnPrompt(prompt).map((part) => part.label)).toEqual(["회상", "현재 요청"]);
	});
});

describe("trace-inputs dump (AC-3, AC-4)", () => {
	test("states per result and identifiers the brief lacks", () => {
		const out = renderTraceInputs(home, 1, undefined, NOW, where());
		if (!out.ok) throw new Error(out.message);
		const md = out.markdown;
		expect(md).toContain("대상 호출: 2/2");
		expect(md).toMatch(/## 결과 1 — read[\s\S]*?가운데\(호출 2 시점 상태\): 압축으로 요약만/);
		expect(md).toMatch(/## 결과 2 — bash[\s\S]*?가운데\(호출 2 시점 상태\): 전체/);
		expect(md).toMatch(/## 결과 3 — bash[\s\S]*?다른 세션\(하위\)/);
		const second = md.split("## 결과 2")[1]?.split("## 결과 3")[0] ?? "";
		expect(second).toContain("- sub: 있음 `src/a.ts` / 없음 `https://x.test/doc`, `src/b.ts`");
		expect(second).not.toContain("12345`");
		expect(md).not.toContain(TOKEN);
		expect(md).not.toContain(EMAIL);
		expect(md).not.toContain(RRN);
	});

	test("a cut state without compaction and call 1 has no results", () => {
		const first = renderTraceInputs(home, 1, 1, NOW, where());
		if (!first.ok) throw new Error(first.message);
		expect(first.markdown).toContain("이 호출 앞에 받은 도구 결과: 0건");
	});

	test("a remote TASK with only a preview is not comparable", () => {
		const db = new Database(join(home, "ompbot.db"), { strict: true });
		db.run(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
			   acceptance_json, created_at, updated_at, worker_model)
			 VALUES ('T-1', 't', 'L2', ?, 'D1:1', 'remote', '/r', '/wt', 'b', 'ag', 'done', '[]', ?, ?, 'zai/glm-5.3')`,
			[ORIGIN, T0 + 330, T0 + 330],
		);
		db.run(
			"INSERT INTO herdr_prompts (host, agent, kind, preview, origin_key, at) VALUES ('', 'ag', 'start', ?, ?, ?)",
			[`지시 ${EMAIL}`, ORIGIN, T0 + 331],
		);
		db.close();
		const worker = spans(traceOf().root).find((span) => span.id === "T-1");
		expect(worker?.briefPartial).toBe(true);
		expect(worker?.briefBytes).toBeUndefined();
		expect(worker?.briefPreview).not.toContain(EMAIL);
		const out = renderTraceInputs(home, 1, undefined, NOW, where());
		if (!out.ok) throw new Error(out.message);
		expect(out.markdown).toContain("- T-1: 비교 불가(미리보기만)");
		expect(out.markdown).not.toContain(EMAIL);
	});

	test("identifiers are paths, urls and backticked symbols only", () => {
		expect(identifiersOf("see src/a.ts:12, https://x.test/y. `foo.bar()` 12345 plain a/b and `99`")).toEqual([
			"https://x.test/y",
			"src/a.ts",
			"foo.bar()",
		]);
	});

	test("--call 0 and out of range are input errors; a relative --out is relative to the cwd", () => {
		expect(renderTraceInputs(home, 1, 0, NOW, where()).ok).toBe(false);
		const range = renderTraceInputs(home, 1, 3, NOW, where());
		expect(range.ok === false && range.message).toBe("--call must be 1..2");
		const cwd = join(home, "cwd");
		mkdirSync(cwd);
		const env = { HOME: where().userHome, PI_CODING_AGENT_DIR: join(home, "omp-agent") };
		const code = traceInputsCommand(["1", "--out", "sub/dump.md"], home, env, cwd);
		expect(code).toBe(0);
		expect(existsSync(join(cwd, "sub", "dump.md"))).toBe(true);
		expect(readFileSync(join(cwd, "sub", "dump.md"), "utf8")).not.toContain(PHONE);
		expect(traceInputsCommand(["1", "--call", "0"], home, env, cwd)).toBe(2);
	});
});
