import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { buildChildEnv } from "../omp/env";
import { oneLine } from "../tasks/docs";
import type { LaneExternalPr } from "./status";

/**
 * Publishing a closed lane's work as a GitHub pull request (doc/plans/lane-external-pr.md 설계 3): the push to the
 * gh login's fork (never `--force`, never the upstream itself) and `gh pr create`, or the open PR of that fork's
 * branch when there is one. Every call takes the caller's abort signal: a stopping core kills git and gh.
 */

export interface ProcResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs one program (`argv` without the program name) in `cwd`; rejects when it cannot run, timed out or was aborted. */
export type ProcRunner = (argv: string[], options: { cwd: string; signal: AbortSignal }) => Promise<ProcResult>;

/** git and gh as the publish runs them (test seam: a local bare remote and a fake gh). */
export interface PrTools {
	git: ProcRunner;
	gh: ProcRunner;
}

/** A push or a PR call may wait on the network far longer than a local query. */
const PR_TIMEOUT_MS = 120_000;
const REASON_MAX = 300;
const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** Branch names the publish may create or base on: never an option, never `..`. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TITLE_MAX = 200;
export const DEFAULT_PR_BODY_FILE = "pr-body.md";

/** `git`/`gh` with the bot's secrets kept out of the environment, killed on abort or after `PR_TIMEOUT_MS`. */
function spawnRunner(program: string): ProcRunner {
	return async (argv, { cwd, signal }) => {
		if (signal.aborted) throw new Error(`${program} aborted`);
		const proc = Bun.spawn([program, ...argv], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: buildChildEnv({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", LC_ALL: "C" }),
		});
		let cause: string | undefined;
		const kill = (why: string) => {
			cause = why;
			proc.kill("SIGKILL");
		};
		const onAbort = () => kill("aborted");
		signal.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => kill(`timed out after ${PR_TIMEOUT_MS}ms`), PR_TIMEOUT_MS);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (cause !== undefined) throw new Error(`${program} ${cause}`);
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	};
}

export const defaultPrTools: PrTools = { git: spawnRunner("git"), gh: spawnRunner("gh") };

/** The line of a failed call worth showing: the one that says rejected/error/fatal, else the first. */
function failureLine(result: ProcResult): string {
	const lines = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const telling = lines.find((line) => /rejected|error|fatal|denied|failed/i.test(line));
	return (telling ?? lines[0] ?? `exit ${result.code}`).slice(0, 200);
}

/** A GitHub `owner/name`. */
export const isGithubRepo = (value: string): boolean => GITHUB_REPO.test(value);

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `owner/name` of a GitHub remote URL (https, scp-like ssh or ssh://); `undefined` for anything else. */
export function githubRepoOfUrl(url: string): string | undefined {
	const match =
		/^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
			url.trim(),
		);
	const repo = match?.[1];
	return repo !== undefined && GITHUB_REPO.test(repo) ? repo : undefined;
}

/** `ompbot_work_start` `externalPr` (and `!pr`) as given: every field optional, each checked for shape. */
export interface ExternalPrInput {
	repo?: string;
	base?: string;
	bodyFile?: string;
	title?: string;
	pushRemote?: string;
	branch?: string;
}

const INPUT_KEYS = ["repo", "base", "bodyFile", "title", "pushRemote", "branch"] as const;

/** A repository-relative path that stays inside the repository; `undefined` when it would not. */
function relativeInside(path: string): string | undefined {
	if (path.trim() === "" || isAbsolute(path)) return undefined;
	const normalized = normalize(path);
	return normalized === ".." || normalized.startsWith("../") || normalized === "." ? undefined : normalized;
}

export function parseExternalPrInput(
	value: unknown,
): { ok: true; value: ExternalPrInput | undefined } | { ok: false; problem: string } {
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, problem: "externalPr는 객체여야 합니다." };
	}
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => !(INPUT_KEYS as readonly string[]).includes(key));
	if (unknown.length > 0) return { ok: false, problem: `externalPr에 모르는 키가 있습니다: ${unknown.join(", ")}` };
	const out: ExternalPrInput = {};
	for (const key of INPUT_KEYS) {
		const field = record[key];
		if (field === undefined) continue;
		if (typeof field !== "string" || field.trim() === "") {
			return { ok: false, problem: `externalPr.${key}는 비어 있지 않은 문자열이어야 합니다.` };
		}
		out[key] = field.trim();
	}
	if (out.repo !== undefined && !GITHUB_REPO.test(out.repo)) {
		return { ok: false, problem: `externalPr.repo는 GitHub owner/name이어야 합니다: ${out.repo}` };
	}
	for (const key of ["base", "branch"] as const) {
		const ref = out[key];
		if (ref !== undefined && (!BRANCH.test(ref) || ref.includes("..") || ref.endsWith(".lock"))) {
			return { ok: false, problem: `externalPr.${key}가 브랜치 이름이 아닙니다: ${ref}` };
		}
	}
	if (out.pushRemote !== undefined && !REMOTE.test(out.pushRemote)) {
		return { ok: false, problem: `externalPr.pushRemote가 git 원격 이름이 아닙니다: ${out.pushRemote}` };
	}
	if (out.bodyFile !== undefined) {
		const inside = relativeInside(out.bodyFile);
		if (inside === undefined) {
			return { ok: false, problem: `externalPr.bodyFile은 저장소 안 상대경로여야 합니다: ${out.bodyFile}` };
		}
		out.bodyFile = inside;
	}
	if (out.title !== undefined) out.title = oneLine(out.title).slice(0, TITLE_MAX);
	return { ok: true, value: out };
}

