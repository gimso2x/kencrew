import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSavedSessions } from "../src/core/sessions";
import { readStatusFromDb, renderStatusText } from "../src/daemon/status";
import { checkOmpRuntime } from "../src/omp/runtime-check";
import { listsBefore, newestSessionFile } from "../src/omp/session-heal";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";

const root = mkdtempSync(join(tmpdir(), "ompbot-qa50b-lane-l-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("qa50b-low lane L", () => {
	test("L-6 an ompExecutable that is a directory is a runtime problem, not an exception", async () => {
		const dir = join(root, "omp-dir");
		mkdirSync(dir);
		expect(await checkOmpRuntime(dir)).toMatchObject({
			code: "omp_executable_missing",
			detail: expect.stringContaining(`path=${dir}`),
		});
	});

	test("a grandchild holding stdout open cannot outlast the version timeout", async () => {
		const script = join(root, "omp-grandchild.sh");
		writeFileSync(script, "#!/bin/sh\necho omp/19.0.0\nsetsid sleep 20 &\nsleep 20\n", { mode: 0o755 });
		const started = performance.now();
		const found = await checkOmpRuntime(script, { PATH: process.env.PATH }, 300);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(found).toMatchObject({ code: "omp_executable_missing", detail: expect.stringContaining("error=timeout") });
	});

	test("a plain file named like an epoch directory is skipped by listSavedSessions", () => {
		const origin = join(root, "origin-plain-file");
		mkdirSync(join(origin, "e1"), { recursive: true });
		writeFileSync(join(origin, "e1", "a.jsonl"), "");
		writeFileSync(join(origin, "e2"), "not a directory");
		expect(listSavedSessions(origin).map((session) => session.epochDir)).toEqual(["e1"]);
	});

	test("a dangling .jsonl symlink is skipped by newestSessionFile", () => {
		const dir = join(root, "heal-dangling");
		mkdirSync(dir);
		writeFileSync(join(dir, "b.jsonl"), "");
		symlinkSync(join(dir, "gone"), join(dir, "a.jsonl"));
		expect(newestSessionFile(dir)).toBe(join(dir, "b.jsonl"));
	});

	test("L-7 a full tie lists the later path first, as omp's own listing does", () => {
		const at = { mtimeMs: 1000, createdMs: 900 };
		const a = { ...at, name: "2026-11-12_a.jsonl" };
		const b = { ...at, name: "2026-11-12_b.jsonl" };
		expect(listsBefore(b, a)).toBe(true);
		expect(listsBefore(a, b)).toBe(false);
		// mtime, then creation time, still decide first.
		expect(listsBefore({ ...a, mtimeMs: 1001 }, b)).toBe(true);
		expect(listsBefore({ ...a, createdMs: 901 }, b)).toBe(true);
	});

	test("L-이관2 a 0-byte or non-database ompbot.db gives a status report with ledger_unreadable, not an SQLiteError", () => {
		for (const [name, bytes] of [
			["empty", ""],
			["garbage", "this is not a sqlite database at all, just text padding the header out. ".repeat(4)],
		] as const) {
			const home = join(root, `status-${name}`);
			mkdirSync(home);
			const dbPath = join(home, "ompbot.db");
			writeFileSync(dbPath, bytes);
			const report = readStatusFromDb(dbPath, "omp-test 0", "Asia/Seoul", {}, IDLE_HOST_LOAD);
			expect(report.daemonRunning).toBe(false);
			expect(report.origins).toEqual([]);
			expect(report.openGates.map((gate) => gate.name)).toContain("ledger_unreadable");
			expect(JSON.parse(JSON.stringify(report))).toMatchObject({ openGates: expect.any(Array) });
			expect(renderStatusText(report)).toContain("ledger_unreadable");
		}
	});
});
