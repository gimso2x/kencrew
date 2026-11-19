import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unjustifiedSleeps } from "../src/dev/test-sleeps";

function diffOf(lines: string[], file = "test/a.ts"): string {
	return [
		`diff --git a/${file} b/${file}`,
		"index 0000000..1111111 100644",
		`--- a/${file}`,
		`+++ b/${file}`,
		...lines,
	].join("\n");
}

const hunk = (start: string, ...lines: string[]) => [`@@ ${start} @@`, ...lines];

describe("unjustifiedSleeps", () => {
	test("0이 아닌 숫자 지연(소수·16진·밑줄·콜백 포함)은 걸리고 변수 지연은 통과한다", () => {
		const diff = diffOf([
			...hunk(
				"-0,0 +1,7",
				"+setTimeout(resolve, 50);",
				"+setTimeout(() => {}, 50);",
				"+setTimeout(r, delayMs);",
				"+Bun.sleep(5);",
				"+Bun.sleep(0.5);",
				"+setTimeout(() => {}, 0x10);",
				"+Bun.sleep(1_000);",
			),
		]);
		const hits = unjustifiedSleeps(diff);
		expect(hits.map((hit) => [hit.file, hit.line])).toEqual([
			["test/a.ts", 1],
			["test/a.ts", 2],
			["test/a.ts", 4],
			["test/a.ts", 5],
			["test/a.ts", 6],
			["test/a.ts", 7],
		]);
	});

	test("Bun.sleepSync 숫자 0은 통과, 0이 아니면 걸린다", () => {
		const diff = diffOf([...hunk("-0,0 +1,2", "+Bun.sleepSync(0);", "+Bun.sleepSync(10);")]);
		const hits = unjustifiedSleeps(diff);
		expect(hits.map((hit) => [hit.file, hit.line, hit.text])).toEqual([["test/a.ts", 2, "Bun.sleepSync(10);"]]);
	});

	test("지연 생략·0 값(0·0.0·0x0)은 통과한다", () => {
		const diff = diffOf([
			...hunk(
				"-0,0 +1,5",
				"+setTimeout(resolve, 0);",
				"+setTimeout(resolve);",
				"+setTimeout(() => {}, 0.0);",
				"+Bun.sleep(0x0);",
				"+Bun.sleep(0);",
			),
		]);
		expect(unjustifiedSleeps(diff)).toEqual([]);
	});

	test("같은 줄 표지와 바로 앞 추가 줄 표지는 통과시킨다", () => {
		const sameLine = diffOf([...hunk("-0,0 +1", "+setTimeout(resolve, 50); // sleep-ok: 측정 창")]);
		const prevLine = diffOf([...hunk("-0,0 +1,2", "+// sleep-ok: 측정 창", "+setTimeout(resolve, 50);")]);
		expect(unjustifiedSleeps(sameLine)).toEqual([]);
		expect(unjustifiedSleeps(prevLine)).toEqual([]);
	});

	test("빈 이유 표지는 무효라서 걸린다", () => {
		const prevLine = diffOf([...hunk("-0,0 +1,2", "+// sleep-ok:", "+setTimeout(resolve, 50);")]);
		const sameLine = diffOf([...hunk("-0,0 +1", "+setTimeout(resolve, 50); // sleep-ok: ")]);
		const hits = unjustifiedSleeps(prevLine);
		expect(hits.map((hit) => [hit.file, hit.line])).toEqual([["test/a.ts", 2]]);
		expect(unjustifiedSleeps(sameLine).map((hit) => hit.line)).toEqual([1]);
	});

	test("삭제 줄·문맥 줄은 판정하지 않고 문맥 줄은 번호를 민다", () => {
		const diff = diffOf([
			...hunk("-5 +5,2", " setTimeout(resolve, 0);", "+setTimeout(resolve, 50);", "-setTimeout(r, delayMs);"),
		]);
		const hits = unjustifiedSleeps(diff);
		expect(hits.map((hit) => [hit.file, hit.line])).toEqual([["test/a.ts", 6]]);
	});

	test("src/ 파일과 test/의 .md는 대상이 아니다", () => {
		const srcDiff = diffOf([...hunk("-0,0 +1", "+Bun.sleep(5);")], "src/daemon/loop.ts");
		const mdDiff = diffOf([...hunk("-0,0 +1", "+Bun.sleep(5);")], "test/readme.md");
		expect(unjustifiedSleeps(srcDiff)).toEqual([]);
		expect(unjustifiedSleeps(mdDiff)).toEqual([]);
	});

	test("판정기 자기 테스트 파일은 제외 목록으로 통과한다", () => {
		const diff = diffOf([...hunk("-0,0 +1", "+Bun.sleep(5);")], "test/test-sleeps.test.ts");
		expect(unjustifiedSleeps(diff)).toEqual([]);
	});

	test("보고된 줄 번호는 hunk의 새 줄 번호를 따른다", () => {
		const diff = diffOf([
			...hunk("-0,0 +1,2", "+const a = 1;", "+setTimeout(resolve, 50);"),
			...hunk("-10 +12", "+Bun.sleep(5);"),
		]);
		const hits = unjustifiedSleeps(diff);
		expect(hits.map((hit) => [hit.file, hit.line])).toEqual([
			["test/a.ts", 2],
			["test/a.ts", 12],
		]);
	});
});

