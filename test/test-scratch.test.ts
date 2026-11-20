import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { cleanupStaleScratchDirs, isPidAlive, removeScratchDir, SCRATCH_DIR_PREFIX } from "./preload";

const REPO_ROOT = resolve(import.meta.dir, "..");

async function spawnDeadPid(): Promise<number> {
	const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
	const pid = proc.pid;
	await proc.exited;
	return pid;
}

describe("test scratch tmpdir preload", () => {
	test("preload points tmpdir() and child process TMPDIR to ompbot-test-<pid>-*", () => {
		const currentTmp = tmpdir();
		expect(process.env.TMPDIR).toBe(currentTmp);
		expect(basename(currentTmp).startsWith(`${SCRATCH_DIR_PREFIX}${process.pid}-`)).toBe(true);
		expect(statSync(currentTmp).isDirectory()).toBe(true);

		const nodeChild = spawnSync(
			process.execPath,
			["-e", "import { tmpdir } from 'node:os'; process.stdout.write(tmpdir());"],
			{ encoding: "utf8" },
		);
		expect(nodeChild.status).toBe(0);
		expect(nodeChild.stdout).toBe(currentTmp);

		const bunChild = Bun.spawnSync(
			[process.execPath, "-e", "import { tmpdir } from 'node:os'; process.stdout.write(tmpdir());"],
			{ env: process.env },
		);
		expect(bunChild.exitCode).toBe(0);
		expect(new TextDecoder().decode(bunChild.stdout)).toBe(currentTmp);
	});

	test("cleanupStaleScratchDirs removes dead PID dirs and keeps live PID, symlink, and other dirs", async () => {
		const base = mkdtempSync(join(tmpdir(), "scratch-cleanup-"));
		const deadPid = await spawnDeadPid();
		expect(isPidAlive(deadPid)).toBe(false);

		const deadDir = join(base, `${SCRATCH_DIR_PREFIX}${deadPid}-dead`);
		const aliveDir = join(base, `${SCRATCH_DIR_PREFIX}${process.pid}-alive`);
		const otherDir = join(base, "ompbot-other-123");
		const targetDir = join(base, "keep-target");
		const symlinkDir = join(base, `${SCRATCH_DIR_PREFIX}${deadPid}-link`);

		mkdirSync(deadDir);
		writeFileSync(join(deadDir, "leftover.txt"), "stale");
		mkdirSync(aliveDir);
		mkdirSync(otherDir);
		mkdirSync(targetDir);
		symlinkSync(targetDir, symlinkDir);

		const warnings: string[] = [];
		const removed = cleanupStaleScratchDirs(base, { warn: (msg) => warnings.push(msg) });

		expect(removed).toEqual([deadDir]);
		expect(warnings).toEqual([]);
		expect(existsSync(deadDir)).toBe(false);
		expect(existsSync(aliveDir)).toBe(true);
		expect(existsSync(otherDir)).toBe(true);
		expect(existsSync(symlinkDir)).toBe(true);
		expect(existsSync(targetDir)).toBe(true);
	});

	test("cleanupStaleScratchDirs skips directories owned by a different uid", async () => {
		const base = mkdtempSync(join(tmpdir(), "scratch-uid-"));
		const deadPid = await spawnDeadPid();
		const dir = join(base, `${SCRATCH_DIR_PREFIX}${deadPid}-other-uid`);
		mkdirSync(dir);

		const differentUid = (process.getuid?.() ?? 1000) + 1;
		const removed = cleanupStaleScratchDirs(base, {
			uid: differentUid,
			isAlive: () => false,
			warn: () => {},
		});

		expect(removed).toEqual([]);
		expect(existsSync(dir)).toBe(true);
	});

	test("cleanupStaleScratchDirs chmods restrictive trees before deleting and warns without throwing on error", async () => {
		const base = mkdtempSync(join(tmpdir(), "scratch-chmod-"));
		const deadPid = await spawnDeadPid();
		const lockedDir = join(base, `${SCRATCH_DIR_PREFIX}${deadPid}-locked`);
		const nestedDir = join(lockedDir, "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "secret.txt"), "data");
		chmodSync(nestedDir, 0o500);
		chmodSync(lockedDir, 0o500);

		const warnings: string[] = [];
		const removed = cleanupStaleScratchDirs(base, { warn: (msg) => warnings.push(msg) });
		expect(removed).toEqual([lockedDir]);
		expect(warnings).toEqual([]);
		expect(existsSync(lockedDir)).toBe(false);

		const missingWarnings: string[] = [];
		expect(cleanupStaleScratchDirs(join(base, "does-not-exist"), { warn: (msg) => missingWarnings.push(msg) })).toEqual(
			[],
		);
		expect(missingWarnings.length).toBe(1);

		if (process.getuid?.() !== 0) {
			const roParent = join(base, "ro-parent");
			const blockedChild = join(roParent, `${SCRATCH_DIR_PREFIX}${deadPid}-blocked`);
			mkdirSync(blockedChild, { recursive: true });
			chmodSync(roParent, 0o500);
			try {
				const rmWarnings: string[] = [];
				expect(removeScratchDir(blockedChild, (msg) => rmWarnings.push(msg))).toBe(false);
				expect(rmWarnings.length).toBe(1);
			} finally {
				chmodSync(roParent, 0o700);
			}
		}
	});

	test("end-to-end bun test child cleans dead PID dir, preserves live PID dir, and removes its own scratch dir", async () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "scratch-e2e-"));
		const e2eBase = join(fixtureRoot, "tmp-base");
		const suiteDir = join(fixtureRoot, "suite");
		mkdirSync(e2eBase);
		mkdirSync(suiteDir);

		const deadPid = await spawnDeadPid();
		const staleDir = join(e2eBase, `${SCRATCH_DIR_PREFIX}${deadPid}-stale`);
		const liveDir = join(e2eBase, `${SCRATCH_DIR_PREFIX}${process.pid}-live`);
		const unrelatedDir = join(e2eBase, "ompbot-unrelated-999");
		mkdirSync(staleDir);
		mkdirSync(liveDir);
		mkdirSync(unrelatedDir);

		const innerTestFile = join(suiteDir, "inner.test.ts");
		writeFileSync(
			innerTestFile,
			[
				'import { expect, test } from "bun:test";',
				'import { tmpdir } from "node:os";',
				'import { basename, dirname } from "node:path";',
				'test("isolated scratch", () => {',
				"\tconst t = tmpdir();",
				`\texpect(dirname(t)).toBe(${JSON.stringify(e2eBase)});`,
				`\texpect(basename(t).startsWith("ompbot-test-" + process.pid + "-")).toBe(true);`,
				"});",
				"",
			].join("\n"),
		);

		const res = Bun.spawnSync([process.execPath, "test", innerTestFile], {
			cwd: REPO_ROOT,
			env: { ...process.env, TMPDIR: e2eBase },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(res.exitCode).toBe(0);
		expect(existsSync(staleDir)).toBe(false);
		expect(existsSync(liveDir)).toBe(true);
		expect(existsSync(unrelatedDir)).toBe(true);
		expect(readdirSync(e2eBase).sort()).toEqual([basename(liveDir), basename(unrelatedDir)].sort());
	});
});
