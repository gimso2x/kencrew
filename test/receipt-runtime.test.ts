import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "../src/dispatch/omp";
import { QA_STALE, REVIEW_STALE, receiptBlockers, receiptNowOf } from "../src/lanes/land";
import { runQa } from "../src/lanes/qa";
import { type GateSubject, REVIEW_OVERLAY_YAML, reviewSubject } from "../src/lanes/review";
import {
	bootRuntime,
	currentRuntime,
	GATE_PATHS,
	gateChangedOf,
	gatePathsChanged,
	ompMinor,
	overlayHash,
	primeGateChanges,
	receiptRuntime,
	receiptStale,
	runtimeKey,
	type StaleContext,
} from "../src/lanes/runtime";
import type { LaneQa, LaneReview, ReceiptRuntime, RuntimeIdentity } from "../src/lanes/status";
import { defaultGit, type GitRunner } from "../src/lanes/verify";
import { gateRuntimeKey, taskGateStep } from "../src/tasks/gate";
import type { AutoLandPolicy } from "../src/tasks/notify";
import { git, makeRepo } from "./helpers/git-fixtures";

const SHA = "a".repeat(40);
const MODEL = "test/reviewer";
const QA_MODEL = "test/qa";
const KENCREW = "1".repeat(40);
const NOW: RuntimeIdentity = { omp: "omp 18.18.7", kencrew: KENCREW, os: "linux", arch: "arm64" };
const REVIEW_HASH = overlayHash(REVIEW_OVERLAY_YAML);

const runtimeOf = (over: Partial<ReceiptRuntime> = {}): ReceiptRuntime => ({
	head: SHA,
	omp: "omp 18.18.7",
	kencrew: KENCREW,
	overlay: REVIEW_HASH,
	os: "linux",
	arch: "arm64",
	...over,
});
const reviewOf = (runtime?: ReceiptRuntime, over: Partial<LaneReview> = {}): LaneReview => ({
	sha: SHA,
	verdict: "CLEAR",
	model: MODEL,
	at: 1,
	notes: "",
	confidence: 0.95,
	...(runtime === undefined ? {} : { runtime }),
	...over,
});
const qaOf = (runtime?: ReceiptRuntime, over: Partial<LaneQa> = {}): LaneQa => ({
	sha: SHA,
	verdict: "PASS",
	findings: [],
	model: QA_MODEL,
	at: 1,
	...(runtime === undefined ? {} : { runtime }),
	...over,
});

const tmps: string[] = [];
const repos: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ompbot-receipt-runtime-"));
	tmps.push(dir);
	return dir;
};
const failingGit: GitRunner = async () => ({ code: 1, stdout: "", stderr: "no git" });

/** Back to an identity no test depends on: omp and kencrew `unknown`. */
async function resetRuntime(): Promise<void> {
	await bootRuntime({ omp: "unknown", sourceDir: "/nonexistent", git: failingGit });
}

beforeEach(resetRuntime);
afterEach(async () => {
	await resetRuntime();
	for (const dir of [...tmps.splice(0), ...repos.splice(0)]) rmSync(dir, { recursive: true, force: true });
});

