// qa-j medium #6 (with #1): a workspace that resolves around the home or onto secrets/ is refused, and a procedure file
// under secrets/ is refused at resolve time. qa-j medium #70 (with #22, #23): a turn snapshot's git call keeps its
// deadline when a clean filter's child holds the pipes, and never follows an inherited GIT_DIR.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceOverlapsHome } from "../src/config";
import { resolveProcedureFile } from "../src/monitors/spec";
import { runGit } from "../src/ops/turn-snapshot";
import { git, makeRepo } from "./helpers/git-fixtures";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function layout(): { root: string; home: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-qaj-ws-")));
	dirs.push(root);
	const home = join(root, "home");
	mkdirSync(join(home, "secrets"), { recursive: true });
	mkdirSync(join(home, "scripts"));
	writeFileSync(join(home, "secrets", "discord-bot-token"), "TEST-discord-0\n");
	return { root, home };
}

describe("qa-j #6/#1 workspace overlap", () => {
	test("a workspace symlinked onto secrets/ overlaps the home", () => {
		const { root, home } = layout();
		const link = join(root, "ws-link");
		symlinkSync(join(home, "secrets"), link);
		expect(workspaceOverlapsHome(home, link)).toBe(true);
	});

	test("a workspace that is an ancestor of the home overlaps it", () => {
		const { root, home } = layout();
		expect(workspaceOverlapsHome(home, root)).toBe(true);
	});

	test("a home reached through a symlink still matches its real workspace", () => {
		const { root, home } = layout();
		const homeLink = join(root, "home-link");
		symlinkSync(home, homeLink);
		expect(workspaceOverlapsHome(homeLink, join(home, "secrets", "x"))).toBe(true);
	});

	test("a separate or not-yet-created workspace is fine", () => {
		const { root, home } = layout();
		expect(workspaceOverlapsHome(home, join(home, "workspace"))).toBe(false);
		expect(workspaceOverlapsHome(home, join(root, "elsewhere", "ws"))).toBe(false);
	});

	test("a procedure file under secrets/ is refused even when the workspace contains it", () => {
		const { root, home } = layout();
		expect(() => resolveProcedureFile("home/secrets/discord-bot-token", root, join(home, "scripts"))).toThrow(
			/secrets/,
		);
		writeFileSync(join(root, "notes.md"), "ok\n");
		expect(resolveProcedureFile("notes.md", root, join(home, "scripts"))).toBe(join(root, "notes.md"));
	});
});

describe("qa-j #70/#22/#23 turn snapshot git", () => {
	test("a clean filter whose child holds the pipes cannot push the call past its deadline", async () => {
		const repos: string[] = [];
		const repo = makeRepo(repos);
		dirs.push(...repos);
		git(repo, "config", "filter.slow.clean", "sleep 20");
		writeFileSync(join(repo, ".gitattributes"), "*.txt filter=slow\n");
		writeFileSync(join(repo, "a.txt"), "x\n");
		const started = performance.now();
		// The deadline itself is the behavior under test: the filter sleeps 20s, the call must come back near 300ms.
		const outcome = await runGit(repo, ["add", "-A", "--", "."], { timeoutMs: 300 });
		expect(outcome.code).not.toBe(0);
		// Far under the filter's 20s, with room for a loaded machine running the full suite in parallel.
		expect(performance.now() - started).toBeLessThan(10_000);
	}, 30_000);

	test("an inherited GIT_DIR does not redirect the call to another repository", async () => {
		const repos: string[] = [];
		const mine = makeRepo(repos);
		const other = makeRepo(repos);
		dirs.push(...repos);
		writeFileSync(join(other, "b.md"), "b\n");
		git(other, "add", "b.md");
		git(other, "commit", "-q", "-m", "other");
		const saved = process.env.GIT_DIR;
		process.env.GIT_DIR = join(other, ".git");
		try {
			const outcome = await runGit(mine, ["rev-parse", "HEAD"]);
			expect(outcome.stdout.trim()).toBe(git(mine, "--git-dir", join(mine, ".git"), "rev-parse", "HEAD"));
		} finally {
			if (saved === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = saved;
		}
	});
});
