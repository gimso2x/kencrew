import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type GitRunner, gitRunner } from "../lanes/verify";
import { redact } from "../redact";
import { taskTip } from "../tasks/gate";

/**
 * `api/diff?lane=<name>` / `api/diff?task=<id>`: the change an owner is about to merge, read-only, per request, never
 * cached. The range is the one the independent review and the auto-land gate judge: the lane's `merge-base(base, sha)..sha`
 * (not `meta.baseSha`, which `!reopen` moves), the task's `merge-base(base, tip)..tip` without its own `docs/tasks`.
 */

export const DIFF_TOTAL_MAX = 400 * 1024;
export const DIFF_FILE_MAX = 60 * 1024;
const GIT_TIMEOUT_MS = 10_000;

export interface DiffFile {
	/** Repository-relative. */
	path: string;
	added: number;
	deleted: number;
	binary: boolean;
	/** Masked unified hunks (`@@ … @@` and the lines after); empty for a binary file. */
	hunks: string;
}

export type DiffSubject = { lane: string } | { task: string };

type Miss = {
	ok: false;
	error: "no_database" | "unknown_lane" | "unknown_task" | "no_claim" | "gone" | "remote_unsupported";
};
export type DiffAnswer =
	| { ok: true; subject: string; base: string; sha: string; files: DiffFile[]; truncated: boolean }
	| Miss;

interface Range {
	repo: string;
	/** Full ref of the branch the change lands on. */
	baseRef: string;
	sha: string;
	label: string;
	/** A task's own status documents are not part of the change. */
	exclude: boolean;
}

/** Cuts at a line start under `max` characters. */
function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	const at = text.lastIndexOf("\n", max);
	return text.slice(0, at > 0 ? at : max);
}

/** The path of a `diff --git a/P b/P` header remainder (renames are off, so both sides name the same path). */
function headerPath(rest: string): string {
	if (rest.startsWith('"')) {
		try {
			return (JSON.parse(rest.slice(0, rest.indexOf('"', 1) + 1)) as string).replace(/^a\//, "");
		} catch {
			return rest.slice(3);
		}
	}
	return rest.slice(2, (rest.length - 5) / 2 + 2);
}

/** Splits `git diff` output into files; counts come from the whole text, the hunks are masked and capped. */
export function parseDiff(text: string): { files: DiffFile[]; truncated: boolean } {
	const files: DiffFile[] = [];
	let truncated = false;
	let budget = DIFF_TOTAL_MAX;
	for (const chunk of text.split(/^diff --git /m).slice(1)) {
		const lines = chunk.split("\n");
		const first = lines.shift() ?? "";
		const binary = lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch");
		const at = lines.findIndex((line) => line.startsWith("@@"));
		const body = binary || at < 0 ? [] : lines.slice(at);
		let added = 0;
		let deleted = 0;
		for (const line of body) {
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) deleted++;
		}
		let hunks = redact(body.join("\n").trimEnd());
		const room = Math.min(DIFF_FILE_MAX, Math.max(budget, 0));
		if (hunks.length > room) {
			hunks = cut(hunks, room);
			truncated = true;
		}
		budget -= hunks.length;
		files.push({ path: headerPath(first), added, deleted, binary, hunks });
	}
	return { files, truncated };
}

function resolveLane(db: Database, name: string): Range | Miss {
	const row = db.query<{ meta: string }, [string]>("SELECT meta FROM lanes WHERE name = ?").get(name);
	if (row === null) return { ok: false, error: "unknown_lane" };
	const meta = JSON.parse(row.meta) as { repo?: string; baseBranch?: string; sha?: string };
	if (meta.sha === undefined || meta.repo === undefined || meta.baseBranch === undefined) {
		return { ok: false, error: "no_claim" };
	}
	return {
		repo: meta.repo,
		baseRef: `refs/heads/${meta.baseBranch}`,
		sha: meta.sha,
		label: `lane:${name}`,
		exclude: false,
	};
}

async function resolveTask(db: Database, id: string, git: GitRunner): Promise<Range | Miss> {
	const row = db
		.query<{ host: string | null; repo: string; branch: string }, [string]>(
			"SELECT host, repo, branch FROM tasks WHERE task_id = ?",
		)
		.get(id);
	if (row === null) return { ok: false, error: "unknown_task" };
	if (row.host !== null) return { ok: false, error: "remote_unsupported" };
	const tip = await taskTip(git, row);
	if (tip === undefined) return { ok: false, error: "gone" };
	return { repo: row.repo, baseRef: `refs/heads/${tip.baseBranch}`, sha: tip.sha, label: `task:${id}`, exclude: true };
}

/** Throws when git fails (the server answers 500 `diff_failed`). */
export async function readDiff(
	homeDir: string,
	subject: DiffSubject,
	git: GitRunner = gitRunner(GIT_TIMEOUT_MS),
): Promise<DiffAnswer> {
	const dbPath = join(homeDir, "ompbot.db");
	if (!existsSync(dbPath)) return { ok: false, error: "no_database" };
	const db = new Database(dbPath, { readonly: true, strict: true });
	let range: Range | Miss;
	try {
		range = "lane" in subject ? resolveLane(db, subject.lane) : await resolveTask(db, subject.task, git);
	} finally {
		db.close();
	}
	if ("ok" in range) return range;
	const merge = await git(["-C", range.repo, "merge-base", range.baseRef, range.sha]);
	const base = merge.stdout.trim();
	if (merge.code !== 0 || base === "") throw new Error("merge-base failed");
	const full = await git([
		"-C",
		range.repo,
		"-c",
		"core.quotepath=false",
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--no-renames",
		"--unified=3",
		`${base}..${range.sha}`,
		...(range.exclude ? ["--", ".", ":!docs/tasks"] : []),
	]);
	if (full.code !== 0) throw new Error("git diff failed");
	return { ok: true, subject: range.label, base, sha: range.sha, ...parseDiff(full.stdout) };
}
