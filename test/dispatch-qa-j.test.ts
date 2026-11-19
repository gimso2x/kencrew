import { describe, expect, test } from "bun:test";
import { herdrReadAgent, type ProcessRunner, realProcessRunner } from "../src/dispatch/omp";
import { buildDispatchTool, type DispatchToolDeps } from "../src/dispatch/tool";

const AKIA = `AKIA${"QWERTYUIOPASDFGH"}`;
const SIGNAL = { signal: new AbortController().signal };

function toolWith(run: ProcessRunner, extra: Partial<DispatchToolDeps> = {}) {
	return buildDispatchTool({
		originKey: "discord/dm/200000000000000001",
		ompExecutable: "omp",
		homeDir: "/h",
		workspaceDir: "/h/workspace",
		log: { info() {}, warn() {} },
		run,
		...extra,
	});
}

describe("dispatch tool (qa-j)", () => {
	// qa-j n48/n108: a task node or the kernel cannot take as one argument is refused before any spawn.
	test("a task with a NUL byte or over the argv limit is refused before a process starts", async () => {
		const runs: string[][] = [];
		const tool = toolWith(async (cmd) => {
			runs.push(cmd);
			return { code: 0, stdout: "ok", timedOut: false };
		});
		await expect(tool.execute({ task: "a\0b" }, SIGNAL)).rejects.toThrow("제어문자");
		await expect(tool.execute({ task: "한".repeat(40_000) }, SIGNAL)).rejects.toThrow("너무 깁니다");
		expect(runs).toEqual([]);
	});

	// qa-j n48/n108: whatever still reaches the spawn boundary comes back as a failed run, not a thrown error.
	test("the real runner reports a spawn that throws synchronously as a failed run", async () => {
		const nul = await realProcessRunner(["/bin/echo", "a\0b"], { cwd: "/tmp" });
		expect(nul.code).toBeNull();
		expect(nul.stdout.startsWith("spawn failed:")).toBe(true);
		const huge = await realProcessRunner(["/bin/echo", "x".repeat(140_000)], { cwd: "/tmp" });
		expect(huge.code).toBeNull();
		expect(huge.stdout.startsWith("spawn failed:")).toBe(true);
	});

	// qa-j n49/n109: a herdr failure string is masked like a success.
	test("a herdr failure message is redacted", async () => {
		const read = await herdrReadAgent("w", {
			run: async () => ({ code: 1, stdout: "", stderr: `boom ${AKIA}`, timedOut: false }),
		});
		expect(read.ok).toBe(false);
		expect(read.error).not.toContain(AKIA);
		const tool = toolWith(async () => ({ code: 1, stdout: "", stderr: `boom ${AKIA}`, timedOut: false }), {
			herdr: {},
		});
		const text = await tool.execute({ mode: "herdr", name: "w" }, SIGNAL);
		expect(text).toContain("읽기 실패");
		expect(text).not.toContain(AKIA);
	});

	// qa-j n106: herdr's prompt has no `--`, so a task that starts with `-` would be an option.
	test("a herdr task starting with a dash is refused", async () => {
		const runs: string[][] = [];
		const tool = toolWith(
			async (cmd) => {
				runs.push(cmd);
				return { code: 0, stdout: "{}", timedOut: false };
			},
			{ herdr: {} },
		);
		await expect(tool.execute({ mode: "herdr", name: "w", task: "--help" }, SIGNAL)).rejects.toThrow("`-`로 시작");
		expect(runs).toEqual([]);
	});

	// qa-j n110: name without mode must not fall into `omp -p` and lose the name.
	test("with herdr on, a name without mode goes to herdr; mode simple with a name is refused", async () => {
		const runs: string[][] = [];
		const tool = toolWith(
			async (cmd) => {
				runs.push(cmd);
				return { code: 1, stdout: "", stderr: "no herdr", timedOut: false };
			},
			{ herdr: {} },
		);
		await tool.execute({ name: "w", task: "빌드 상태 요약" }, SIGNAL);
		expect(runs[0]?.[0]).toBe("herdr");
		expect(runs.some((cmd) => cmd.includes("-p"))).toBe(false);
		await expect(tool.execute({ mode: "simple", name: "w", task: "x" }, SIGNAL)).rejects.toThrow("simple 모드");
	});

	// qa-j n111: a failed `omp -p` does not read as a finished run.
	test("simple mode marks a non-zero exit in the result", async () => {
		const tool = toolWith(async () => ({ code: 2, stdout: "partial answer", timedOut: false }));
		const text = await tool.execute({ task: "빌드 상태 요약" }, SIGNAL);
		expect(text).toContain("partial answer");
		expect(text).toContain("[실패: omp -p exit 2");
		const ok = await toolWith(async () => ({ code: 0, stdout: "fine", timedOut: false })).execute(
			{ task: "x" },
			SIGNAL,
		);
		expect(ok).toBe("fine");
	});
});
