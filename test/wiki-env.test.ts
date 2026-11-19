import { describe, expect, test } from "bun:test";
import { herdrRemoteStart, herdrStartAgent, type ProcessRunner } from "../src/dispatch/omp";

// The herdr start argv (doc/plans/wiki-work-outcome-notes.md E): `--env` goes to `workspace create` / `tab create` only
// when the caller asks, so an ordinary dispatch is unchanged.

/** The herdr words of each call; over ssh the remote words come single-quoted. */
const words = (cmd: string[]): string[] =>
	(cmd[0] === "ssh" ? cmd.slice(cmd.indexOf("--") + 2) : cmd).map((word) => word.replace(/^'(.*)'$/, "$1"));
function recorder(workspaces: unknown[] = []): { run: ProcessRunner; calls: string[][] } {
	const calls: string[][] = [];
	const run: ProcessRunner = async (cmd) => {
		calls.push(cmd);
		const args = words(cmd);
		const answer = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), timedOut: false });
		if (args[1] === "agent" && args[2] === "list") return answer({ result: { agents: [] } });
		if (args[1] === "workspace" && args[2] === "list") return answer({ result: { workspaces } });
		if (args[2] === "create") {
			return answer({
				result: { workspace: { workspace_id: "W1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "P1" } },
			});
		}
		return { code: 0, stdout: "{}", timedOut: false };
	};
	return { run, calls };
}

const creates = (calls: string[][]): string[][] =>
	calls.map(words).filter((args) => args[2] === "create" && (args[1] === "workspace" || args[1] === "tab"));

describe("herdr --env", () => {
	test("AC-5: a local start with env puts --env KEY=VALUE on workspace create; without env there is none", async () => {
		const withEnv = recorder();
		await herdrStartAgent({
			name: "t-1",
			task: "go",
			cwd: "/ws",
			env: { OMP_WIKI_NOTE_DISABLE: "1" },
			options: { run: withEnv.run },
		});
		expect(creates(withEnv.calls)[0]).toEqual([
			"herdr",
			"workspace",
			"create",
			"--cwd",
			"/ws",
			"--label",
			"ompbot · t-1",
			"--no-focus",
			"--env",
			"OMP_WIKI_NOTE_DISABLE=1",
		]);
		const plain = recorder();
		await herdrStartAgent({ name: "t-2", task: "go", cwd: "/ws", options: { run: plain.run } });
		expect(creates(plain.calls)[0]).not.toContain("--env");
	});

	test("AC-5: a remote start puts --env on the workspace it creates and on the tab it adds to the owners workspace", async () => {
		const first = recorder();
		await herdrRemoteStart({
			sshTarget: "h",
			name: "t-1",
			task: "go",
			cwd: "/r",
			env: { OMP_WIKI_NOTE_DISABLE: "1" },
			options: { run: first.run },
		});
		expect(creates(first.calls)[0]).toContain("--env");
		const second = recorder([{ label: "ompbot-owners", workspace_id: "W9" }]);
		await herdrRemoteStart({
			sshTarget: "h",
			name: "t-2",
			task: "go",
			cwd: "/r",
			env: { OMP_WIKI_NOTE_DISABLE: "1" },
			options: { run: second.run },
		});
		const tab = creates(second.calls)[0] ?? [];
		expect(tab).toContain("tab");
		expect(tab).toEqual(expect.arrayContaining(["--env", "OMP_WIKI_NOTE_DISABLE=1"]));
	});
});
