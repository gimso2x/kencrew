import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PURPOSE_HEADER, ROTATION_CONTEXT_HEADER, THREAD_CONTEXT_HEADER } from "../core/mailbox";
import { QUOTED_HEADER } from "../core/normalize";
import { RECALL_HEADER } from "../core/recall";
import { CURRENT_REQUEST_MARKER } from "../core/types";
import { BOARD_NOTICE_HEAD } from "../lanes/board";
import { isRecord } from "../omp/type-guards";
import { byteLength, maskPersonal, redact } from "../redact";
import { INJECTION_WARNING_HEAD } from "../safety/injection";
import { PEER_NOTICE_HEAD } from "../safety/prompt";
import type { TraceInput, TraceSpan } from "./trace";

/**
 * An omp session transcript (`<session>.jsonl`, sub-agents in `<session>/<name>.jsonl`) as spans on a turn's clock.
 * Of its text only the tool's intent line (`i`), a failed tool's first output, a failed model call's error and a
 * sub-agent's brief preview leave, masked and cut; everything else is sizes and marks.
 */

/** Spans kept per transcript (the newest ones); a longer turn says `truncated`. */
const SPAN_LIMIT = 400;
/** Sub-agents of sub-agents are read this deep. */
const DEPTH_LIMIT = 2;
const DETAIL_CHARS = 60;
const ERROR_CHARS = 160;
export const BRIEF_PREVIEW_CHARS = 120;

