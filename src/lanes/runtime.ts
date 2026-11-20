import { createHash } from "node:crypto";
import type { Logger } from "../log";
import type { LaneQa, LaneReview, ReceiptRuntime, RuntimeIdentity } from "./status";
import { defaultGit, type GitRunner } from "./verify";

/**
 * What a review, QA or check run was observed on (doc/plans/receipt-runtime-binding.md): the identity of this process
 * (`omp` version, kencrew source commit, OS/arch) fixed at the daemon's start, and `receiptStale` — the pure rule that
 * tells whether a receipt made on another runtime no longer counts. Everything else a receipt records (`head`, `base`,
 * `overlay`, `argv`) is what its maker observed.
 */

/** Paths whose change between two kencrew commits can change what a receipt means (the gates and how they run `omp -p`). */
export const GATE_PATHS = [
	"src/lanes/review.ts",
	"src/lanes/qa.ts",
	"src/lanes/land.ts",
	"src/lanes/verify.ts",
	"src/lanes/integrity.ts",
	"src/lanes/runtime.ts",
	"src/tasks/checker.ts",
	"src/tasks/signals.ts",
	"src/tasks/gate.ts",
	"src/tasks/notify.ts",
	"src/tasks/risk-floor.ts",
	"src/dispatch/omp.ts",
	"src/safety",
] as const;

const UNKNOWN = "unknown";
const DIRTY = "+dirty";

let identity: RuntimeIdentity = { omp: UNKNOWN, kencrew: UNKNOWN, os: process.platform, arch: process.arch };
let source: { dir: string; git: GitRunner; log?: Pick<Logger, "warn"> } | undefined;
/** `gatePathsChanged` results by `<recorded>\0<current>`: one git call and one warning per pair. */
const gateChanges = new Map<string, boolean | undefined>();

/** This process's runtime: what a receipt made now is recorded with and what a receipt is compared against. */
export const currentRuntime = (): RuntimeIdentity => identity;

/**
 * Fixes the runtime of this process at the daemon's start: the `omp` version (`ompVersion` as read then) and the HEAD of
 * the kencrew source checkout in `sourceDir` (`+dirty` with uncommitted changes, `unknown` when git cannot tell).
 */
export async function bootRuntime(input: {
	omp: string;
	sourceDir: string;
	git?: GitRunner;
	log?: Pick<Logger, "warn">;
}): Promise<RuntimeIdentity> {
	const git = input.git ?? defaultGit;
	source = { dir: input.sourceDir, git, ...(input.log === undefined ? {} : { log: input.log }) };
	gateChanges.clear();
	identity = {
		omp: input.omp,
		kencrew: await sourceCommit(git, input.sourceDir),
		os: process.platform,
		arch: process.arch,
	};
	return identity;
}

async function sourceCommit(git: GitRunner, dir: string): Promise<string> {
	const head = await git(["-C", dir, "rev-parse", "HEAD"]);
	const sha = head.stdout.trim();
	if (head.code !== 0 || sha === "") return UNKNOWN;
	const status = await git(["-C", dir, "status", "--porcelain"]);
	if (status.code !== 0) return UNKNOWN;
	return status.stdout.trim() === "" ? sha : `${sha}${DIRTY}`;
}

/** The first 16 hex characters of the sha256 of `parts` joined by `\0`: the content identity of a `--config` overlay. */
export const overlayHash = (...parts: string[]): string =>
	createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);

/** `--append-system-prompt`'s text is long: a receipt's `argv` keeps its hash in its place. */
export function argvForReceipt(args: readonly string[]): string[] {
	return args.map((arg, index) => (args[index - 1] === "--append-system-prompt" ? `sha256:${overlayHash(arg)}` : arg));
}

/** The receipt's runtime of one run: what this process is plus what the run observed. */
export function receiptRuntime(
	observed: { head: string; base?: string; overlay?: string; argv?: string[] },
	now: RuntimeIdentity = identity,
): ReceiptRuntime {
	return {
		head: observed.head,
		...(observed.base === undefined ? {} : { base: observed.base }),
		omp: now.omp,
		kencrew: now.kencrew,
		...(observed.overlay === undefined ? {} : { overlay: observed.overlay }),
		os: now.os,
		arch: now.arch,
		...(observed.argv === undefined ? {} : { argv: observed.argv }),
	};
}

/** `major.minor` of an omp version text (`omp 18.18.7`); `undefined` when it has none (`unknown`). */
export function ompMinor(version: string): string | undefined {
	const match = /(\d+)\.(\d+)/.exec(version);
	return match === null ? undefined : `${match[1]}.${match[2]}`;
}

