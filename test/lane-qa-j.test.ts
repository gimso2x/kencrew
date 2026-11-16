import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyClaim } from "../src/lanes/verify";
import { resolveLaneRepo } from "../src/lanes/worktree";
import { evaluateTask, runWorktreeChecks } from "../src/tasks/evaluate";
import { createTaskHostOps } from "../src/tasks/host";
import type { TaskRow } from "../src/tasks/ledger";
import { assertCheckPlacement, runSignal, type SignalCheck, SignalSyntaxError } from "../src/tasks/signals";
import { git, makeRepo } from "./helpers/git-fixtures";

const repos: string[] = [];
afterEach(() => {
	for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lane start in a nested repository (qa-j 51)", () => {
	function nestedRepo(): { outer: string; inner: string } {
		const outer = makeRepo(repos);
		const inner = join(outer, "inner");
		mkdirSync(inner);
		git(inner, "init", "-q");
		writeFileSync(join(inner, "a.txt"), "a\n");
		git(inner, "add", "a.txt");
		git(inner, "commit", "-q", "-m", "init");
		return { outer, inner };
	}

	test("refused while the sibling worktree path would show up in the outer repository", async () => {
		const { inner } = nestedRepo();
		const found = await resolveLaneRepo(inner);
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.problem).toContain("바깥");
	});

	test("allowed when the outer repository ignores that path", async () => {
		const { outer, inner } = nestedRepo();
		writeFileSync(join(outer, ".gitignore"), "inner-l-*\n");
		const found = await resolveLaneRepo(inner);
		expect(found.ok).toBe(true);
	});
});

describe("clean-tree check sees changes hidden from status (qa-j 113)", () => {
	test("an --assume-unchanged edit refuses the claim; an untouched skip-worktree path does not", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, "b.txt"), "b\n");
		git(repo, "add", "b.txt");
		git(repo, "commit", "-q", "-m", "b");
		git(repo, "update-index", "--skip-worktree", "b.txt");
		const clean = await verifyClaim({ repo, commit: "HEAD", summary: "x" }, repo);
		expect(clean.ok).toBe(true);
		git(repo, "update-index", "--assume-unchanged", "README.md");
		writeFileSync(join(repo, "README.md"), "hidden edit\n");
		expect(git(repo, "status", "--porcelain")).toBe("");
		const refused = await verifyClaim({ repo, commit: "HEAD", summary: "x" }, repo);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reasons.join("\n")).toContain("README.md");
	});
});

describe("[check:] runs (qa-j 53, 54)", () => {
	test("a check that dirties the worktree defers the judgement and is not remembered (53)", async () => {
		const repo = makeRepo(repos);
		const known = new Map<string, SignalCheck>();
		const run = await runWorktreeChecks(createTaskHostOps(), repo, () => known, [
			{ id: "AC-1", signal: 'command ["sh","-c","echo x > made-by-check.txt"]' },
		]);
		expect("deferred" in run).toBe(true);
		if ("deferred" in run) expect(run.deferred).toContain("worktree");
		expect(known.size).toBe(0);
	});

	test("a tail-anchored stdout regex sees the end of an output larger than 64KB (54)", async () => {
		const repo = makeRepo(repos);
		const ops = createTaskHostOps();
		const result = await runSignal('command ["sh","-c","yes line | head -c 200000; echo END"] stdout~"END\\\\s*$"', {
			runCheck: (argv) => ops.runCheck({ worktree: repo, argv, timeoutMs: 20_000 }),
			readBytes: async () => undefined,
		});
		expect(result).toMatchObject({ ok: true });
	});
});

// A read that blocked on a FIFO would never settle: the test's own timeout catches it, with room for a loaded machine
// (a fixed 3s race here failed under a parallel full run).
const HANG_LIMIT_MS = 30_000;

describe("task document and check-file reads never block or leave the worktree (qa-j 57, 121, 115)", () => {
	const fifoIn = (dir: string, name: string): string => {
		const path = join(dir, name);
		expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
		return path;
	};

	test(
		"a FIFO in place of a document: readFile and readBytes refuse at once (57)",
		async () => {
			const repo = makeRepo(repos);
			const fifo = fifoIn(repo, "spec.md");
			const ops = createTaskHostOps();
			expect(await ops.readFile(fifo)).toMatchObject({ ok: false });
			expect(await ops.readBytes(fifo)).toMatchObject({ ok: false });
		},
		HANG_LIMIT_MS,
	);

	test(
		"evaluateTask with a FIFO as spec.md fails the evaluation instead of hanging (121)",
		async () => {
			const repo = makeRepo(repos);
			mkdirSync(join(repo, "docs", "tasks", "T-20261114-01"), { recursive: true });
			fifoIn(join(repo, "docs", "tasks", "T-20261114-01"), "spec.md");
			writeFileSync(join(repo, "docs", "tasks", "T-20261114-01", "PROGRESS.md"), "x\n");
			writeFileSync(join(repo, "docs", "tasks", "T-20261114-01", "outcome.md"), "x\n");
			const row = {
				taskId: "T-20261114-01",
				worktree: repo,
				branch: "task/T-20261114-01",
				acceptance: [],
			} as unknown as TaskRow;
			expect(await evaluateTask(row, createTaskHostOps())).toMatchObject({ ok: false });
		},
		HANG_LIMIT_MS,
	);

	test(
		"[check: file] refuses a symlink, a path through a symlinked directory, and a FIFO (115)",
		async () => {
			const repo = makeRepo(repos);
			const outside = makeRepo(repos);
			symlinkSync(join(outside, "README.md"), join(repo, "link.txt"));
			symlinkSync(outside, join(repo, "linkdir"));
			git(repo, "add", "link.txt", "linkdir");
			git(repo, "commit", "-q", "-m", "links");
			const fifo = fifoIn(repo, "pipe.txt");
			const ops = createTaskHostOps();
			const read = (path: string) =>
				runWorktreeChecks(ops, repo, () => new Map(), [{ id: "AC-1", signal: `file ${path}` }]).then((run) =>
					"results" in run ? run.results[0] : undefined,
				);
			for (const path of ["link.txt", "linkdir/README.md", "pipe.txt"]) {
				const outcome = await read(path).catch((error: unknown) => String(error));
				expect(typeof outcome === "object" && outcome?.ok).not.toBe(true);
			}
			expect(fifo).toContain("pipe.txt");
		},
		HANG_LIMIT_MS,
	);
});

describe("a second [check:] block behind an unpaired double quote (qa-j 120)", () => {
	test("is refused at registration", () => {
		const text = 'x "unclosed [check: command ["ls","a"]] [check: command ["ls","b"]]';
		expect(() => assertCheckPlacement(text)).toThrow(SignalSyntaxError);
	});
});
