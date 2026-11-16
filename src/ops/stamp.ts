import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * Shared k=v stamp plumbing: the sweep heartbeat (`daemon/heartbeat.ts`) and the backup stamp (`ops/backup.ts`)
 * write and read the same `k=v k=v` one-liner format, so the parser and the atomic 0600 write live here once.
 */

/** UTF-8 text of a regular file; throws for anything else, since opening a FIFO or an endless device blocks for good. */
export function readRegularText(path: string): string {
	if (!statSync(path).isFile()) throw new Error(`${path} is not a regular file`);
	return readFileSync(path, "utf8");
}

/** Parses whitespace-separated `k=v` stamp fields into a map (a part without `=` past position 0 is ignored). */
export function parseStampFields(text: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const part of text.trim().split(/\s+/)) {
		const eq = part.indexOf("=");
		if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return fields;
}

/**
 * The stamp's `ts=` field as a `Date`; `undefined` when it is absent or unparseable. The file's mtime is no stand-in:
 * an empty or truncated stamp would read as a sweep or backup that just succeeded (qa-l #12).
 */
export function parseStampTs(fields: Map<string, string>): Date | undefined {
	const rawTs = fields.get("ts");
	if (rawTs === undefined) return undefined;
	const parsed = new Date(rawTs);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Atomic 0600 write (temp + fsync + rename), so a half-written stamp is never observable; returns the final path. */
export function writeAtomic0600(path: string, content: string): string {
	const tmp = `${path}.tmp-${crypto.randomUUID()}`;
	try {
		writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
		const fd = openSync(tmp, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
	return path;
}