/**
 * The lane's `externalPr` with defaults filled in: `repo` from the repository's `origin` URL when not given (refused
 * when that is not GitHub), `base` the lane's base branch, `bodyFile` `pr-body.md`, the lane's title, `pr/<laneId>`.
 */
export async function resolveExternalPr(
	input: ExternalPrInput & { prNumber?: number },
	lane: { repoDir: string; baseBranch: string; title: string; laneId: string },
	git: ProcRunner,
	signal: AbortSignal = new AbortController().signal,
): Promise<{ ok: true; value: LaneExternalPr } | { ok: false; problem: string }> {
	let repo = input.repo;
	if (repo === undefined) {
		const origin = await git(["remote", "get-url", "origin"], { cwd: lane.repoDir, signal });
		repo = origin.code === 0 ? githubRepoOfUrl(origin.stdout) : undefined;
		if (repo === undefined) {
			return {
				ok: false,
				problem:
					"origin 원격이 GitHub 저장소가 아니라 PR을 받을 저장소를 알 수 없습니다 — repo(owner/name)를 주세요(레인 스레드면 `!pr owner/name`).",
			};
		}
	}
	return {
		ok: true,
		value: {
			repo,
			base: input.base ?? lane.baseBranch,
			bodyFile: input.bodyFile ?? DEFAULT_PR_BODY_FILE,
			title: input.title ?? lane.title.slice(0, TITLE_MAX),
			...(input.pushRemote === undefined ? {} : { pushRemote: input.pushRemote }),
			branch: input.branch ?? `pr/${lane.laneId}`,
			...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
		},
	};
}

/** The first non-empty line of the PR body file in `worktree`; `undefined` when the file is missing or blank. */
export function bodyFirstLine(worktree: string, bodyFile: string): string | undefined {
	try {
		const text = readFileSync(join(worktree, bodyFile), "utf8");
		const line = text.split("\n").find((entry) => entry.trim() !== "");
		return line === undefined ? undefined : line.trim();
	} catch {
		return undefined;
	}
}

/** Where the PR branch is pushed: the gh login's fork (an existing remote, the named one, or a fork to create). */
export interface PushTarget {
	login: string;
	/** A remote name, or the fork's URL when no remote points at it. */
	remote: string;
	url: string;
	/** No remote points at the fork: `gh repo fork` makes it (after the approval) before the push. */
	fork: boolean;
}

type Failed = { ok: false; reason: string };
const failed = (reason: string): Failed => ({ ok: false, reason: reason.slice(0, REASON_MAX) });

/** Decided before the approval card (it names the push URL); refuses a remote that is the upstream `repo` itself. */
export async function resolvePushTarget(
	tools: PrTools,
	input: { repoDir: string; externalPr: LaneExternalPr; signal: AbortSignal },
): Promise<{ ok: true; value: PushTarget } | Failed> {
	const { repoDir, externalPr, signal } = input;
	const run = { cwd: repoDir, signal };
	const user = await tools.gh(["api", "user", "-q", ".login"], run);
	const login = user.stdout.trim();
	if (user.code !== 0 || !GITHUB_LOGIN.test(login)) return failed(`gh 로그인 확인 실패: ${failureLine(user)}`);
	const name = externalPr.repo.split("/")[1] ?? "";
	const urlOf = async (remote: string): Promise<string | undefined> => {
		const result = await tools.git(["remote", "get-url", remote], run);
		return result.code === 0 ? result.stdout.trim() : undefined;
	};
	let target: PushTarget | undefined;
	if (externalPr.pushRemote !== undefined) {
		const url = await urlOf(externalPr.pushRemote);
		if (url === undefined) return failed(`push 원격 ${externalPr.pushRemote}이 저장소에 없습니다.`);
		target = { login, remote: externalPr.pushRemote, url, fork: false };
	} else {
		const remotes = await tools.git(["remote"], run);
		if (remotes.code !== 0) return failed(`git remote 실패: ${failureLine(remotes)}`);
		for (const remote of remotes.stdout.split("\n").map((line) => line.trim())) {
			if (remote === "") continue;
			const url = await urlOf(remote);
			const repo = url === undefined ? undefined : githubRepoOfUrl(url);
			if (url !== undefined && repo !== undefined && sameRepo(repo, `${login}/${name}`)) {
				target = { login, remote, url, fork: false };
				break;
			}
		}
		const forkUrl = `https://github.com/${login}/${name}.git`;
		target ??= { login, remote: forkUrl, url: forkUrl, fork: true };
	}
	const pointsAt = githubRepoOfUrl(target.url);
	if (pointsAt !== undefined && sameRepo(pointsAt, externalPr.repo)) {
		return failed(`upstream에 직접 push하지 않음 (${target.remote} → ${externalPr.repo})`);
	}
	return { ok: true, value: target };
}