/** What the current policy and source say about one receipt (`receiptStale`'s context; `undefined` = cannot tell). */
export interface StaleContext {
	/** The model the policy asks for now. */
	model: string | undefined;
	/** `overlayHash` of the overlay a run would get now. */
	overlay: string | undefined;
	/** Whether the gate paths differ between the receipt's kencrew commit and the current one (`gatePathsChanged`). */
	gateSourceChanged: boolean | undefined;
}

/**
 * Why a receipt made on another runtime no longer counts (`undefined`: it does). Pure — no git, files or processes. A
 * receipt without `runtime` (an earlier one) is always current. Stale: the model or overlay content differs, the omp
 * `major.minor` differs, a QA's OS or arch differs, the gate source changed. Patch versions, source changes outside the
 * gate paths and anything `unknown` are recorded only.
 */
export function receiptStale(
	kind: "review" | "qa",
	receipt: LaneReview | LaneQa,
	now: RuntimeIdentity,
	ctx: StaleContext,
): string | undefined {
	const recorded = receipt.runtime;
	if (recorded === undefined) return undefined;
	if (recorded.head !== receipt.sha) return "검사한 커밋이 영수증 커밋과 다름";
	if (ctx.model !== undefined && receipt.model !== ctx.model) return `모델 ${receipt.model} → ${ctx.model}`;
	if (ctx.overlay !== undefined && recorded.overlay !== undefined && recorded.overlay !== ctx.overlay) {
		return "오버레이 내용이 바뀜";
	}
	const before = ompMinor(recorded.omp);
	const after = ompMinor(now.omp);
	if (before !== undefined && after !== undefined && before !== after) return `omp ${before} → ${after}`;
	if (kind === "qa" && (recorded.os !== now.os || recorded.arch !== now.arch)) {
		return `OS/arch ${recorded.os}/${recorded.arch} → ${now.os}/${now.arch}`;
	}
	if (ctx.gateSourceChanged === true) return "게이트 소스가 바뀜";
	return undefined;
}

/**
 * Whether the gate paths differ between kencrew commits `recorded` and `current`: `git diff --name-only` in the source
 * checkout, once per pair (later calls read the cache). `undefined` when either is `unknown` or `+dirty`, there is no
 * checkout or git fails — warned once per pair (`receipt_runtime_unknown`); such a receipt stays valid.
 */
export async function gatePathsChanged(recorded: string, current: string): Promise<boolean | undefined> {
	if (recorded === current) return false;
	const key = `${recorded}\0${current}`;
	if (gateChanges.has(key)) return gateChanges.get(key);
	let changed: boolean | undefined;
	const exact = (sha: string): boolean => sha !== UNKNOWN && !sha.endsWith(DIRTY);
	if (source !== undefined && exact(recorded) && exact(current)) {
		const diff = await source.git(["-C", source.dir, "diff", "--name-only", recorded, current, "--", ...GATE_PATHS]);
		if (diff.code === 0) changed = diff.stdout.trim() !== "";
	}
	gateChanges.set(key, changed);
	if (changed === undefined) source?.log?.warn("receipt_runtime_unknown", { recorded, current });
	return changed;
}

/** `gatePathsChanged` result of a cached pair, for the sync gates: `undefined` before `primeGateChanges` ran for it. */
export function gateChangedOf(recorded: string | undefined): boolean | undefined {
	if (recorded === undefined || recorded === identity.kencrew) return false;
	return gateChanges.get(`${recorded}\0${identity.kencrew}`);
}

/** Computes (and caches) the gate-path change of the receipts' kencrew commits against the current one. */
export async function primeGateChanges(receipts: {
	review?: LaneReview | undefined;
	qa?: LaneQa | undefined;
}): Promise<void> {
	for (const receipt of [receipts.review, receipts.qa]) {
		if (receipt?.runtime !== undefined) await gatePathsChanged(receipt.runtime.kencrew, identity.kencrew);
	}
}

/** A short key of what makes a gate run comparable to an earlier one on the same commit (notice keys of the task gate). */
export function runtimeKey(input: { model: string | undefined; overlay: string | undefined }): string {
	const omp = ompMinor(identity.omp) ?? UNKNOWN;
	const kencrew = identity.kencrew.slice(0, 12);
	return overlayHash(omp, input.overlay ?? "", input.model ?? "", kencrew).slice(0, 8);
}
