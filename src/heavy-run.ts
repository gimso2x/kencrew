import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Host-wide serialisation of the full test run (`scripts/heavy-run`). The lock is `flock(1)` on one fixed file; the
 * state files next to it only describe who runs and who waits, for the dashboard chip and the waiting notice.
 * `OMPBOT_HEAVY_RUN_DIR` moves the directory for tests only (the prefix keeps `dispatchEnv` from passing it on).
 */

export const HEAVY_RUN_HELD_ENV = "HEAVY_RUN_HELD";
/** The runner's state file, handed to the locked entry point. */
export const HEAVY_RUN_STATE_ENV = "HEAVY_RUN_STATE";
/** Exit code of a run that waited longer than `--max-wait` (EX_TEMPFAIL). */
export const HEAVY_RUN_BUSY_CODE = 75;

export interface HeavyRunState {
	pid: number;
	cwd: string;
	argv: string[];
	label: string;
	state: "waiting" | "running";
	/** The locked entry point's pid, once `running`: the process that holds the lock (it outlives a killed runner). */
	lockedPid?: number;
	/** Epoch ms: when the wait began (waiting) or the run began (running). */
	since: number;
}

export interface HeavyRunPaths {
	dir: string;
	lock: string;
	states: string;
}

export function heavyRunPaths(
	uid: number = process.getuid?.() ?? 0,
	env: NodeJS.ProcessEnv = process.env,
): HeavyRunPaths {
	const dir = env.OMPBOT_HEAVY_RUN_DIR ?? `/tmp/ompbot-heavy-${uid}`;
	return { dir, lock: join(dir, "lock"), states: join(dir, "state") };
}

/** The worktree name of `cwd` (`/…/work/<name>/…`); the last path segment outside a `work` directory. */
export function heavyRunLabel(cwd: string): string {
	return /\/work\/([^/]+)/.exec(cwd)?.[1] ?? (basename(cwd) || cwd);
}

/** Process state letter from `/proc/<pid>/stat`; `undefined` when the process does not exist. */
function procState(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
	} catch {
		return undefined;
	}
}

export function stateFile(paths: HeavyRunPaths, pid: number): string {
	return join(paths.states, `${pid}.json`);
}

export function writeHeavyRunState(paths: HeavyRunPaths, state: HeavyRunState): void {
	mkdirSync(paths.states, { recursive: true });
	const target = stateFile(paths, state.pid);
	const temp = `${target}.tmp`;
	writeFileSync(temp, JSON.stringify(state));
	renameSync(temp, target);
}

/** The locked entry point: the runner's state file becomes `running`, with the pid that holds the lock. */
export function markHeavyRunRunning(file: string, lockedPid: number, now: number): void {
	const state = asState(JSON.parse(readFileSync(file, "utf8")));
	if (state === undefined) return;
	const temp = `${file}.tmp`;
	writeFileSync(temp, JSON.stringify({ ...state, state: "running", lockedPid, since: now }));
	renameSync(temp, file);
}

export function removeHeavyRunState(paths: HeavyRunPaths, pid: number): void {
	rmSync(stateFile(paths, pid), { force: true });
}

/** Live states, oldest first. A file whose pid is gone or a zombie is ignored and deleted. */
export function readHeavyRunStates(paths: HeavyRunPaths): HeavyRunState[] {
	let names: string[];
	try {
		names = readdirSync(paths.states);
	} catch {
		return [];
	}
	const live: HeavyRunState[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = join(paths.states, name);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		const state = asState(parsed);
		if (state === undefined) continue;
		const proc = procState(state.state === "running" ? (state.lockedPid ?? state.pid) : state.pid);
		if (proc === undefined || proc === "Z") {
			rmSync(file, { force: true });
			continue;
		}
		live.push(state);
	}
	return live.sort((a, b) => a.since - b.since);
}

function asState(value: unknown): HeavyRunState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	if (
		typeof r.pid !== "number" ||
		typeof r.cwd !== "string" ||
		!Array.isArray(r.argv) ||
		typeof r.label !== "string" ||
		(r.state !== "waiting" && r.state !== "running") ||
		typeof r.since !== "number"
	)
		return undefined;
	return {
		pid: r.pid,
		cwd: r.cwd,
		argv: r.argv.map(String),
		label: r.label,
		state: r.state,
		since: r.since,
		...(typeof r.lockedPid === "number" ? { lockedPid: r.lockedPid } : {}),
	};
}
