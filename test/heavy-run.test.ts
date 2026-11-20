import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileSink } from "bun";
import {
	HEAVY_RUN_HELD_ENV,
	type HeavyRunPaths,
	type HeavyRunState,
	heavyRunLabel,
	heavyRunPaths,
	readHeavyRunStates,
	writeHeavyRunState,
} from "../src/heavy-run";

const RUNNER = join(import.meta.dir, "..", "scripts", "heavy-run");
const DEADLINE_MS = 20_000;

let home: string;
let paths: HeavyRunPaths;
const running: Array<Bun.Subprocess> = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "heavy-run-test-"));
	paths = heavyRunPaths(0, { OMPBOT_HEAVY_RUN_DIR: home });
});

afterEach(() => {
	for (const proc of running.splice(0)) proc.kill("SIGKILL");
	rmSync(home, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
	const base = { ...process.env, OMPBOT_HEAVY_RUN_DIR: home } as Record<string, string>;
	delete base[HEAVY_RUN_HELD_ENV];
	return { ...base, ...extra };
}

function runner(args: string[], extra: Record<string, string> = {}) {
	const proc = Bun.spawn([RUNNER, ...args], { env: env(extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	running.push(proc);
	return proc;
}

/** Resolves when `ready()` holds, re-checked on every change in the state directory; fails after the deadline. */
async function untilState(ready: () => boolean): Promise<void> {
	mkdirSync(paths.states, { recursive: true });
	if (ready()) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const watcher = watch(paths.states, () => {
		if (ready()) resolve();
	});
	const timer = setTimeout(() => resolve(), DEADLINE_MS);
	await promise;
	clearTimeout(timer);
	watcher.close();
	if (!ready()) throw new Error("timed out waiting for the state directory");
}

/** Fields of `/proc/<pid>/stat` after the command name: state, ppid, pgrp. */
const procStat = (pid: number): string[] => {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
};

const stateOf = (pid: number): HeavyRunState | undefined => readHeavyRunStates(paths).find((s) => s.pid === pid);

/** Reads `stream` until `needle` shows up. */
async function readUntil(stream: ReadableStream<Uint8Array>, needle: string): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes(needle)) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value);
		}
	} finally {
		reader.releaseLock();
	}
	return text;
}

// A command that reports it started, then holds the lock until a line arrives on stdin.
const HOLD = ["sh", "-c", "echo started; read line; echo released"];

describe("heavy-run: serialising", () => {
	test("the second run waits (waiting → running) until the first ends", async () => {
		const first = runner(["--", ...HOLD]);
		expect(await readUntil(first.stdout as ReadableStream<Uint8Array>, "started")).toContain("started");
		expect(stateOf(first.pid)?.state).toBe("running");

		const second = runner(["--", "echo", "second-ran"]);
		await untilState(() => stateOf(second.pid)?.state === "waiting");
		expect(stateOf(first.pid)?.state).toBe("running");

		(first.stdin as FileSink).write("go\n");
		(first.stdin as FileSink).end();
		expect(await first.exited).toBe(0);
		expect(await second.exited).toBe(0);
		expect(await new Response(second.stdout as ReadableStream).text()).toContain("second-ran");
		expect(readHeavyRunStates(paths)).toEqual([]);
	});

	test("the waiting run starts after the running one's process group is kill -9'd", async () => {
		const first = runner(["--", "sh", "-c", "echo started; exec sleep 60"]);
		await readUntil(first.stdout as ReadableStream<Uint8Array>, "started");
		const locked = stateOf(first.pid)?.lockedPid;
		expect(locked).toBeGreaterThan(0);
		const pgid = Number(procStat(locked as number)[2]);
		expect(pgid).not.toBe(process.pid);
		const second = runner(["--", "echo", "after-kill"]);
		await untilState(() => stateOf(second.pid)?.state === "waiting");

		process.kill(-pgid, "SIGKILL");
		expect(await second.exited).toBe(0);
		expect(await new Response(second.stdout as ReadableStream).text()).toContain("after-kill");
	});
});

