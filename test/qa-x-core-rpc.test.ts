// QA qa-x fixes (doc/plans/qa-x-core-rpc-fixes.md): RPC client/driver edge cases, select cards, `!undo` ledger and paths.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OmpDialogRequest, OmpDriverError, type OmpFinal } from "../src/omp/driver";
import { MAX_RPC_FRAME_BYTES, OmpRpcClient, RpcProtocolError, readLines } from "../src/omp/rpc-client";
import { ExtensionUiTap, RpcOmpDriver } from "../src/omp/rpc-driver";
import { gcSessions } from "../src/ops/gc";
import {
	applyUndo,
	captureTree,
	planUndo,
	recordTurn,
	type TurnSnapshotRow,
	undoPlanNotes,
} from "../src/ops/turn-snapshot";
import type { ApprovalBroker } from "../src/safety/approval";
import { answerDialog } from "../src/safety/choice";
import { openStore, type Store } from "../src/store/db";
import { FakeOmpPeer, fakeOmpExecutable } from "./helpers/fake-omp-rpc";
import { makeRepo } from "./helpers/git-fixtures";

const root = mkdtempSync(join(tmpdir(), "ompbot-qa-x-core-rpc-"));
const repos: string[] = [];
const stores: Store[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirCounter = 0;

/** Rejects when `promise` has not settled within `ms` (a failure deadline, never a wait for time to pass). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
	return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer));
}

describe("rpc client", () => {
	test("#1 a request the child never answers fails with request_timeout, the code the mailbox replaces the child on", async () => {
		const peer = new FakeOmpPeer();
		peer.replies.set("get_state", () => "hold");
		const client = new OmpRpcClient({
			executable: "omp",
			args: [],
			cwd: root,
			env: {},
			spawn: peer.spawn,
			requestTimeoutMs: 20,
		});
		await client.start();
		try {
			const error = await client.getState().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(OmpDriverError);
			expect(error).toMatchObject({ code: "request_timeout" });
			expect((error as Error).message).toContain("no response to get_state");
		} finally {
			await client.stop();
		}
	});

	test("#2 a prompt_result without a valid status ends the turn as an error final, never an undefined status", async () => {
		const peer = new FakeOmpPeer();
		const dir = join(root, `d${++dirCounter}`);
		mkdirSync(dir, { recursive: true });
		const driver = new RpcOmpDriver({
			ompExecutable: fakeOmpExecutable(dir),
			cwd: join(dir, "ws"),
			sessionDir: join(dir, "s"),
			spawn: peer.spawn,
		});
		await driver.start();
		try {
			const finals: OmpFinal[] = [];
			const ended = Promise.withResolvers<void>();
			driver.onFinal((final) => {
				finals.push(final);
				ended.resolve();
			});
			const opRef = await driver.prompt("hi");
			peer.push({ type: "prompt_result", id: opRef, agentInvoked: true });
			await within(ended.promise, 2000, "error final");
			expect(finals).toEqual([{ opRef, status: "error", text: "", error: expect.stringContaining("status") }]);
		} finally {
			await driver.stop();
		}
	});

	test("#3 a line past the 1 MiB frame limit without a newline is a protocol error, not unbounded buffering", async () => {
		const piece = new Uint8Array(256 * 1024).fill(97);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let sent = 0; sent <= MAX_RPC_FRAME_BYTES; sent += piece.byteLength) controller.enqueue(piece);
				controller.close();
			},
		});
		await expect(
			(async () => {
				for await (const _line of readLines(stream)) {
					// the oversized line must never be yielded
				}
			})(),
		).rejects.toBeInstanceOf(RpcProtocolError);
	});

	test("#3 a frame exactly at the limit still passes", async () => {
		const body = `${"b".repeat(MAX_RPC_FRAME_BYTES - 1)}\n`;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body.slice(0, 1000)));
				controller.enqueue(new TextEncoder().encode(body.slice(1000)));
				controller.close();
			},
		});
		const lines: string[] = [];
		for await (const line of readLines(stream)) lines.push(line);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.length).toBe(MAX_RPC_FRAME_BYTES - 1);
	});
});

/** Runs one select frame through omp's dialog tap and the real `answerDialog` card text, with a recording broker. */
async function cardTextOf(frame: Record<string, unknown>): Promise<{ request: OmpDialogRequest; text: string }> {
	let seen: OmpDialogRequest | undefined;
	let text = "";
	const broker = {
		dropInput: () => {},
		choose: async (_origin: unknown, spec: { text: string }) => {
			text = spec.text;
			return { next: async () => ({ kind: "cancelled" as const }), close: async () => {} };
		},
	} as unknown as ApprovalBroker;
	const replied = Promise.withResolvers<void>();
	const tap = new ExtensionUiTap(
		() => {},
		() => replied.resolve(),
		async (request, signal) => {
			seen = request;
			return answerDialog(broker, { originKey: "discord/dm/1", channel: "1", threadTs: "1" }, request, signal);
		},
	);
	tap.frame({ type: "extension_ui_request", method: "select", id: "u1", title: "고르세요", ...frame });
	await within(replied.promise, 2000, "dialog reply");
	if (seen === undefined) throw new Error("the dialog never reached the answerer");
	return { request: seen, text };
}

describe("select cards", () => {
	test("#4 optionDetails descriptions are listed on the card as `번호. 라벨 — 설명`", async () => {
		const { text } = await cardTextOf({
			options: ["배포", "취소"],
			optionDetails: [{ description: "운영에 올린다" }, {}],
		});
		expect(text).toContain("1. 배포 — 운영에 올린다");
		expect(text).toContain("2. 취소");
		expect(text).not.toContain("2. 취소 —");
	});

	test("#4 a select without descriptions keeps its plain card (no number list under buttons)", async () => {
		const { text } = await cardTextOf({ options: ["a", "b"] });
		expect(text).not.toContain("1. a");
	});

	test("#5 checkedIndices and markableCount mark the checked rows and the action rows", async () => {
		const { request, text } = await cardTextOf({
			options: ["빌드", "테스트", "Done"],
			selectionMarker: "checkbox",
			checkedIndices: [1],
			markableCount: 2,
		});
		expect(request).toMatchObject({ checkedIndices: [1], markableCount: 2 });
		expect(text).toContain("1. ☐ 빌드");
		expect(text).toContain("2. ☑ 테스트");
		expect(text).toContain("3. ▶ Done");
	});
});

/** A repository with one turn that changed `file`, and the ledger row of it. */
async function turnOf(file: string, extra: Partial<TurnSnapshotRow> = {}) {
	const repo = makeRepo(repos);
	const before = await captureTree(repo);
	writeFileSync(join(repo, file), "turn\n");
	const after = await captureTree(repo);
	const row: TurnSnapshotRow = {
		id: 1,
		originKey: "discord/dm/200000000000000001",
		opRef: "op_1",
		repo,
		headBefore: before.head,
		treeBefore: before.tree,
		headAfter: after.head,
		treeAfter: after.tree,
		startedAt: 1000,
		endedAt: 2000,
		revertedAt: null,
		...extra,
	};
	return { repo, row, before, after };
}

describe("!undo", () => {
	test("#6 gc keeps the ledger row of a turn whose ref could not be deleted, and drops the others", async () => {
		const home = mkdtempSync(join(tmpdir(), "ompbot-qa-x-gc-"));
		repos.push(home);
		const dbPath = join(home, "ompbot.db");
		const now = 100 * 86_400_000;
		const open = () =>
			openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => now }, redact: (text) => text });
		const store = open();
		stores.push(store);
		const repo = makeRepo(repos);
		const base = await captureTree(repo);
		writeFileSync(join(repo, "x.txt"), "x\n");
		const after = await captureTree(repo);
		const origin = "discord/dm/200000000000000001";
		for (const opRef of ["op_a", "op_b"]) {
			const endedAt = now - 8 * 86_400_000;
			await recordTurn({
				store,
				originKey: origin,
				opRef,
				capture: { startedAt: endedAt - 1, endedAt, before: new Map([[repo, base]]), after: new Map([[repo, after]]) },
			});
		}
		const [first, second] = store.listTurnSnapshots({ originKey: origin }).sort((a, b) => a.id - b.id);
		if (first === undefined || second === undefined) throw new Error("two rows expected");
		// A ref lock git cannot take makes `update-ref -d` fail for the first row only.
		writeFileSync(join(repo, ".git", "refs", "ompbot", "turns", String(first.id), "before.lock"), "");
		store.close();

		const result = gcSessions({ homeDir: home, retentionDays: 30, now });
		expect(result.turnSnapshotsRemoved).toBe(1);
		const reopened = open();
		stores.push(reopened);
		expect(reopened.listTurnSnapshots({ originKey: origin }).map((row) => row.id)).toEqual([first.id]);
		expect(second.id).not.toBe(first.id);
	});

	test("#7 undo never deletes a file through a parent directory that became a symlink out of the repository", async () => {
		const { repo, row } = await turnOf("keep.txt");
		const outside = mkdtempSync(join(tmpdir(), "ompbot-qa-x-outside-"));
		repos.push(outside);
		// The plan deletes sub/x.txt as turn-created; since then `sub` was swapped for a link to a directory outside.
		writeFileSync(join(outside, "x.txt"), "precious\n");
		symlinkSync(outside, join(repo, "sub"));
		const applied = await applyUndo({ repo, source: row.treeBefore, files: [{ path: "sub/x.txt", kind: "revert" }] });
		expect(applied.conflicts).toEqual(["sub/x.txt"]);
		expect(applied.reverted).toBe(0);
		expect(existsSync(join(outside, "x.txt"))).toBe(true);
	});

	test("#8 a turn whose repository is gone plans as missing, with a note, so the turn can be closed", async () => {
		const { repo, row } = await turnOf("a.txt");
		rmSync(repo, { recursive: true, force: true });
		const plan = await planUndo({ row });
		expect(plan).toMatchObject({ repo, missing: true, files: [] });
		expect(undoPlanNotes(plan)).toEqual([`저장소를 찾을 수 없음: ${repo}`]);
	});

	test("#9 the revert advice quotes a repository path with spaces and quotes", async () => {
		const { row } = await turnOf("a.txt");
		const spaced = join(root, `my repo's ${++dirCounter}`);
		mkdirSync(spaced, { recursive: true });
		const plan = await planUndo({ row: { ...row, repo: spaced, headAfter: "f".repeat(40) } });
		expect(plan.commit?.advice).toBe(
			`git -C '${spaced.replaceAll("'", "'\\''")}' revert --no-edit ${row.headBefore}..${"f".repeat(40)}`,
		);
	});
});