describe("receiptStale (pure)", () => {
	const ok: StaleContext = { model: MODEL, overlay: REVIEW_HASH, gateSourceChanged: false };
	const qaOk = { model: QA_MODEL, overlay: REVIEW_HASH, gateSourceChanged: false };

	test("stale: overlay, model, omp major.minor, QA os/arch, changed gate source", () => {
		const review = (runtime: ReceiptRuntime, now = NOW, ctx = ok, over: Partial<LaneReview> = {}) =>
			receiptStale("review", reviewOf(runtime, over), now, ctx);
		expect(review(runtimeOf({ overlay: "0".repeat(16) }))).toContain("오버레이");
		expect(review(runtimeOf(), NOW, { ...ok, model: "other/model" })).toContain("모델");
		expect(review(runtimeOf({ omp: "omp 18.17.9" }))).toBe("omp 18.17 → 18.18");
		expect(review(runtimeOf({ omp: "omp 17.18.7" }))).toBe("omp 17.18 → 18.18");
		expect(review(runtimeOf(), NOW, { ...ok, gateSourceChanged: true })).toContain("게이트 소스");
		expect(review(runtimeOf({ head: "b".repeat(40) }))).toContain("커밋");
		const qa = (runtime: ReceiptRuntime, now = NOW) => receiptStale("qa", qaOf(runtime), now, qaOk);
		expect(qa(runtimeOf({ os: "darwin" }))).toBe("OS/arch darwin/arm64 → linux/arm64");
		expect(qa(runtimeOf({ arch: "x64" }))).toBe("OS/arch linux/x64 → linux/arm64");
	});

	test("valid: patch version, outside-gate source change, unknown, no runtime, review on another OS", () => {
		const review = (runtime: ReceiptRuntime | undefined, now = NOW, ctx = ok) =>
			receiptStale("review", reviewOf(runtime), now, ctx);
		expect(review(runtimeOf({ omp: "omp 18.18.2" }))).toBeUndefined();
		expect(review(runtimeOf({ omp: "omp 18.18.7-rc1" }))).toBeUndefined();
		expect(review(runtimeOf({ kencrew: "2".repeat(40) }), NOW, { ...ok, gateSourceChanged: false })).toBeUndefined();
		expect(review(runtimeOf({ kencrew: "unknown" }), NOW, { ...ok, gateSourceChanged: undefined })).toBeUndefined();
		expect(review(runtimeOf({ omp: "unknown" }))).toBeUndefined();
		expect(review(runtimeOf(), { ...NOW, omp: "unknown" })).toBeUndefined();
		expect(review(runtimeOf({ os: "darwin", arch: "x64" }))).toBeUndefined();
		// An earlier receipt has no runtime: it counts, whatever the policy says now.
		expect(review(undefined, NOW, { model: "other/model", overlay: "x", gateSourceChanged: true })).toBeUndefined();
		expect(receiptStale("qa", qaOf(undefined), NOW, { ...qaOk, gateSourceChanged: true })).toBeUndefined();
	});

	test("ompMinor reads major.minor of a version text", () => {
		expect(ompMinor("omp 18.18.7")).toBe("18.18");
		expect(ompMinor("19.0.1-beta.2")).toBe("19.0");
		expect(ompMinor("unknown")).toBeUndefined();
	});
});

describe("gatePathsChanged", () => {
	/** A repo whose commit `change` touches `file`; resolves the commit before and after. */
	async function changeOf(file: string): Promise<boolean | undefined> {
		const repo = makeRepo(repos);
		const before = git(repo, "rev-parse", "HEAD");
		await Bun.write(join(repo, file), "x\n");
		git(repo, "add", "--all");
		git(repo, "commit", "-q", "-m", "change");
		const after = git(repo, "rev-parse", "HEAD");
		await bootRuntime({ omp: "omp 18.18.7", sourceDir: repo });
		return gatePathsChanged(before, after);
	}

	test("dispatch/omp.ts and tasks/notify.ts count as gate changes; other sources do not", async () => {
		expect(GATE_PATHS).toContain("src/dispatch/omp.ts");
		expect(GATE_PATHS).toContain("src/tasks/notify.ts");
		expect(await changeOf("src/dispatch/omp.ts")).toBe(true);
		expect(await changeOf("src/tasks/notify.ts")).toBe(true);
		expect(await changeOf("src/safety/prompt.ts")).toBe(true);
		expect(await changeOf("src/lanes/card.ts")).toBe(false);
		expect(await changeOf("README.md")).toBe(false);
	});

	test("unknown, dirty and failing git give undefined (warned once per pair); a pair is asked once", async () => {
		const warns: string[] = [];
		const calls: string[][] = [];
		const git: GitRunner = async (args) => {
			calls.push(args);
			if (args.includes("diff")) return { code: 0, stdout: "src/lanes/land.ts\n", stderr: "" };
			return { code: 0, stdout: args.includes("status") ? "" : `${"3".repeat(40)}\n`, stderr: "" };
		};
		await bootRuntime({ omp: "omp 18.18.7", sourceDir: "/src", git, log: { warn: (event) => warns.push(event) } });
		const current = currentRuntime().kencrew;
		expect(await gatePathsChanged("unknown", current)).toBeUndefined();
		expect(await gatePathsChanged(`${"4".repeat(40)}+dirty`, current)).toBeUndefined();
		expect(await gatePathsChanged("unknown", current)).toBeUndefined();
		expect(warns).toEqual(["receipt_runtime_unknown", "receipt_runtime_unknown"]);
		expect(await gatePathsChanged(current, current)).toBe(false);
		const recorded = "5".repeat(40);
		expect(await gatePathsChanged(recorded, current)).toBe(true);
		expect(await gatePathsChanged(recorded, current)).toBe(true);
		expect(calls.filter((args) => args.includes("diff"))).toHaveLength(1);
		expect(calls.find((args) => args.includes("diff"))).toEqual([
			"-C",
			"/src",
			"diff",
			"--name-only",
			recorded,
			current,
			"--",
			...GATE_PATHS,
		]);
	});
});

