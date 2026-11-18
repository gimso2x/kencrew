import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock, currentBootId, LockHeldError } from "../src/daemon/lock";

// The stale-lock reclaim is serialized by an exclusive `<lock>.reclaim` barrier (doc/plans/muse-review-fixes-1.md §1).

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-lock-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A lock left by an earlier boot: stale whatever its pid is. */
function staleLock(path: string): void {
	writeFileSync(path, JSON.stringify({ pid: process.pid, bootId: "some-earlier-boot", startedAt: 1 }));
}

describe("a directory at the lock path", () => {
	test("an old directory is refused with LockHeldError naming the path and is left in place", () => {
		const path = join(dir, "ompbot.lock");
		mkdirSync(path);
		const old = new Date("2020-01-01T00:00:00Z");
		utimesSync(path, old, old);
		let thrown: unknown;
		try {
			acquireLock(path);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(LockHeldError);
		expect((thrown as LockHeldError).message).toContain(path);
		expect(statSync(path).isDirectory()).toBe(true);
	});
});

describe("stale lock reclaim", () => {
	test("a reclaim barrier left by another starter refuses at once and leaves the stale lock in place", () => {
		const path = join(dir, "ompbot.lock");
		staleLock(path);
		writeFileSync(`${path}.reclaim`, "");
		let refused: unknown;
		try {
			acquireLock(path);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(LockHeldError);
		expect(String(refused)).toContain(`${path}.reclaim`);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ bootId: "some-earlier-boot" });
		expect(existsSync(`${path}.reclaim`)).toBe(true);
	});

	test("a reclaim takes the stale lock and removes its barrier", () => {
		const path = join(dir, "ompbot.lock");
		staleLock(path);
		const lock = acquireLock(path);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: process.pid, bootId: currentBootId() });
		expect(existsSync(`${path}.reclaim`)).toBe(false);
		lock.release();
		expect(existsSync(path)).toBe(false);
	});

	test("starters racing over one stale lock: exactly one holds it", async () => {
		const path = join(dir, "ompbot.lock");
		staleLock(path);
		const module = resolve(import.meta.dir, "../src/daemon/lock.ts");
		// Each starter reports once, then holds (or not) until its stdin closes, so no winner releases before all reported.
		const code = `
			import { acquireLock } from ${JSON.stringify(module)};
			let lock;
			try { lock = acquireLock(${JSON.stringify(path)}); console.log("held"); } catch { console.log("refused"); }
			for await (const _ of Bun.stdin.stream()) {}
			lock?.release();
		`;
		const starters = Array.from({ length: 8 }, () =>
			Bun.spawn([process.execPath, "-e", code], { stdin: "pipe", stdout: "pipe", stderr: "inherit" }),
		);
		const reports = await Promise.all(
			starters.map(async (child) => {
				const reader = child.stdout.getReader();
				let text = "";
				while (!text.includes("\n")) {
					const { value, done } = await reader.read();
					if (done) break;
					text += new TextDecoder().decode(value);
				}
				reader.releaseLock();
				return text.trim();
			}),
		);
		for (const child of starters) child.stdin.end();
		await Promise.all(starters.map((child) => child.exited));
		expect(reports.filter((report) => report === "held")).toHaveLength(1);
		expect(reports.filter((report) => report === "refused")).toHaveLength(starters.length - 1);
	});
});
