import { afterAll } from "bun:test";
import { chmodSync, type Dirent, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRATCH_DIR_PREFIX = "ompbot-test-";
const SCRATCH_DIR_PATTERN = /^ompbot-test-(\d+)-/;

export type CleanupOptions = {
	uid?: number;
	isAlive?: (pid: number) => boolean;
	warn?: (message: string) => void;
};

/** Returns true if a process with the given PID is alive (or exists under another owner). */
export function isPidAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ESRCH") return false;
		// EPERM means the process still exists; treat unknown errors conservatively as alive.
		return true;
	}
}

function chmodTreeWritable(dirPath: string): void {
	try {
		chmodSync(dirPath, 0o700);
	} catch {
		// best effort
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const childPath = join(dirPath, entry.name);
		if (entry.isDirectory()) {
			chmodTreeWritable(childPath);
		} else {
			try {
				chmodSync(childPath, 0o600);
			} catch {
				// best effort
			}
		}
	}
}

/** Removes a scratch directory, relaxing restrictive permissions once before retrying. */
export function removeScratchDir(dirPath: string, warn: (message: string) => void = console.warn): boolean {
	try {
		rmSync(dirPath, { recursive: true, force: true });
		return true;
	} catch {
		chmodTreeWritable(dirPath);
		try {
			rmSync(dirPath, { recursive: true, force: true });
			return true;
		} catch (retryError) {
			const message = retryError instanceof Error ? retryError.message : String(retryError);
			warn(`[test-preload] failed to remove ${dirPath}: ${message}`);
			return false;
		}
	}
}

/** Removes dead-PID `ompbot-test-<pid>-*` directories owned by the current user directly under `baseDir`. */
export function cleanupStaleScratchDirs(baseDir: string, options: CleanupOptions = {}): string[] {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const myUid = options.uid ?? process.getuid?.();
	const checkAlive = options.isAlive ?? isPidAlive;
	const removed: string[] = [];

	let entries: Dirent[];
	try {
		entries = readdirSync(baseDir, { withFileTypes: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warn(`[test-preload] failed to read ${baseDir}: ${message}`);
		return removed;
	}

	for (const entry of entries) {
		const match = SCRATCH_DIR_PATTERN.exec(entry.name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0) continue;

		const fullPath = join(baseDir, entry.name);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(fullPath);
		} catch {
			// Skip vanished entries (e.g. concurrent worker cleanup).
			continue;
		}
		if (!stat.isDirectory()) continue;
		if (myUid !== undefined && stat.uid !== myUid) continue;
		if (checkAlive(pid)) continue;

		if (removeScratchDir(fullPath, warn)) {
			removed.push(fullPath);
		}
	}

	return removed;
}

// `bun test`(단일 프로세스)에서는 preload가 1회 실행되고 전역 afterAll이 모든 테스트 파일 종료 뒤 1회 실행된다.
// `bun test --parallel=3` 실측(Bun 1.4.5): Bun이 독립된 PID를 가진 워커 프로세스 3개를 띄우고,
// 각 워커는 담당 테스트 파일마다 preload를 실행한 뒤 해당 파일이 끝날 때 afterAll을 실행한다.
// afterAll에서 TMPDIR을 원래 값으로 먼저 되돌리고 scratch 디렉터리를 삭제하므로,
// 같은 워커의 다음 테스트 파일 preload도 원래 tmpdir()을 읽어 각자의 PID 기반 디렉터리를 만든다.
const originalTmpdir = tmpdir();
const hadOriginalEnvTmpdir = Object.hasOwn(process.env, "TMPDIR");
const originalEnvTmpdir = process.env.TMPDIR;

cleanupStaleScratchDirs(originalTmpdir);

const scratchDir = mkdtempSync(join(originalTmpdir, `${SCRATCH_DIR_PREFIX}${process.pid}-`));
process.env.TMPDIR = scratchDir;

afterAll(() => {
	if (hadOriginalEnvTmpdir && originalEnvTmpdir !== undefined) {
		process.env.TMPDIR = originalEnvTmpdir;
	} else {
		delete process.env.TMPDIR;
	}
	removeScratchDir(scratchDir);
});
