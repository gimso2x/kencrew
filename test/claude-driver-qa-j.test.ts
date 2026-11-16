import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveTurn } from "../src/core/live-turn";
import { ClaudeOmpDriver } from "../src/omp/claude-driver";
import type { OmpEvent, OmpFinal } from "../src/omp/driver";

const roots: string[] = [];
afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("qa-j 27: claude tool calls carry their id and a tool_result ends them, so the live view tracks each one", async () => {
	const root = mkdtempSync(join(tmpdir(), "ompbot-claude-qaj-"));
	roots.push(root);
	const home = join(root, "home");
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude", ".credentials.json"), "{}\n", { mode: 0o600 });
	mkdirSync(join(root, "bin"));
	const executable = join(root, "bin", "claude");
	writeFileSync(
		executable,
		`#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "helpers", "fake-claude.ts")}" "$@"\n`,
	);
	chmodSync(executable, 0o755);
	const driver = new ClaudeOmpDriver({
		claudeExecutable: executable,
		cwd: join(root, "workspace"),
		sessionDir: join(root, "sessions", "e1"),
		baseEnv: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
		startupGraceMs: 2_000,
	});
	try {
		await driver.start();
		await driver.openSession();
		const clock = { now: () => 1_000 };
		const live = new LiveTurn(clock, "m1");
		const events: OmpEvent[] = [];
		driver.onEvent((event) => {
			events.push(event);
			live.feed(event);
		});
		const { promise, resolve } = Promise.withResolvers<OmpFinal>();
		driver.onFinal(resolve);
		await driver.prompt("@toolpair");
		await promise;
		expect(events.filter((e) => e.type === "tool_execution_start").map((e) => e.toolCallId)).toEqual(["tu-a", "tu-b"]);
		expect(events.filter((e) => e.type === "tool_execution_end").map((e) => e.toolCallId)).toEqual(["tu-a"]);
		expect(live.view()?.running.map((tool) => tool.name)).toEqual(["Bash"]);
	} finally {
		await driver.stop();
	}
});
