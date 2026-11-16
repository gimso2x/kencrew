import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLaneCompletion, collectLaneDiff } from "../src/lanes/integrity";

const DIFF = (file: string, ...lines: string[]): string =>
	[`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -0,0 +1,1 @@", ...lines].join("\n");

const categories = (diff: string): string[] =>
	classifyLaneCompletion({ summary: "done", diff }).map((refusal) => refusal.category);

// Words assembled from pieces so this file's own added lines do not trip the checks it tests.
const skip = ["sk", "ip"].join("");
const notImpl = ["not", "implemented"].join(" ");

describe("lane integrity (qa-j)", () => {
	test("a linked reason exempts markers and skipped tests but never a stub body (55, 114)", () => {
		expect(categories(DIFF("src/a.ts", `+throw new Error("${notImpl}"); // #1`))).toEqual(["stub_implementation"]);
		expect(categories(DIFF("src/a.ts", `+throw new Error("${notImpl}"); // https://x.invalid/1`))).toEqual([
			"stub_implementation",
		]);
		expect(categories(DIFF("src/a.rs", "+    todo!(); // #12"))).toEqual(["stub_implementation"]);
		expect(categories(DIFF("src/a.ts", "+// TODO: later, see #123"))).toEqual([]);
		expect(categories(DIFF("test/a.test.ts", `+test.${skip}("x", () => {}); // #7`))).toEqual([]);
	});

	test("todo with brackets, braces or a space before the bang is a stub (56)", () => {
		for (const call of ["todo!{}", "todo![]", "todo !()", "todo!()"]) {
			expect(categories(DIFF("src/a.rs", `+    ${call}`))).toEqual(["stub_implementation"]);
		}
		expect(categories(DIFF("src/a.rs", "+    let todo = 1;"))).toEqual([]);
	});

	test("skipped tests of python, go and rust are refused (116)", () => {
		const cases: [string, string][] = [
			["test/test_a.py", `+@pytest.mark.${skip}(reason="x")`],
			["test/test_a.py", `+    pytest.${skip}("x")`],
			["a_test.go", `+\tt.${skip[0]?.toUpperCase()}${skip.slice(1)}("x")`],
			["tests/a.rs", "+#[ignore]"],
		];
		for (const [file, line] of cases) expect(categories(DIFF(file, line))).toEqual(["skipped_test"]);
		expect(categories(DIFF("tests/a.rs", "+#[ignore] // #4"))).toEqual([]);
	});

	test("an unrelated negative word in a test file does not excuse a guard deletion (118)", () => {
		const removed = "-if (!allowlist.has(host)) throw new Error('denied');";
		const guardOnly = [
			`diff --git a/src/auth.ts b/src/auth.ts`,
			"--- a/src/auth.ts",
			"+++ b/src/auth.ts",
			"@@ -1 +0,0 @@",
			removed,
		];
		const withTest = (line: string): string =>
			[
				...guardOnly,
				"diff --git a/test/a.test.ts b/test/a.test.ts",
				"--- a/test/a.test.ts",
				"+++ b/test/a.test.ts",
				"@@ -0,0 +1 @@",
				line,
			].join("\n");
		expect(categories(withTest("+const invalid = 1;"))).toEqual(["guard_deletion_without_adversarial_regression"]);
		expect(categories(withTest("+// refuses nothing"))).toEqual(["guard_deletion_without_adversarial_regression"]);
		expect(categories(withTest('+test("rejects a denied host", () => {});'))).toEqual([]);
		expect(categories(withTest("+expect(() => run()).toThrow();\n+test('refuses x', () => {});"))).toEqual([]);
	});
});

describe("collectLaneDiff binary files (qa-j 52)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	});
	const git = (cwd: string, ...args: string[]): string =>
		execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
			cwd,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
		}).trim();

	test("a NUL byte or `-diff` attribute does not hide a stub from the judge", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ompbot-integrity-qa-j-"));
		roots.push(dir);
		git(dir, "init", "-q", "-b", "main");
		writeFileSync(join(dir, "README.md"), "base\n");
		git(dir, "add", "README.md");
		git(dir, "commit", "-q", "-m", "base");
		const base = git(dir, "rev-parse", "HEAD");
		writeFileSync(join(dir, ".gitattributes"), "* -diff\n");
		writeFileSync(join(dir, "s.ts"), `throw new Error("${notImpl}");\n`);
		writeFileSync(
			join(dir, "n.ts"),
			Buffer.concat([Buffer.from(`throw new Error("${notImpl}");\n`), Buffer.from([0])]),
		);
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "work");
		const diff = await collectLaneDiff(dir, { baseSha: base }, git(dir, "rev-parse", "HEAD"));
		expect(classifyLaneCompletion({ summary: "x", diff }).map((r) => r.category)).toEqual([
			"stub_implementation",
			"stub_implementation",
		]);
	});
});
