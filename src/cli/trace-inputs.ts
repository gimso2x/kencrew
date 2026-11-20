import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { readTurnSource, type TraceError, type TraceWhere, type WorkerBrief } from "../dashboard/trace";
import { maskText, messageText, readBrief, readJsonlRecords } from "../dashboard/trace-transcript";
import { isRecord } from "../omp/type-guards";
import { byteLength, truncateUtf8, truncateUtf8Tail } from "../redact";
import { sourceAgentDir } from "./omp";

export const TRACE_INPUTS_USAGE = `  trace-inputs <inboundId> [--call N] [--out <path>]
                                 write a masked md that sets a turn's tool results beside what the model call N (default: the
                                 last one) had of them (full, cut a/b lines, summary only after a compaction, another session)
                                 and beside the briefs handed to sub-agents and workers (which identifiers of the result the
                                 brief lacks); --out default <workspaceDir>/traces/<inboundId>.md, a relative --out is
                                 relative to the cwd. Reads the omp session files read-only; secrets and personal data are masked
`;

/** Each side of a result is cut to this many UTF-8 bytes (head and tail); a result up to twice that is shown whole. */
const EXCERPT_BYTES = 1024;
/** Sub-agents of sub-agents are read this deep (as the trace does). */
const DEPTH_LIMIT = 2;

type Json = Record<string, unknown>;

interface ToolResult {
	/** `main`, or the sub-agent's name. */
	session: string;
	tool: string;
	intent: string;
	at: number;
	/** Entry index in its own file. */
	index: number;
	text: string;
	truncation?: { shown: number; total: number };
}

interface Brief {
	name: string;
	start: number;
	text?: string;
	preview?: string;
	partial: boolean;
}

const timeOf = (entry: Json): number => Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "");
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Tool results of one session file inside the window, and where each model call and compaction sits in it. */
function readSession(
	file: string,
	session: string,
	window: { from: number; to: number },
): {
	results: ToolResult[];
	calls: Array<{ index: number; at: number; model: string }>;
	compactions: Array<{ index: number; keptAt: number }>;
} {
	const records = readJsonlRecords(file);
	const out = {
		results: [] as ToolResult[],
		calls: [] as Array<{ index: number; at: number; model: string }>,
		compactions: [] as Array<{ index: number; keptAt: number }>,
	};
	const asked = new Map<string, { tool: string; intent: string }>();
	for (const [index, entry] of records.entries()) {
		const at = timeOf(entry);
		if (Number.isNaN(at) || at < window.from || at > window.to) continue;
		if (entry.type === "compaction") {
			const kept = typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined;
			out.compactions.push({
				index,
				keptAt: kept === undefined ? -1 : records.findIndex((record) => record.id === kept),
			});
			continue;
		}
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		if (message === undefined) continue;
		if (message.role === "assistant") {
			out.calls.push({ index, at, model: typeof message.model === "string" ? message.model : "model" });
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
				const args = isRecord(part.arguments) ? part.arguments : {};
				asked.set(part.id, {
					tool: typeof part.name === "string" ? part.name : "tool",
					intent: typeof args.i === "string" ? args.i : "",
				});
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const call = asked.get(message.toolCallId);
			if (call === undefined) continue;
			const truncation =
				isRecord(message.details) && isRecord(message.details.truncation) ? message.details.truncation : undefined;
			out.results.push({
				session,
				tool: call.tool,
				intent: call.intent,
				at,
				index,
				text: messageText(message),
				...(truncation?.truncated === true
					? { truncation: { shown: num(truncation.outputLines) ?? 0, total: num(truncation.totalLines) ?? 0 } }
					: {}),
			});
		}
	}
	return out;
}

/** The sub-agents under `<stem>/` (their results and briefs), `depth` levels down. */
function readSubAgents(
	dir: string,
	window: { from: number; to: number },
	depth: number,
): { results: ToolResult[]; briefs: Brief[] } {
	const found = { results: [] as ToolResult[], briefs: [] as Brief[] };
	if (depth > DEPTH_LIMIT || !existsSync(dir)) return found;
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".jsonl")) continue;
		const name = file.slice(0, -".jsonl".length);
		const path = join(dir, file);
		const first = readJsonlRecords(path)
			.map(timeOf)
			.find((at) => !Number.isNaN(at));
		if (first === undefined || first > window.to) continue;
		const brief = readBrief(path);
		if (brief !== undefined) found.briefs.push({ name, start: first, text: maskText(brief.text), partial: false });
		found.results.push(...readSession(path, name, window).results);
		const deeper = readSubAgents(join(dir, name), window, depth + 1);
		found.results.push(...deeper.results);
		found.briefs.push(...deeper.briefs);
	}
	return found;
}

