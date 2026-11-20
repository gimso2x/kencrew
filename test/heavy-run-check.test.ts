import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "../src/dispatch/omp";
import { isFullTestArgv } from "../src/tasks/full-test";
import { createTaskHostOps } from "../src/tasks/host";

const FULL = [
	["bun", "test"],
	["bun", "test", "test/"],
	["bun", "run", "test"],
	["bun", "test", "--parallel=3"],
];
const NOT_FULL = [
	["bun", "test", "test/x.test.ts"],
	["bun", "test", "x.test"],
	["bun", "run", "check"],
	["bun", "x", "tsc"],
	["sh", "-c", "bun test"],
];

describe("isFullTestArgv", () => {
	test("whole-suite spellings", () => {
		for (const argv of FULL) expect(isFullTestArgv(argv)).toBe(true);
		expect(isFullTestArgv(["bun", "test", "--timeout", "5000"])).toBe(true);
		expect(isFullTestArgv(["bun", "test", "-t", "name", "test/"])).toBe(true);
	});
	test("file arguments and other commands are not", () => {
		for (const argv of NOT_FULL) expect(isFullTestArgv(argv)).toBe(false);
		expect(isFullTestArgv(["bun", "test", "--timeout", "5000", "test/x.test.ts"])).toBe(false);
	});
});

describe("runCheck queues whole-suite runs on heavy-run", () => {
	let dir: string;
	let calls: string[][];
	const run: ProcessRunner = async (cmd) => {
		calls.push(cmd);
		return { code: 0, stdout: "", timedOut: false };
	};

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-hr-check-")));
		calls = [];
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function withRunner(): void {
		mkdirSync(join(dir, "scripts"));
		writeFileSync(join(dir, "scripts", "heavy-run"), "#!/bin/sh\n");
		chmodSync(join(dir, "scripts", "heavy-run"), 0o755);
	}

	test("the runner goes in front of bun test, bun test test/ and bun run test, with the timeout plus 60 s", async () => {
		withRunner();
		const ops = createTaskHostOps({ run });
		for (const argv of [
			["bun", "test"],
			["bun", "test", "test/"],
			["bun", "run", "test"],
		])
			await ops.runCheck({ worktree: dir, argv, timeoutMs: 900_000 });
		expect(calls).toEqual([
			["scripts/heavy-run", "--max-wait", "960", "--", "bun", "test"],
			["scripts/heavy-run", "--max-wait", "960", "--", "bun", "test", "test/"],
			["scripts/heavy-run", "--max-wait", "960", "--", "bun", "run", "test"],
		]);
	});

	test("a file test and bun run check run as they are", async () => {
		withRunner();
		const ops = createTaskHostOps({ run });
		for (const argv of [
			["bun", "test", "test/x.test.ts"],
			["bun", "run", "check"],
		])
			await ops.runCheck({ worktree: dir, argv, timeoutMs: 900_000 });
		expect(calls).toEqual([
			["bun", "test", "test/x.test.ts"],
			["bun", "run", "check"],
		]);
	});

	test("a worktree without the runner (another repository, an old commit) runs the argv as it is", async () => {
		const ops = createTaskHostOps({ run });
		await ops.runCheck({ worktree: dir, argv: ["bun", "test"], timeoutMs: 900_000 });
		expect(calls).toEqual([["bun", "test"]]);
	});

	test("over ssh the line picks the runner on the remote worktree, else the bare argv; a file test stays bare", async () => {
		const ops = createTaskHostOps({ sshTarget: "wsl", run });
		await ops.runCheck({ worktree: "/r/wt", argv: ["bun", "test"], timeoutMs: 120_000 });
		await ops.runCheck({ worktree: "/r/wt", argv: ["bun", "test", "a.test.ts"], timeoutMs: 120_000 });
		const line = (cmd: string[]): string => cmd.slice(cmd.indexOf("wsl") + 1).join(" ");
		expect(line(calls[0] as string[])).toContain(
			"if [ -x scripts/heavy-run ]; then 'scripts/heavy-run' '--max-wait' '180' '--' 'bun' 'test' ; else 'bun' 'test' ; fi",
		);
		expect(line(calls[1] as string[])).not.toContain("heavy-run");
	});
});
