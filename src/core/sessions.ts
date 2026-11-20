import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { CURRENT_REQUEST_MARKER } from "./types";

/** One omp session file of an origin, as listed by `/resume-ompbot`. */
export interface SavedSession {
	/** Absolute path of the `.jsonl` file. */
	file: string;
	/** omp session id (from the `session` header line); the file name when the header is unreadable. */
	id: string;
	/** Epoch directory (`e<N>`) the file lives in. */
	epochDir: string;
	modifiedAt: number;
	/** First user message, shortened; `""` when the session has none yet. */
	preview: string;
}

const HEAD_BYTES = 64 * 1024;
const PREVIEW_CHARS = 60;

function readHead(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) =>
			typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
				? String(part.text ?? "")
				: "",
		)
		.join("");
}

/** The owner's request of a turn prompt that carries context blocks (`composeTurnPrompt`); the text as is without blocks. */
function requestOf(prompt: string): string {
	const marker = `\n\n${CURRENT_REQUEST_MARKER}\n`;
	const at = prompt.indexOf(marker);
	return at === -1 ? prompt : prompt.slice(at + marker.length);
}

/** Session id and first user message from the first 64 KiB of a session file (complete lines only). */
function describe(file: string): { id: string | undefined; preview: string } {
	let id: string | undefined;
	let preview = "";
	const lines = readHead(file).split("\n");
	lines.pop(); // possibly cut off
	for (const line of lines) {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof record !== "object" || record === null || !("type" in record)) continue;
		if (record.type === "session" && "id" in record && typeof record.id === "string") id = record.id;
		if (record.type === "message" && "message" in record) {
			const message = record.message as { role?: unknown; content?: unknown } | null;
			if (message?.role === "user") {
				preview = requestOf(textOf(message.content)).replace(/\s+/g, " ").trim();
				break;
			}
		}
	}
	if (preview.length > PREVIEW_CHARS) preview = `${preview.slice(0, PREVIEW_CHARS)}…`;
	return { id, preview };
}

/** Every session file under `<originDir>/e<N>/`, newest first. */
export function listSavedSessions(originDir: string): SavedSession[] {
	if (!existsSync(originDir)) return [];
	const root = realpathSync(originDir);
	const sessions: SavedSession[] = [];
	for (const epochDir of readdirSync(originDir)) {
		if (!/^e\d+$/.test(epochDir)) continue;
		const dir = join(originDir, epochDir);
		if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(dir, name);
			// Only a regular file of this origin: a FIFO would block the open, a directory or dangling link would throw,
			// and a link out of the origin's root would list (and pin) another origin's session.
			const stat = statSync(file, { throwIfNoEntry: false });
			if (stat?.isFile() !== true) continue;
			if (!realpathSync(file).startsWith(`${root}${sep}`)) continue;
			const { id, preview } = describe(file);
			sessions.push({
				file,
				id: id ?? name.slice(0, -".jsonl".length),
				epochDir,
				modifiedAt: stat.mtimeMs,
				preview,
			});
		}
	}
	return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** The resume pointer an agy origin keeps in its epoch directory instead of an omp `.jsonl` (`agy-driver.ts`). */
const AGY_POINTER = "agy-conversation.json";

/** True when the epoch directory holds no session (an omp `.jsonl` or the agy pointer) yet: the next child open creates the origin's first one. */
export function epochDirIsFresh(sessionDir: string): boolean {
	if (!existsSync(sessionDir)) return true;
	return !readdirSync(sessionDir).some((name) => name.endsWith(".jsonl") || name === AGY_POINTER);
}

/**
 * `/resume-ompbot <arg>`: a 1-based index into `sessions` (when in range), else a unique session-id prefix of at least 4
 * characters (ids can start with digits).
 */
export function pickSession(sessions: readonly SavedSession[], arg: string): SavedSession | undefined {
	if (/^\d+$/.test(arg)) {
		const indexed = sessions[Number(arg) - 1];
		if (indexed) return indexed;
	}
	if (arg.length < 4) return undefined;
	const matches = sessions.filter((session) => session.id.startsWith(arg));
	return matches.length === 1 ? matches[0] : undefined;
}
