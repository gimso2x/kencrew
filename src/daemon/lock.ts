import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

export interface LockInfo {
	pid: number;
	bootId: string;
	startedAt: number;
}

/** An unreadable lock younger than this may be a starter between create and write: it is held, not stale. */
export const UNREADABLE_LOCK_GRACE_MS = 10_000;

export class LockHeldError extends Error {
	/** Undefined: the lock file is unreadable but too fresh to be called stale. */
	readonly holder: LockInfo | undefined;
	/** `reclaim`: the barrier file another starter holds while it replaces a stale lock. */
	constructor(path: string, holder: LockInfo | undefined, reclaim?: string, notFile = false) {
		super(
			notFile
				? `already_running: lock path ${path} is not a regular file (remove or move it by hand)`
				: reclaim !== undefined
					? `already_running: lock ${path} is being reclaimed by another starter (${reclaim} exists; if that starter died mid-reclaim, remove ${reclaim} by hand)`
					: holder === undefined
						? `already_running: lock ${path} is unreadable and newer than ${UNREADABLE_LOCK_GRACE_MS / 1000}s (another starter is writing it)`
						: `already_running: lock ${path} is held by pid ${holder.pid}`,
		);
		this.name = "LockHeldError";
		this.holder = holder;
	}
}

/** Kernel boot id: a pid recorded before a reboot must never look alive just because the number was reused. */
export function currentBootId(): string {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		return "unknown";
	}
}

/** Whether process `pid` exists on this machine: `kill(pid, 0)` succeeds, or fails with EPERM (someone else's process). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function readLock(path: string): LockInfo | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"pid" in parsed &&
			typeof parsed.pid === "number" &&
			"bootId" in parsed &&
			typeof parsed.bootId === "string" &&
			"startedAt" in parsed &&
			typeof parsed.startedAt === "number"
		) {
			return { pid: parsed.pid, bootId: parsed.bootId, startedAt: parsed.startedAt };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Age of the lock file by mtime; a file that vanished meanwhile counts as old (the retry recreates it). */
function lockAgeMs(path: string, now: number): number {
	try {
		return now - statSync(path).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** True when something other than a regular file sits at `path`; a missing path is not (the retry recreates it). */
function pathIsNotFile(path: string): boolean {
	try {
		return !statSync(path).isFile();
	} catch {
		return false;
	}
}

export interface Lock {
	info: LockInfo;
	release(): void;
}

/**
 * Exclusive create of `path` holding `{pid, bootId, startedAt}`. The content is written to a private file first and
 * hard-linked into place, so the lock never exists empty. An existing lock is stale (and replaced) when its process
 * is dead, its boot id differs from this boot, or the file is unreadable and older than `UNREADABLE_LOCK_GRACE_MS`;
 * otherwise acquisition is refused.
 */
export function acquireLock(path: string, now: number = Date.now()): Lock {
	const info: LockInfo = { pid: process.pid, bootId: currentBootId(), startedAt: now };
	for (let attempt = 0; attempt < 3; attempt++) {
		const staged = `${path}.${process.pid}.tmp`;
		const fd = openSync(staged, "w", 0o600);
		try {
			writeSync(fd, JSON.stringify(info));
		} finally {
			closeSync(fd);
		}
		let linked = false;
		try {
			linkSync(staged, path);
			linked = true;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
				unlinkSync(staged);
				throw error;
			}
		}
		unlinkSync(staged);
		if (linked) {
			return {
				info,
				release() {
					const held = readLock(path);
					if (held?.pid === info.pid && held.bootId === info.bootId) unlinkSync(path);
				},
			};
		}
		reclaimStale(path, info.bootId, now);
	}
	throw new Error(`lock_unavailable: ${path}`);
}

/**
 * Throws `LockHeldError` when the lock at `path` is held (a live process of this boot, or unreadable and fresh);
 * otherwise whether a stale file is there to remove (false: it is gone).
 */
function stalePresent(path: string, bootId: string, now: number): boolean {
	// A directory (or any other non-file) at the lock path is never ours to remove: the owner has to fix it.
	if (pathIsNotFile(path)) throw new LockHeldError(path, undefined, undefined, true);
	const holder = readLock(path);
	if (holder && holder.bootId === bootId && pidAlive(holder.pid)) throw new LockHeldError(path, holder);
	if (holder !== undefined) return true;
	const age = lockAgeMs(path, now);
	if (age < UNREADABLE_LOCK_GRACE_MS) throw new LockHeldError(path, undefined);
	return age !== Number.POSITIVE_INFINITY;
}

/**
 * Removes a stale lock behind the exclusive `<path>.reclaim` barrier, looking at the lock again once the barrier is
 * held: a starter that judged the same stale lock never removes the lock another starter has taken since. A barrier
 * that already exists refuses at once — removing a leftover one by its age would reopen the same race — and the error
 * names it, for the owner to remove by hand when its starter died mid-reclaim.
 */
function reclaimStale(path: string, bootId: string, now: number): void {
	if (!stalePresent(path, bootId, now)) return;
	const reclaim = `${path}.reclaim`;
	let fd: number;
	try {
		fd = openSync(reclaim, "wx", 0o600);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST")
			throw new LockHeldError(path, undefined, reclaim);
		throw error;
	}
	closeSync(fd);
	try {
		if (stalePresent(path, bootId, now)) unlinkSync(path);
	} finally {
		unlinkSync(reclaim);
	}
}