type Json = Record<string, unknown>;
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
/** Secrets, then personal data, then the cut: a cut never leaves half of a masked shape. */
export const maskText = (value: string): string => maskPersonal(redact(value));
export const oneLineText = (value: unknown, limit: number): string | undefined => {
	if (typeof value !== "string") return undefined;
	const line = maskText(value).replace(/\s+/g, " ").trim();
	if (line === "") return undefined;
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const text = oneLineText;

/** The text parts of a session message (a string content counts as one part). */
export function messageText(message: Json): string {
	if (typeof message.content === "string") return message.content;
	return (Array.isArray(message.content) ? message.content : [])
		.filter((part): part is Json => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

/** The first user message of a session file (what its agent was told to do): its size and masked first words. */
export function readBrief(file: string): { text: string; bytes: number; preview: string } | undefined {
	for (const entry of readJsonlRecords(file)) {
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		if (message?.role !== "user") continue;
		const body = messageText(message);
		if (body.trim() === "") continue;
		return { text: body, bytes: byteLength(body), preview: oneLineText(body, BRIEF_PREVIEW_CHARS) ?? "" };
	}
	return undefined;
}

// Heads of what `composeTurnPrompt` puts in front of the request, as far as the header's own words go.
const headOf = (header: string): string => header.slice(0, header.search(/ —|\]/));
const BLOCK_HEADS: Array<[string, string]> = [
	[headOf(PEER_NOTICE_HEAD), "안내"],
	[headOf(ROTATION_CONTEXT_HEADER), "회전 맥락"],
	[headOf(THREAD_CONTEXT_HEADER), "스레드 맥락"],
	[headOf(PURPOSE_HEADER), "용도"],
	[headOf(RECALL_HEADER), "회상"],
	[headOf(BOARD_NOTICE_HEAD), "게시판"],
	[headOf(QUOTED_HEADER), "인용"],
];
const FENCED = /<<<quoted-([^>\n]*)>>>[\s\S]*?<<<end-quoted-\1>>>/g;

/** The label of a block that starts with an optional injection warning line and then a known head; else undefined. */
function blockHead(text: string, at: number): { label: string; warned: boolean } | undefined {
	let rest = text.slice(at);
	const warned = rest.startsWith(INJECTION_WARNING_HEAD);
	if (warned) {
		const lineEnd = rest.indexOf("\n");
		rest = lineEnd < 0 ? "" : rest.slice(lineEnd + 1);
	}
	const known = BLOCK_HEADS.find(([head]) => rest.startsWith(head));
	return known === undefined ? undefined : { label: known[1], warned };
}

/**
 * A turn's first user message as the blocks `composeTurnPrompt` put before the request (label, bytes, whether the
 * block carries an injection warning) and the request itself. The request is cut off at the last request marker; in the
 * blocks only a head after a blank line outside quote fences starts a block, so a head-looking line in a pasted quote
 * or in the request is no block. Text before the first known head is one `기타` block.
 */
export function splitTurnPrompt(prompt: string): TraceInput[] {
	const marker = `\n\n${CURRENT_REQUEST_MARKER}\n`;
	const cutAt = prompt.lastIndexOf(marker);
	const request = (body: string): TraceInput => ({ label: "현재 요청", bytes: byteLength(body), warned: false });
	if (cutAt < 0) return [request(prompt)];
	const blocks = prompt.slice(0, cutAt);
	const fenced: Array<[number, number]> = [];
	for (const match of blocks.matchAll(FENCED)) fenced.push([match.index, match.index + match[0].length]);
	const lastClosed = fenced.at(-1)?.[1] ?? 0;
	const open = blocks.slice(lastClosed).search(/<<<quoted-[^>\n]*>>>/);
	if (open >= 0) fenced.push([lastClosed + open, blocks.length]);
	const starts = [0];
	for (let at = blocks.indexOf("\n\n"); at >= 0; at = blocks.indexOf("\n\n", at + 1)) {
		if (fenced.some(([from, to]) => at >= from && at < to)) continue;
		if (blockHead(blocks, at + 2) !== undefined) starts.push(at + 2);
	}
	const inputs = starts.map((start, i): TraceInput => {
		const piece = blocks.slice(start, i + 1 < starts.length ? (starts[i + 1] as number) - 2 : blocks.length);
		const head = blockHead(blocks, start);
		return { label: head?.label ?? "기타", bytes: byteLength(piece), warned: head?.warned ?? false };
	});
	return [...inputs, request(prompt.slice(cutAt + marker.length))];
}

/** The part of the session that belongs to the turn. */
export interface TranscriptWindow {
	from: number;
	to: number;
	/** The turn is still dispatched: open spans run into "now". */
	live: boolean;
	/** The turn's dispatch: every span time counts from here. */
	origin: number;
}

/** Where a transcript sits: 0 = the turn's own session; `prefix` keeps a sub-agent's entry ids apart from its parent's. */
interface Scope {
	depth: number;
	prefix: string;
}

export interface Transcript {
	spans: TraceSpan[];
	first?: number;
	/** The last message inside the window. */
	lastIn?: number | undefined;
	model?: string;
	/** Its last model call ended the conversation (`stop`) or failed (`error`/`aborted`). */
	ending?: "stop" | "failed";
	truncated: boolean;
	/** The turn's first prompt taken apart (session's own turn only, not a sub-agent's). */
	inputs?: TraceInput[];
}

/** The object records of a session `.jsonl`, skipping the torn line omp may be writing. */
export function readJsonlRecords(file: string): Json[] {
	const out: Json[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (isRecord(entry)) out.push(entry);
		} catch (error) {
			// The line omp is writing right now; the next read has it whole.
			if (error instanceof SyntaxError) continue;
			throw error;
		}
	}
	return out;
}

/** A model call: from its request to its `completedAt` (the record's own time when that is missing). */
function modelSpan(message: Json, at: number, origin: number): Omit<TraceSpan, "id"> {
	const usage = isRecord(message.usage) ? message.usage : {};
	const calls = Array.isArray(message.content)
		? message.content.filter((part) => isRecord(part) && part.type === "toolCall").map((part) => String(part.name))
		: [];
	const failed = message.stopReason === "error" || message.stopReason === "aborted";
	const end = num(message.completedAt) ?? at;
	const model = typeof message.model === "string" ? message.model : "model";
	const tokensIn = (num(usage.input) ?? 0) + (num(usage.cacheRead) ?? 0) + (num(usage.cacheWrite) ?? 0);
	const cost = isRecord(usage.cost) ? num(usage.cost.total) : undefined;
	const error = failed ? text(message.errorMessage, ERROR_CHARS) : undefined;
	return {
		name: model,
		kind: "llm",
		status: failed ? "failed" : "done",
		start: (num(message.timestamp) ?? end - (num(message.duration) ?? 0)) - origin,
		end: end - origin,
		model,
		...(calls.length > 0
			? { detail: `→ ${calls.join(" · ")}` }
			: message.stopReason === "stop"
				? { detail: "답변" }
				: {}),
		...(tokensIn > 0 ? { tokensIn } : {}),
		...(num(usage.output) === undefined ? {} : { tokensOut: num(usage.output) }),
		...(cost === undefined ? {} : { cost }),
		...(error === undefined ? {} : { error }),
	};
}

/** One transcript's spans inside the window, with its sub-agents (the `<stem>/*.jsonl` beside it) as children. */
export function readTranscript(
	file: string,
	window: TranscriptWindow,
	scope: Scope = { depth: 0, prefix: "" },
): Transcript {
	const { origin } = window;
	const result: Transcript = { spans: [], truncated: false };
	const calls = new Map<string, TraceSpan>();
	let tail: "model" | "other" = "other";
	/** The last message inside the window: where an unanswered tool call stops and the next model call starts. */
	let lastIn: number | undefined;
	const records = readJsonlRecords(file);
	/** Entry index (file order) of each answered tool call in the window. */
	const answeredAt: number[] = [];
	/** Set by a compaction: the next model call carries how many of the turn's tool results it summarised. */
	let compacted: number | undefined;
	for (const [index, entry] of records.entries()) {
		const at = Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "");
		if (Number.isNaN(at)) continue;
		result.first ??= at;
		if (entry.type === "model_change" && typeof entry.model === "string") result.model = entry.model;
		if (at < window.from || at > window.to) continue;
		if (entry.type === "compaction") {
			const kept = typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined;
			const keptAt = kept === undefined ? -1 : records.findIndex((record) => record.id === kept);
			compacted = answeredAt.filter((resultAt) => keptAt < 0 || resultAt < keptAt).length;
			const before = num(entry.tokensBefore);
			const after = num(entry.tokensAfter);
			const size =
				before === undefined && after === undefined
					? ""
					: ` ${before === undefined ? "?" : `${Math.round(before / 1000)}k`}→${after === undefined ? "?" : `${Math.round(after / 1000)}k`}`;
			const method = oneLineText(entry.method, DETAIL_CHARS);
			result.spans.push({
				id: `${scope.prefix}${typeof entry.id === "string" ? entry.id : `c${index}`}`,
				name: `압축${size}${method === undefined ? "" : ` · ${method}`}`,
				kind: "compaction",
				status: "done",
				start: at - origin,
				end: at - origin,
			});
			continue;
		}
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		if (message === undefined) continue;
		lastIn = at;
		if (message.role === "assistant") {
			const span: TraceSpan = {
				id: `${scope.prefix}${typeof entry.id === "string" ? entry.id : `m${result.spans.length}`}`,
				...modelSpan(message, at, origin),
			};
			if (compacted !== undefined) {
				span.compactedTools = compacted;
				compacted = undefined;
			}
			result.spans.push(span);
			result.ending = message.stopReason === "stop" ? "stop" : span.status === "failed" ? "failed" : undefined;
			tail = "model";
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
				const intent = isRecord(part.arguments) ? text(part.arguments.i, DETAIL_CHARS) : undefined;
				const tool: TraceSpan = {
					id: `${scope.prefix}${part.id}`,
					name: typeof part.name === "string" ? part.name : "tool",
					kind: "tool",
					status: "running",
					start: span.end ?? span.start,
					...(intent === undefined ? {} : { detail: intent }),
				};
				calls.set(part.id, tool);
				result.spans.push(tool);
			}
		} else if (message.role === "toolResult" || message.role === "user") {
			tail = "other";
			if (message.role === "user" && scope.depth === 0 && result.inputs === undefined) {
				const prompt = messageText(message);
				if (prompt.trim() !== "") result.inputs = splitTurnPrompt(prompt);
			}
			const tool = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
			if (tool === undefined) continue;
			tool.end = at - origin;
			tool.status = message.isError === true ? "failed" : "done";
			answeredAt.push(index);
			tool.resultBytes = byteLength(messageText(message));
			const truncation =
				isRecord(message.details) && isRecord(message.details.truncation) ? message.details.truncation : undefined;
			if (truncation?.truncated === true) {
				tool.truncated = {
					by: typeof truncation.truncatedBy === "string" ? truncation.truncatedBy : "",
					shownLines: num(truncation.outputLines) ?? 0,
					totalLines: num(truncation.totalLines) ?? 0,
				};
			}
			const first = Array.isArray(message.content) ? message.content.find(isRecord) : undefined;
			const error = tool.status === "failed" ? text(first?.text, ERROR_CHARS) : undefined;
			if (error !== undefined) tool.error = error;
		}
	}
	// A tool call never answered ran out with the turn (an abort, a restart); only a live turn keeps it running.
	for (const tool of calls.values()) {
		if (tool.status === "running" && !window.live) {
			tool.status = "failed";
			tool.end = Math.max(tool.start, (lastIn ?? origin) - origin);
		}
	}
	// omp writes a model call when it ends: after a tool result the next one is being generated right now.
	const waiting = [...calls.values()].some((tool) => tool.status === "running");
	if (window.live && scope.depth === 0 && tail === "other" && !waiting && lastIn !== undefined) {
		const name = result.model ?? "model";
		result.spans.push({
			id: `${scope.prefix}pending-model`,
			name,
			kind: "llm",
			status: "running",
			start: lastIn - origin,
			detail: "응답 생성 중",
		});
	}
	result.lastIn = lastIn;
	if (scope.depth < DEPTH_LIMIT) result.spans.push(...subAgents(file.replace(/\.jsonl$/, ""), window, scope));
	result.spans.sort((a, b) => a.start - b.start);
	if (result.spans.length > SPAN_LIMIT) {
		result.spans = result.spans.slice(-SPAN_LIMIT);
		result.truncated = true;
	}
	return result;
}

/** The sub-agents a transcript started (`<stem>/<name>.jsonl`) that wrote a message inside the window. */
function subAgents(dir: string, window: TranscriptWindow, parent: Scope): TraceSpan[] {
	if (!existsSync(dir)) return [];
	const out: TraceSpan[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".jsonl")) continue;
		const name = file.slice(0, -".jsonl".length);
		const id = `${parent.prefix}agent:${name}`;
		const sub = readTranscript(join(dir, file), window, { depth: parent.depth + 1, prefix: `${id}/` });
		if (sub.first === undefined || sub.lastIn === undefined) continue;
		const running = window.live && sub.ending === undefined;
		const brief = readBrief(join(dir, file));
		out.push({
			id,
			name,
			kind: "subagent",
			status: sub.ending === "failed" ? "failed" : running ? "running" : "done",
			start: Math.max(sub.first, window.from) - window.origin,
			...(running ? {} : { end: sub.lastIn - window.origin }),
			...(sub.model === undefined ? {} : { detail: sub.model, model: sub.model }),
			...(brief === undefined ? {} : { briefBytes: brief.bytes, briefPreview: brief.preview }),
			children: sub.spans,
		});
	}
	return out;
}