/** An open PR of the repository as `gh` lists it. */
export interface OpenPr {
	number: number;
	url: string;
	headRefName: string;
	headRefOid: string;
	owner: string;
	base: string;
}

/**
 * What the publish does (decided before the approval card, which names it): a new PR, or the update of an open PR of
 * the login's own fork — `push` false when the lane commit is in its head already (nothing goes out).
 */
export type PrPlan = { kind: "new" } | { kind: "update"; pr: OpenPr; push: boolean };

const PR_FIELDS = "number,url,state,headRefName,headRefOid,headRepositoryOwner,baseRefName";

function openPrOf(entry: unknown): OpenPr | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as Record<string, unknown>;
	const owner = (record.headRepositoryOwner as { login?: unknown } | undefined)?.login;
	const { number, url, headRefName, headRefOid, baseRefName } = record;
	if (
		typeof number !== "number" ||
		typeof url !== "string" ||
		typeof headRefName !== "string" ||
		typeof headRefOid !== "string" ||
		typeof owner !== "string" ||
		typeof baseRefName !== "string" ||
		!BRANCH.test(headRefName)
	) {
		return undefined;
	}
	return { number, url, headRefName, headRefOid, owner, base: baseRefName };
}

/** `gh` JSON output, or why it could not be read. */
async function ghJson(tools: PrTools, argv: string[], run: { cwd: string; signal: AbortSignal }) {
	const result = await tools.gh(argv, run);
	if (result.code !== 0) return failed(`gh ${argv.slice(0, 2).join(" ")} 실패: ${failureLine(result)}`);
	try {
		return { ok: true as const, value: JSON.parse(result.stdout) as unknown };
	} catch {
		return failed(`gh ${argv.slice(0, 2).join(" ")} 출력을 읽지 못했습니다: ${result.stdout.slice(0, 120)}`);
	}
}

/**
 * How the lane commit `sha` stands to an open PR's head, read after fetching that head from the push remote:
 * `contains` (the head has it already), `behind` (a fast-forward reaches it), `diverged`, or `unknown` (the head
 * could not be fetched).
 */
async function relationTo(
	tools: PrTools,
	input: { worktree: string; remote: string; pr: OpenPr; sha: string; signal: AbortSignal },
): Promise<"contains" | "behind" | "diverged" | "unknown"> {
	const run = { cwd: input.worktree, signal: input.signal };
	await tools.git(
		["fetch", "--no-tags", "--no-write-fetch-head", input.remote, `refs/heads/${input.pr.headRefName}`],
		run,
	);
	const oid = input.pr.headRefOid;
	if (!/^[0-9a-f]{40}$/.test(oid)) return "unknown";
	if ((await tools.git(["cat-file", "-e", `${oid}^{commit}`], run)).code !== 0) return "unknown";
	if ((await tools.git(["merge-base", "--is-ancestor", input.sha, oid], run)).code === 0) return "contains";
	if ((await tools.git(["merge-base", "--is-ancestor", oid, input.sha], run)).code === 0) return "behind";
	return "diverged";
}

/**
 * Which PR the publish continues (설계 3-7): ① `externalPr.prNumber` (open, the login's own), ② the login's open PRs
 * on `base` whose head is related to the lane commit either way (two or more: none is picked, the owner names one),
 * ③ the login's open PR of `branch`. A picked PR the lane commit diverged from is refused (no force push).
 */