/** File paths (with an extension), URLs and backticked code symbols of masked text; bare numbers and plain words are not identifiers. */
export function identifiersOf(masked: string): string[] {
	const found = new Set<string>();
	const urls = masked.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? [];
	for (const url of urls) found.add(url.replace(/[.,;:]+$/, ""));
	const rest = masked.replace(/https?:\/\/[^\s<>"'`)\]]+/g, " ");
	for (const raw of rest.split(/[\s"'`()<>[\]{},;]+/)) {
		const token = raw.replace(/:\d+(?::\d+)?$/, "").replace(/[.:]+$/, "");
		if (/^(?:~|\.{1,2})?\/?[\w@.+~-]+(?:\/[\w@.+~-]+)+$/.test(token) && /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(token)) {
			found.add(token);
		}
	}
	for (const match of masked.matchAll(/`([^`\n]+)`/g)) {
		const symbol = (match[1] ?? "").trim();
		if (symbol.length >= 2 && symbol.length <= 80 && /^[A-Za-z_$@./~]\S*$/.test(symbol) && /[A-Za-z]/.test(symbol)) {
			found.add(symbol);
		}
	}
	return [...found];
}

/** `text` as the whole when it fits twice the excerpt, else its head and tail (cut on code points). */
function excerpt(text: string): string {
	if (byteLength(text) <= 2 * EXCERPT_BYTES) return text;
	const head = truncateUtf8(text, EXCERPT_BYTES);
	const tail = truncateUtf8Tail(text, EXCERPT_BYTES);
	return `${head}\n…(가운데 ${byteLength(text) - byteLength(head) - byteLength(tail)}바이트 생략)…\n${tail}`;
}

/** A code fence longer than any backtick run inside `body`. */
function fenced(body: string): string {
	const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return `${fence}text\n${body}\n${fence}`;
}

export type TraceInputsResult = { ok: true; markdown: string } | { ok: false; message: string };

const ERRORS: Record<TraceError, string> = {
	no_database: "no ompbot.db in the home",
	unknown_turn: "no such inbound row",
	not_dispatched: "the turn is not dispatched yet",
	no_session: "the turn's omp session file was not found",
	unsupported_card: "unsupported card",
	unknown_job: "unknown job",
};

/**
 * The md for model call `call` (1-based among the turn window's assistant messages; default the last): every tool
 * result received before it with the state it was in at that call, and the briefs handed down after it came in. Masked
 * (secrets, then personal data) before any cut.
 */
export function renderTraceInputs(
	homeDir: string,
	inboundId: number,
	call: number | undefined,
	now: number,
	where: TraceWhere,
): TraceInputsResult {
	const source = readTurnSource(homeDir, inboundId, now, where);
	if (!source.ok) return { ok: false, message: ERRORS[source.error] };
	const window = { from: source.from, to: source.to };
	const main = readSession(source.file, "main", window);
	if (main.calls.length === 0) return { ok: false, message: "the turn has no model call yet" };
	const callNo = call ?? main.calls.length;
	if (!Number.isInteger(callNo) || callNo < 1 || callNo > main.calls.length) {
		return { ok: false, message: `--call must be 1..${main.calls.length}` };
	}
	const target = main.calls[callNo - 1] as (typeof main.calls)[number];
	const subs = readSubAgents(source.file.replace(/\.jsonl$/, ""), window, 1);
	const briefs: Brief[] = [
		...subs.briefs,
		...source.workers.map((worker): Brief => workerBrief(worker.id, worker.start, worker.brief)),
	].filter((brief) => brief.start < target.at);

	const received = [
		...main.results.filter((result) => result.index < target.index),
		...subs.results.filter((result) => result.at < target.at),
	].sort((a, b) => a.at - b.at);
	const stateOf = (result: ToolResult): string => {
		if (result.session !== "main") return "다른 세션(하위)";
		const summarised = main.compactions.some(
			(compaction) =>
				compaction.index > result.index &&
				compaction.index < target.index &&
				(compaction.keptAt < 0 || result.index < compaction.keptAt),
		);
		if (summarised) return "압축으로 요약만";
		return result.truncation === undefined ? "전체" : `잘림 ${result.truncation.shown}/${result.truncation.total}줄`;
	};

	const lines: string[] = [
		`# 턴 입력 대조 — inbound ${inboundId}`,
		"",
		`- 대상 호출: ${callNo}/${main.calls.length} (${target.model}, ${new Date(target.at).toISOString()})`,
		`- 이 호출 앞에 받은 도구 결과: ${received.length}건`,
		"",
	];
	received.forEach((result, i) => {
		const text = maskText(result.text);
		const ids = identifiersOf(text);
		lines.push(
			`## 결과 ${i + 1} — ${result.tool}${result.intent === "" ? "" : ` · ${maskText(result.intent).replace(/\s+/g, " ")}`}`,
			"",
			`- 세션: ${result.session}`,
			`- 가운데(호출 ${callNo} 시점 상태): ${stateOf(result)}`,
			"",
			`### 왼쪽 — 도구 결과 (가림 뒤 ${byteLength(text)}바이트)`,
			"",
			fenced(excerpt(text)),
			"",
			"### 오른쪽 — 넘긴 브리프와 식별자 대조",
			"",
		);
		const handed = result.session === "main" ? briefs.filter((brief) => brief.start >= result.at) : [];
		if (handed.length === 0) lines.push("- 이 결과 뒤에 넘긴 브리프 없음", "");
		for (const brief of handed) {
			if (brief.partial) {
				lines.push(`- ${brief.name}: 비교 불가(미리보기만)`);
			} else if (ids.length === 0) {
				lines.push(`- ${brief.name}: 결과에 뽑을 식별자 없음`);
			} else {
				const text2 = brief.text ?? "";
				const has = ids.filter((id) => text2.includes(id));
				const lacks = ids.filter((id) => !text2.includes(id));
				lines.push(
					`- ${brief.name}: 있음 ${has.length === 0 ? "-" : has.map((id) => `\`${id}\``).join(", ")} / 없음 ${lacks.length === 0 ? "-" : lacks.map((id) => `\`${id}\``).join(", ")}`,
				);
			}
		}
		if (handed.length > 0) lines.push("");
	});
	if (briefs.length > 0) lines.push("## 브리프 원문", "");
	for (const brief of briefs) {
		lines.push(`### ${brief.name}`, "");
		lines.push(brief.partial ? `미리보기만(${brief.preview ?? ""})` : fenced(brief.text ?? ""), "");
	}
	return { ok: true, markdown: `${lines.join("\n")}\n` };
}

function workerBrief(id: string, start: number, brief: WorkerBrief | undefined): Brief {
	if (brief === undefined) return { name: id, start, partial: true };
	return brief.partial === true || brief.text === undefined
		? { name: id, start, preview: brief.preview, partial: true }
		: { name: id, start, text: maskText(brief.text), partial: false };
}

const usage = (message: string): number => {
	process.stderr.write(`trace-inputs: ${message}\n${TRACE_INPUTS_USAGE}`);
	return 2;
};

/** `ompbot trace-inputs`: writes the md (masked once more as a whole) and prints its path. */
export function traceInputsCommand(
	args: string[],
	homeDir: string,
	env: Record<string, string | undefined> = process.env,
	cwd: string = process.cwd(),
): number {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { call: { type: "string" }, out: { type: "string" } },
	});
	const [id, ...extra] = positionals;
	if (id === undefined || !/^\d+$/.test(id) || extra.length > 0) return usage("one <inboundId> (digits) is required");
	if (values.call !== undefined && !/^\d+$/.test(values.call)) return usage("--call must be a whole number");
	const where = { userHome: env.HOME ?? homedir(), sessionsRoot: join(sourceAgentDir(env), "sessions") };
	const result = renderTraceInputs(
		homeDir,
		Number(id),
		values.call === undefined ? undefined : Number(values.call),
		Date.now(),
		where,
	);
	if (!result.ok) return usage(result.message);
	const target =
		values.out === undefined
			? join(resolve(loadConfig(homeDir, { checkTokens: false }).workspaceDir), "traces", `${id}.md`)
			: resolve(cwd, values.out);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, maskText(result.markdown));
	process.stdout.write(`${target}\n`);
	return 0;
}