describe("receipts are bound to the runtime they were made on", () => {
	function reviewFixture(): { subject: GateSubject; sha: string; repo: string; reviewsDir: string } {
		const repo = makeRepo(repos);
		const base = git(repo, "symbolic-ref", "--short", "HEAD");
		git(repo, "checkout", "-q", "-b", "work");
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, "add", "a.txt");
		git(repo, "commit", "-q", "-m", "a");
		const sha = git(repo, "rev-parse", "HEAD");
		return {
			repo,
			sha,
			reviewsDir: join(tmp(), "reviews"),
			subject: {
				id: "L-1",
				title: "t",
				brief: "brief",
				acceptance: [],
				sha,
				baseBranch: base,
				repo,
				worktree: repo,
				claim: undefined,
				checks: [],
			},
		};
	}
	const says =
		(stdout: string): ProcessRunner =>
		async () => ({ code: 0, stdout, timedOut: false });

	test("review: runtime holds head, base, omp, kencrew, os, arch, overlay hash and the omp -p argv", async () => {
		await bootRuntime({ omp: "omp 18.18.7", sourceDir: makeRepo(repos) });
		const { subject, sha, repo, reviewsDir } = reviewFixture();
		const receipt = await reviewSubject(
			{ subject, model: MODEL, timeoutMs: 1000 },
			{
				ompBin: "/bin/omp-fake",
				systemPromptAppendix: "FLOORS",
				reviewsDir,
				headOf: async () => ({ sha, clean: true }),
				now: () => 5,
				run: says("fine\nCONFIDENCE: 0.9\nVERDICT: CLEAR"),
			},
		);
		expect(receipt.verdict).toBe("CLEAR");
		const runtime = receipt.runtime;
		expect(runtime).toMatchObject({
			head: sha,
			base: git(repo, "rev-parse", `refs/heads/${subject.baseBranch}`),
			omp: "omp 18.18.7",
			kencrew: currentRuntime().kencrew,
			os: process.platform,
			arch: process.arch,
			overlay: REVIEW_HASH,
		});
		expect(runtime?.kencrew).toMatch(/^[0-9a-f]{40}$/);
		expect(runtime?.argv?.slice(0, 3)).toEqual(["/bin/omp-fake", "-p", "--no-session"]);
		expect(runtime?.argv).toContain("--model");
		expect(runtime?.argv).toContain("--config");
		expect(runtime?.argv).not.toContain("FLOORS");
		expect(runtime?.argv?.some((arg) => arg.includes("brief"))).toBe(false);
	});

	test("review: a worktree HEAD other than the gate sha makes no runtime-bearing receipt", async () => {
		const { subject, reviewsDir } = reviewFixture();
		const receipt = await reviewSubject(
			{ subject, model: MODEL, timeoutMs: 1000 },
			{
				ompBin: "/bin/omp-fake",
				systemPromptAppendix: "FLOORS",
				reviewsDir,
				headOf: async () => ({ sha: "b".repeat(40), clean: true }),
				now: () => 5,
				run: says("VERDICT: CLEAR"),
			},
		);
		expect(receipt.verdict).toBe("inconclusive");
		expect(receipt.reason).toContain("클레임 커밋이 아님");
		expect(receipt.runtime).toBeUndefined();
	});

	const qaDeps = (git: GitRunner = defaultGit) => ({
		ompBin: "/bin/omp-fake",
		systemPromptAppendix: "FLOORS",
		worktreesDir: join(tmp(), "qa-worktrees"),
		overlaysDir: join(tmp(), "reviews"),
		now: () => 7,
		git,
		run: says('{"verdict":"PASS","findings":["ok"]}'),
	});

	test("qa: runtime reads the copy's HEAD and hashes the isolation overlay with qa.overlay's content", async () => {
		await bootRuntime({ omp: "omp 18.18.7", sourceDir: makeRepo(repos) });
		const { subject, sha } = reviewFixture();
		const overlay = join(tmp(), "qa.omp.yml");
		writeFileSync(overlay, "retry:\n  maxRetries: 1\n");
		const policy = { minRisk: "L3" as const, overlay, model: QA_MODEL, timeoutMs: 1000 };
		const receipt = await runQa({ subject, policy }, qaDeps());
		expect(receipt.verdict).toBe("PASS");
		expect(receipt.runtime).toMatchObject({
			head: sha,
			omp: "omp 18.18.7",
			os: process.platform,
			arch: process.arch,
			overlay: overlayHash(REVIEW_OVERLAY_YAML, "retry:\n  maxRetries: 1\n"),
		});
		expect(receipt.runtime?.argv?.filter((arg) => arg === "--config")).toHaveLength(2);
		expect(receipt.runtime?.argv).toContain(overlay);
		// Changing the overlay's content changes the hash a later receipt carries.
		writeFileSync(overlay, "retry:\n  maxRetries: 2\n");
		const again = await runQa({ subject, policy }, qaDeps());
		expect(again.runtime?.overlay).not.toBe(receipt.runtime?.overlay);
	});

	test("qa: an unreadable qa.overlay or a copy HEAD other than the sha is inconclusive", async () => {
		const { subject } = reviewFixture();
		const policy = { minRisk: "L3" as const, overlay: "/nonexistent/qa.omp.yml", model: QA_MODEL, timeoutMs: 1000 };
		const unreadable = await runQa({ subject, policy }, qaDeps());
		expect(unreadable).toMatchObject({ verdict: "inconclusive", reason: "QA 오버레이 읽기 실패" });
		const overlay = join(tmp(), "qa.omp.yml");
		writeFileSync(overlay, "{}\n");
		const moved: GitRunner = async (args) =>
			args[2] === "rev-parse" && args[3] === "HEAD" && args[1] !== subject.repo
				? { code: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" }
				: defaultGit(args);
		const wrongHead = await runQa({ subject, policy: { ...policy, overlay } }, qaDeps(moved));
		expect(wrongHead.verdict).toBe("inconclusive");
		expect(wrongHead.reason).toContain("클레임 커밋이 아님");
		expect(wrongHead.runtime).toBeUndefined();
	});

	test("receiptRuntime copies the process identity and the observed fields", () => {
		expect(receiptRuntime({ head: SHA }, NOW)).toEqual({
			head: SHA,
			omp: NOW.omp,
			kencrew: NOW.kencrew,
			os: NOW.os,
			arch: NOW.arch,
		});
	});
});