describe("heavy-run: exit codes and re-entry", () => {
	test("the command's exit code is passed on", async () => {
		const proc = runner(["--", "sh", "-c", "exit 7"]);
		expect(await proc.exited).toBe(7);
	});

	test("a run that waits past --max-wait exits 75 with heavy-run: busy", async () => {
		const first = runner(["--", ...HOLD]);
		await readUntil(first.stdout as ReadableStream<Uint8Array>, "started");
		const second = runner(["--max-wait", "1", "--", "echo", "never"]);
		expect(await second.exited).toBe(75);
		const err = await new Response(second.stderr as ReadableStream).text();
		expect(err).toContain("heavy-run: busy");
		expect(await new Response(second.stdout as ReadableStream).text()).not.toContain("never");
		expect(readHeavyRunStates(paths).map((s) => s.pid)).toEqual([first.pid]);
	});

	test("HEAVY_RUN_HELD with the same lock path runs at once while the lock is taken", async () => {
		const first = runner(["--", ...HOLD]);
		await readUntil(first.stdout as ReadableStream<Uint8Array>, "started");
		const nested = runner(["--max-wait", "1", "--", "echo", "nested-ran"], { [HEAVY_RUN_HELD_ENV]: paths.lock });
		expect(await nested.exited).toBe(0);
		expect(await new Response(nested.stdout as ReadableStream).text()).toContain("nested-ran");
	});

	test("heavy-run → heavy-run (the nested call inherits the held lock) does not deadlock", async () => {
		const proc = runner(["--max-wait", "5", "--", RUNNER, "--max-wait", "1", "--", "echo", "inner-ran"]);
		expect(await proc.exited).toBe(0);
		expect(await new Response(proc.stdout as ReadableStream).text()).toContain("inner-ran");
	});
});

describe("heavy-run: stale state files", () => {
	const fake = (pid: number): HeavyRunState => ({
		pid,
		cwd: "/x",
		argv: ["bun", "test"],
		label: "ompbot-t-x",
		state: "waiting",
		since: 1,
	});

	test("a state file of a pid that does not exist is ignored and deleted", () => {
		const dead = 2 ** 22 + 12345;
		writeHeavyRunState(paths, fake(dead));
		expect(readHeavyRunStates(paths)).toEqual([]);
		expect(() => readFileSync(join(paths.states, `${dead}.json`))).toThrow();
	});

	test("a state file of a zombie pid is ignored and deleted", async () => {
		// The parent forks a child that exits at once and never waits for it: a zombie.
		const parent = Bun.spawn(
			["python3", "-c", "import os,time\np=os.fork()\nif p==0: os._exit(0)\nprint(p,flush=True)\ntime.sleep(60)"],
			{ stdout: "pipe" },
		);
		running.push(parent);
		const zombie = Number((await readUntil(parent.stdout as ReadableStream<Uint8Array>, "\n")).trim());
		const isZombie = (): boolean => {
			const stat = readFileSync(`/proc/${zombie}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
		};
		const deadline = Date.now() + DEADLINE_MS;
		while (!isZombie()) {
			if (Date.now() > deadline) throw new Error("child never became a zombie");
			await new Promise((resolve) => setImmediate(resolve));
		}
		writeHeavyRunState(paths, fake(zombie));
		writeHeavyRunState(paths, fake(parent.pid));
		expect(readHeavyRunStates(paths).map((s) => s.pid)).toEqual([parent.pid]);
		expect(() => readFileSync(join(paths.states, `${zombie}.json`))).toThrow();
	});

	test("a running state is judged by lockedPid, a waiting one by pid", () => {
		const dead = 2 ** 22 + 12345;
		// Outer runner gone, locked entry alive (this process): still running. Outer alive, locked entry gone: stale.
		writeHeavyRunState(paths, { ...fake(dead), state: "running", lockedPid: process.pid });
		writeHeavyRunState(paths, { ...fake(process.pid), state: "running", lockedPid: dead });
		expect(readHeavyRunStates(paths).map((s) => s.pid)).toEqual([dead]);
	});

	test("a half-written or foreign file in the state directory is skipped, not fatal", () => {
		mkdirSync(paths.states, { recursive: true });
		writeFileSync(join(paths.states, "1.json"), "{not json");
		writeFileSync(join(paths.states, "note.txt"), "x");
		expect(readHeavyRunStates(paths)).toEqual([]);
	});
});

describe("heavy-run: label", () => {
	test("the worktree name under /work/, else the last segment", () => {
		expect(heavyRunLabel("/srv/work/ompbot-t-20261119-07/src")).toBe("ompbot-t-20261119-07");
		expect(heavyRunLabel("/srv/checkout")).toBe("checkout");
	});
});