export async function planPr(
	tools: PrTools,
	input: {
		repoDir: string;
		worktree: string;
		externalPr: LaneExternalPr;
		target: PushTarget;
		sha: string;
		signal: AbortSignal;
	},
): Promise<{ ok: true; value: PrPlan } | Failed> {
	const { externalPr: pr, target, signal } = input;
	const run = { cwd: input.repoDir, signal };
	const relation = (open: OpenPr) =>
		relationTo(tools, { worktree: input.worktree, remote: target.remote, pr: open, sha: input.sha, signal });
	const own = (open: OpenPr | undefined): open is OpenPr => open !== undefined && sameRepo(open.owner, target.login);
	let picked: OpenPr | undefined;
	let known: Awaited<ReturnType<typeof relation>> | undefined;
	if (pr.prNumber !== undefined) {
		const view = await ghJson(tools, ["pr", "view", String(pr.prNumber), "--repo", pr.repo, "--json", PR_FIELDS], run);
		if (!view.ok) return view;
		const open = openPrOf(view.value);
		const state = (view.value as { state?: unknown } | null)?.state;
		if (!own(open) || state !== "OPEN") {
			return failed(`PR #${pr.prNumber}은 열려 있는 ${target.login} 소유 포크의 PR이 아닙니다.`);
		}
		picked = open;
	} else {
		const mine = await ghJson(
			tools,
			["pr", "list", "--repo", pr.repo, "--author", target.login, "--state", "open", "--json", PR_FIELDS],
			run,
		);
		if (!mine.ok) return mine;
		const candidates: OpenPr[] = [];
		for (const open of Array.isArray(mine.value) ? mine.value.map(openPrOf) : []) {
			if (!own(open) || open.base !== pr.base) continue;
			const related = await relation(open);
			if (related === "contains" || related === "behind") {
				candidates.push(open);
				known = related;
			}
		}
		if (candidates.length > 1) {
			return failed(
				`이어받을 PR 후보 ${candidates.length}개(${candidates.map((open) => `#${open.number}`).join(", ")}) — !pr <번호>로 지정`,
			);
		}
		picked = candidates[0];
		if (picked === undefined) {
			known = undefined;
			// `--head` filters by branch name only: a PR from somebody else's fork with the same branch name is not ours.
			const byBranch = await ghJson(
				tools,
				["pr", "list", "--repo", pr.repo, "--head", pr.branch, "--state", "open", "--json", PR_FIELDS],
				run,
			);
			if (!byBranch.ok) return byBranch;
			picked = (Array.isArray(byBranch.value) ? byBranch.value.map(openPrOf) : []).find(own);
		}
	}
	if (picked === undefined) return { ok: true, value: { kind: "new" } };
	const related = known ?? (await relation(picked));
	if (related === "diverged") return failed(`PR #${picked.number} head와 갈라짐 — 강제 푸시 안 함`);
	// `unknown`: the push itself is fast-forward only, so a head it cannot reach refuses it.
	return { ok: true, value: { kind: "update", pr: picked, push: related !== "contains" } };
}

/**
 * Carries out an approved plan: fork if needed, push `sha` to the PR branch (no force: a refusal is the result),
 * then `gh pr create` for a new PR. An update records the open PR's URL and branch.
 */
export async function publishPr(
	tools: PrTools,
	input: {
		repoDir: string;
		worktree: string;
		externalPr: LaneExternalPr;
		target: PushTarget;
		plan: PrPlan;
		sha: string;
		signal: AbortSignal;
	},
): Promise<{ ok: true; url: string; branch: string; pushed: boolean } | Failed> {
	const { externalPr: pr, target, plan, signal } = input;
	const run = { cwd: input.repoDir, signal };
	const branch = plan.kind === "update" ? plan.pr.headRefName : pr.branch;
	if (plan.kind === "update" && !plan.push) return { ok: true, url: plan.pr.url, branch, pushed: false };
	if (target.fork && plan.kind === "new") {
		const fork = await tools.gh(["repo", "fork", pr.repo, "--clone=false", "--remote=false"], run);
		if (fork.code !== 0) return failed(`포크를 만들지 못했습니다: ${failureLine(fork)}`);
	}
	const push = await tools.git(["push", target.remote, `${input.sha}:refs/heads/${branch}`], {
		cwd: input.worktree,
		signal,
	});
	if (push.code !== 0) return failed(`push 거절: ${failureLine(push)}`);
	if (plan.kind === "update") return { ok: true, url: plan.pr.url, branch, pushed: true };
	const create = await tools.gh(
		[
			"pr",
			"create",
			"--repo",
			pr.repo,
			"--base",
			pr.base,
			"--head",
			`${target.login}:${branch}`,
			"--title",
			pr.title,
			"--body-file",
			join(input.worktree, pr.bodyFile),
		],
		run,
	);
	const url = create.stdout
		.split("\n")
		.map((line) => line.trim())
		.findLast((line) => /^https:\/\/\S+$/.test(line));
	if (create.code !== 0 || url === undefined) return failed(`gh pr create 실패: ${failureLine(create)}`);
	return { ok: true, url, branch, pushed: true };
}