describe("a stale receipt holds the merge and is made again", () => {
	const policy: AutoLandPolicy = {
		repos: ["/r"],
		maxRisk: "L2",
		review: { model: MODEL, timeoutMs: 1 },
		qa: { minRisk: "L3", overlay: "/nonexistent-qa-overlay", model: QA_MODEL, timeoutMs: 1 },
	};
	const now = {
		identity: NOW,
		review: { model: MODEL, overlay: REVIEW_HASH },
		qa: { model: QA_MODEL, overlay: REVIEW_HASH },
	};

	test("receiptBlockers: REVIEW_STALE / QA_STALE for a stale receipt, nothing for a current or earlier one", () => {
		const current = { review: reviewOf(runtimeOf()), qa: qaOf(runtimeOf()) };
		expect(receiptBlockers(current, SHA, "L3", policy, now)).toEqual([]);
		const staleReview = { ...current, review: reviewOf(runtimeOf({ omp: "omp 18.17.0" })) };
		const [review] = receiptBlockers(staleReview, SHA, "L3", policy, now);
		expect(review).toStartWith(REVIEW_STALE);
		const staleQa = { ...current, qa: qaOf(runtimeOf({ os: "darwin" })) };
		const [qa] = receiptBlockers(staleQa, SHA, "L3", policy, now);
		expect(qa).toStartWith(QA_STALE);
		expect(receiptBlockers({ review: reviewOf(), qa: qaOf() }, SHA, "L3", policy, now)).toEqual([]);
	});

	test("a gate source change reported by the cache makes it stale; the new receipt (this runtime) lifts it", async () => {
		const repo = makeRepo(repos);
		const before = git(repo, "rev-parse", "HEAD");
		await Bun.write(join(repo, "src/tasks/gate.ts"), "export {};\n");
		git(repo, "add", "--all");
		git(repo, "commit", "-q", "-m", "gate");
		await bootRuntime({ omp: "omp 18.18.7", sourceDir: repo });
		const old = reviewOf(runtimeOf({ kencrew: before }));
		expect(gateChangedOf(before)).toBeUndefined();
		await primeGateChanges({ review: old });
		expect(gateChangedOf(before)).toBe(true);
		const identity = currentRuntime();
		const live = { ...now, identity };
		expect(receiptBlockers({ review: old }, SHA, "L2", { ...policy, qa: undefined }, live)[0]).toStartWith(
			REVIEW_STALE,
		);
		const fresh = reviewOf(runtimeOf({ kencrew: identity.kencrew }));
		expect(receiptBlockers({ review: fresh }, SHA, "L2", { ...policy, qa: undefined }, live)).toEqual([]);
	});

	test("taskGateStep runs the kind again for a stale receipt, and lands on the new one", () => {
		const stale = { review: reviewOf(runtimeOf({ omp: "omp 18.17.0" })), qa: qaOf(runtimeOf()) };
		expect(taskGateStep(stale, SHA, "L3", policy, now)).toEqual({ run: "review" });
		const reviewed = { review: reviewOf(runtimeOf()), qa: qaOf(runtimeOf({ arch: "x64" })) };
		expect(taskGateStep(reviewed, SHA, "L3", policy, now)).toEqual({ run: "qa" });
		expect(taskGateStep({ review: reviewOf(runtimeOf()), qa: qaOf(runtimeOf()) }, SHA, "L3", policy, now)).toEqual({
			blockers: [],
		});
		expect(taskGateStep({ review: reviewOf(), qa: qaOf() }, SHA, "L3", policy, now)).toEqual({ blockers: [] });
	});

	test("gateRuntimeKey differs by omp minor, model and overlay but not by omp patch", async () => {
		const key = (over: Partial<typeof now> = {}) => gateRuntimeKey({ ...now, ...over });
		const base = key();
		await bootRuntime({ omp: "omp 18.18.7", sourceDir: "/x", git: failingGit });
		const minor18 = gateRuntimeKey(now);
		await bootRuntime({ omp: "omp 18.18.9", sourceDir: "/x", git: failingGit });
		expect(gateRuntimeKey(now)).toBe(minor18);
		await bootRuntime({ omp: "omp 18.19.0", sourceDir: "/x", git: failingGit });
		expect(gateRuntimeKey(now)).not.toBe(minor18);
		expect(key({ review: { model: "other", overlay: REVIEW_HASH } })).not.toBe(base);
		expect(key({ qa: { model: QA_MODEL, overlay: "1".repeat(16) } })).not.toBe(base);
		expect(runtimeKey({ model: "m", overlay: "o" })).toMatch(/^[0-9a-f]{8}$/);
		expect(receiptNowOf(policy).qa?.overlay).toBeUndefined();
	});
});