const tempDirs: string[] = [];
const scriptPath = path.resolve(import.meta.dir, "../src/dev/test-sleeps.ts");

function makeTempRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "test-sleeps-"));
	tempDirs.push(dir);
	return dir;
}

function gitIn(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} 실패: ${new TextDecoder().decode(proc.stderr)}`);
	}
	return new TextDecoder().decode(proc.stdout);
}

function runGate(cwd: string, args: string[] = []): { code: number; out: string; err: string } {
	const proc = Bun.spawnSync(["bun", scriptPath, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: proc.exitCode ?? -1,
		out: new TextDecoder().decode(proc.stdout),
		err: new TextDecoder().decode(proc.stderr),
	};
}

describe("test-sleeps 진입점", () => {
	afterAll(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	});

	test("기준 ref가 없는 임시 저장소에서 exit 0과 건너뜀 메시지를 낸다", () => {
		const repo = makeTempRepo();
		gitIn(repo, ["init", "-b", "main"]);
		const result = runGate(repo);
		expect(result.code).toBe(0);
		expect(result.out).toContain("비교할 기준 없음, 건너뜀");
	});

	test("고정 sleep을 추가한 임시 저장소에서 exit 1과 파일:줄을 낸다", () => {
		const repo = makeTempRepo();
		gitIn(repo, ["init", "-b", "main"]);
		writeFileSync(path.join(repo, "README.md"), "base\n");
		gitIn(repo, ["add", "README.md"]);
		gitIn(repo, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "base"]);
		mkdirSync(path.join(repo, "test"));
		writeFileSync(path.join(repo, "test", "foo.ts"), "export const wait = () => setTimeout(() => {}, 50);\n");
		gitIn(repo, ["add", "test/foo.ts"]);
		const result = runGate(repo);
		expect(result.code).toBe(1);
		expect(result.out).toContain("test/foo.ts:1:");
	});

	test("--base로 지정한 ref를 기준으로 삼는다", () => {
		const repo = makeTempRepo();
		gitIn(repo, ["init", "-b", "main"]);
		writeFileSync(path.join(repo, "README.md"), "base\n");
		gitIn(repo, ["add", "README.md"]);
		gitIn(repo, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "base"]);
		mkdirSync(path.join(repo, "test"));
		writeFileSync(path.join(repo, "test", "clean.ts"), "export const a = 1;\n");
		gitIn(repo, ["add", "test/clean.ts"]);
		gitIn(repo, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "clean"]);
		writeFileSync(path.join(repo, "test", "clean.ts"), "export const a = 1;\nsetTimeout(() => {}, 20);\n");
		const result = runGate(repo, ["--base=HEAD~1"]);
		expect(result.code).toBe(1);
		expect(result.out).toContain("test/clean.ts:2:");
	});
});
