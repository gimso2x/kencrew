import { createHash } from "node:crypto";
import { parseChatOrigin } from "../core/origin-key";
import { dispatchEnv, type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import type { LaneRow } from "../lanes/status";
import type { Logger } from "../log";
import { redact } from "../redact";
import type { Store, WikiTurnRow } from "../store/db";
import { type AcceptanceItem, parseOutcome, parseSpec } from "../tasks/docs";
import type { TaskRow } from "../tasks/ledger";
import { gitCommonDir, repoMatchesCommonDir } from "../tasks/repo-match";
import { localDay } from "../time";
import { type SweepSpawner, type WikiNote, type WikiNotesConfig, writeNote } from "./outbox";

/**
 * Work-unit result notes for the wiki (doc/plans/wiki-work-outcome-notes.md): one structured note when a [TASK] is
 * `done`, a worktree lane `landed`, or a conversation thread's day of commits is over. Collected before a landing
 * removes the worktree (a draft in `wiki_notes`), completed with the landing result, written to the wiki client's
 * outbox once (`wiki_notes` remembers it). A failing write is a `wiki_note_failed` warning and nothing else.
 */

const COMMITS_MAX = 20;
const GOAL_MAX = 800;
const CRITERION_MAX = 300;
const EVIDENCE_MAX = 200;
const TITLE_MAX = 60;
const CONCLUSION_MAX = 500;
const REQUEST_MAX = 300;
const GIT_TIMEOUT_MS = 20_000;
/** The startup pass only looks at tasks closed this recently (a note missed while the daemon was down). */
const BACKFILL_MS = 3 * 24 * 60 * 60 * 1000;
/** Sent notes and rows are forgotten after this long. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const UNASSIGNED = "unassigned";

type Result = "통과" | "실패" | "확인 불가";

interface DraftCommit {
	sha: string;
	subject: string;
}

/** What a task or lane note says, kept as JSON until the note is written; markdown only at the end (`renderNote`). */
export interface NoteDraft {
	kind: "task" | "lane";
	sourceId: string;
	project: string;
	title: string;
	goal: string;
	criteria: { id: string; text: string; result: Result; evidence: string[] }[];
	commits: DraftCommit[];
	/** Lines of the worker's or claim's own summary. */
	summary: string[];
	leftovers: string[];
	/** Where it came from: ids, thread, host. */
	source: string[];
	landing?: { lines: string[] };
}

export interface WikiNotesDeps {
	/** Read on every use: a config reload turns the notes on or off. */
	config: () => WikiNotesConfig | undefined;
	store: Pick<
		Store,
		| "wikiNoteState"
		| "saveWikiDraft"
		| "dropWikiDraft"
		| "markWikiNoteSent"
		| "addWikiTurn"
		| "listUnsentWikiTurns"
		| "markWikiTurnsSent"
		| "pruneWikiNotes"
		| "turnTexts"
		| "getLaneByOrigin"
	> & { tasks: Pick<Store["tasks"], "get" | "listDoneSince" | "hasOrigin"> };
	log: Logger;
	clock: { now(): number };
	timezone: string;
	/** Reads `docs/tasks/<id>/<name>` of a task on its own host; `undefined` = no such file or the host cannot say. */
	readTaskDoc: (row: TaskRow, name: "spec.md" | "outcome.md") => Promise<string | undefined>;
	/** Test seams: the process runner for git, the sweep starter. */
	run?: ProcessRunner;
	spawnSweep?: SweepSpawner;
}

const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const hashOf = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 10);

export class WikiNotes {
	readonly #deps: WikiNotesDeps;
	#flushing = false;

	constructor(deps: WikiNotesDeps) {
		this.#deps = deps;
	}

	get #run(): ProcessRunner {
		return this.#deps.run ?? realProcessRunner;
	}

	// ---- git helpers ----

	async #git(dir: string, args: string[]): Promise<string | undefined> {
		const result = await this.#run(["git", "-C", dir, ...args], {
			timeoutMs: GIT_TIMEOUT_MS,
			env: dispatchEnv(process.env),
		});
		return result.code === 0 ? result.stdout : undefined;
	}

	async #commitsOf(dir: string, range: string): Promise<DraftCommit[]> {
		const out = await this.#git(dir, ["log", "--reverse", "--format=%H%x09%s", range]);
		return (out ?? "")
			.split("\n")
			.filter((line) => line.includes("\t"))
			.map((line) => {
				const [sha, ...subject] = line.split("\t");
				return { sha: (sha as string).slice(0, 12), subject: oneLine(subject.join("\t"), 120) };
			});
	}

	/** The wiki project of a repository: the directory name of its git common dir's parent (the client's `project_for`). */
	async #projectOf(repo: string): Promise<string> {
		const common = await gitCommonDir(repo, this.#run);
		if (common === undefined) return UNASSIGNED;
		const parts = common.replace(/\/+$/, "").split("/");
		return parts.length >= 2 ? (parts[parts.length - 2] as string) : UNASSIGNED;
	}

	/** Whether `wikiNotes.repos` lets this repository's work through (no list = all). */
	async #wanted(config: WikiNotesConfig, repo: string): Promise<boolean> {
		return config.repos === undefined || config.repos.length === 0
			? true
			: await repoMatchesCommonDir(repo, config.repos, this.#run);
	}

	// ---- writing ----

	/** Writes the note and records it as sent; a failure is the warning only. Returns whether the file was written. */
	#write(config: WikiNotesConfig, note: WikiNote): boolean {
		const { store, log } = this.#deps;
		try {
			const { sweepError } = writeNote(config, note, this.#deps.spawnSweep);
			store.markWikiNoteSent(note.sourceId);
			if (sweepError !== undefined) {
				log.warn("wiki_note_failed", { source: note.sourceId, stage: "sweep", error: sweepError });
			}
			return true;
		} catch (error) {
			log.warn("wiki_note_failed", { source: note.sourceId, stage: "outbox", error: String(error).slice(0, 200) });
			return false;
		}
	}

	#fail(source: string, error: unknown): void {
		this.#deps.log.warn("wiki_note_failed", { source, stage: "collect", error: String(error).slice(0, 200) });
	}

	// ---- lanes ----

	/** Called when a landing begins, before it removes the worktree: keeps the lane's note content. */
	async laneDraft(lane: LaneRow): Promise<void> {
		const config = this.#deps.config();
		const sourceId = laneSourceId(lane);
		if (config === undefined || sourceId === undefined) return;
		try {
			if (this.#deps.store.wikiNoteState(sourceId)?.state === "sent") return;
			const draft = await this.#laneDraftOf(config, lane, sourceId);
			if (draft !== undefined) this.#deps.store.saveWikiDraft(sourceId, JSON.stringify(draft));
		} catch (error) {
			this.#fail(sourceId, error);
		}
	}

	/** The landing ended without a landed lane (blocked, sent back to work): the draft is not needed. */
	laneDropDraft(lane: LaneRow): void {
		const sourceId = laneSourceId(lane);
		if (sourceId !== undefined) this.#deps.store.dropWikiDraft(sourceId);
	}

	/** The lane is `landed` (`lane.meta.land` says how): completes its draft (or collects one) and writes the note. */
	async laneLanded(lane: LaneRow): Promise<void> {
		const config = this.#deps.config();
		const sourceId = laneSourceId(lane);
		const land = lane.meta.land;
		if (config === undefined || sourceId === undefined || land?.state !== "landed") return;
		try {
			const known = this.#deps.store.wikiNoteState(sourceId);
			if (known?.state === "sent") return;
			const draft =
				known?.state === "draft" && known.draft !== ""
					? (JSON.parse(known.draft) as NoteDraft)
					: await this.#laneDraftOf(config, lane, sourceId);
			if (draft === undefined) return;
			const { baseBranch, sha } = lane.meta;
			draft.landing = {
				lines: [
					`${baseBranch ?? "기준 브랜치"}에 머지${sha === undefined ? "" : ` (${sha.slice(0, 12)})`}`,
					land.pushed === undefined ? "push 없음(origin 원격 없음)" : `push ${land.pushed}`,
					...(land.preSha === undefined || land.preSha === "unknown" ? [] : [`머지 전 ${land.preSha.slice(0, 12)}`]),
				],
			};
			this.#write(config, renderNote(draft));
		} catch (error) {
			this.#fail(sourceId, error);
		}
	}

	async #laneDraftOf(config: WikiNotesConfig, lane: LaneRow, sourceId: string): Promise<NoteDraft | undefined> {
		const { repo, baseSha, sha, acceptance, checks, claim, brief, leftovers, laneId } = lane.meta;
		const root = repo ?? lane.cwd;
		if (!(await this.#wanted(config, root))) return undefined;
		const results = checks?.results ?? [];
		const criteria = (acceptance ?? []).map((item) => {
			const own = results.filter((check) => check.id === item.id);
			const result: Result =
				own.length === 0
					? "확인 불가"
					: own.some((check) => !check.ok && check.inconclusive !== true)
						? "실패"
						: own.every((check) => check.ok)
							? "통과"
							: "확인 불가";
			const evidence =
				own.length === 0
					? ["자동 검사 없음"]
					: own.map(
							(check) => `${check.ok ? "ok" : "fail"}: ${oneLine(check.signal, 100)} — ${oneLine(check.detail, 100)}`,
						);
			return { id: item.id, text: oneLine(item.text, CRITERION_MAX), result, evidence };
		});
		const commits = baseSha === undefined || sha === undefined ? [] : await this.#commitsOf(root, `${baseSha}..${sha}`);
		return {
			kind: "lane",
			sourceId,
			project: await this.#projectOf(root),
			title: `작업 결과: ${oneLine(lane.title, 100)}`,
			goal: oneLine(brief ?? lane.title, GOAL_MAX),
			criteria,
			commits,
			summary: claim === undefined ? [] : [oneLine(claim.summary, 500)],
			leftovers: (leftovers ?? []).map((item) => `${item.blocking ? "[막힘] " : ""}${item.text}`),
			source: [`레인 ${laneId ?? lane.name}`, `스레드 ${lane.threadRef}`, "호스트 로컬"],
		};
	}

	// ---- tasks ----

	/** Called right before the core lands a local [TASK]: keeps the content its worktree is about to lose. */
	async taskDraft(row: TaskRow): Promise<void> {
		const config = this.#deps.config();
		if (config === undefined) return;
		const sourceId = taskSourceId(row);
		try {
			if (this.#deps.store.wikiNoteState(sourceId)?.state === "sent") return;
			const draft = await this.#taskDraftOf(config, row);
			if (draft !== undefined) this.#deps.store.saveWikiDraft(sourceId, JSON.stringify(draft));
		} catch (error) {
			this.#fail(sourceId, error);
		}
	}

	/** The landing did not end `done`: its draft is not needed. */
	taskDropDraft(row: TaskRow): void {
		this.#deps.store.dropWikiDraft(taskSourceId(row));
	}

	/**
	 * The task is `done` in the ledger (a core landing, or `tasks close --as done` and `tasks_sync`): completes its draft
	 * (or collects one from the docs and branch that are still there) and writes the note, once. `landing`: what the
	 * core's landing did.
	 */
	async taskDone(taskId: string, landing?: string[]): Promise<void> {
		const config = this.#deps.config();
		if (config === undefined) return;
		const sourceId = `ompbot-task-${taskId}`;
		try {
			const row = this.#deps.store.tasks.get(taskId);
			if (row?.status !== "done") return;
			const known = this.#deps.store.wikiNoteState(sourceId);
			if (known?.state === "sent") return;
			const draft =
				known?.state === "draft" && known.draft !== ""
					? (JSON.parse(known.draft) as NoteDraft)
					: await this.#taskDraftOf(config, row);
			if (draft === undefined) return;
			draft.landing = {
				lines: landing ?? ["코어 착지가 아니라 `ompbot tasks close --as done`으로 닫힘"],
			};
			this.#write(config, renderNote(draft));
		} catch (error) {
			this.#fail(sourceId, error);
		}
	}

	/** Startup pass: `done` tasks of the last three days that never got their note (closed while the daemon was down). */
	async backfillTasks(): Promise<void> {
		if (this.#deps.config() === undefined) return;
		for (const row of this.#deps.store.tasks.listDoneSince(this.#deps.clock.now() - BACKFILL_MS)) {
			await this.taskDone(row.taskId);
		}
	}

	async #taskDraftOf(config: WikiNotesConfig, row: TaskRow): Promise<NoteDraft | undefined> {
		if (!(await this.#wanted(config, row.repo))) return undefined;
		const [specText, outcomeText] = await Promise.all([
			this.#deps.readTaskDoc(row, "spec.md"),
			this.#deps.readTaskDoc(row, "outcome.md"),
		]);
		const spec = specText === undefined ? undefined : parseSpec(specText);
		const outcome = outcomeText === undefined ? undefined : parseOutcome(outcomeText);
		const checked = new Map((spec?.acceptance ?? []).map((item) => [item.id, item.checked]));
		const registered: AcceptanceItem[] = row.acceptance;
		const criteria = registered.map((item) => {
			const evidence = outcome?.sections.get(item.id);
			const lines = [...(evidence?.tests ?? []), ...(evidence?.files ?? []).map((file) => `산출물 ${file}`)];
			const result: Result = checked.get(item.id) === true ? "통과" : "확인 불가";
			return {
				id: item.id,
				text: oneLine(item.text, CRITERION_MAX),
				result,
				evidence: lines.map((l) => oneLine(l, EVIDENCE_MAX)),
			};
		});
		let commits: DraftCommit[] = [];
		if (row.host === null) {
			const docs = (
				await this.#git(row.repo, [
					"log",
					"-1",
					"--format=%H",
					"--fixed-strings",
					`--grep=docs(task): ${row.taskId} 4문서`,
					`refs/heads/${row.branch}`,
				])
			)?.trim();
			if (docs !== undefined && docs !== "")
				commits = await this.#commitsOf(row.repo, `${docs}..refs/heads/${row.branch}`);
		}
		if (commits.length === 0) {
			const seen = new Set<string>();
			for (const section of outcome?.sections.values() ?? []) {
				for (const value of section.commits) {
					const [sha, ...subject] = value.split(/\s+/);
					if (sha === undefined || seen.has(sha)) continue;
					seen.add(sha);
					commits.push({ sha: sha.slice(0, 12), subject: oneLine(subject.join(" "), 120) });
				}
			}
		}
		const goal = spec === undefined ? undefined : goalOf(specText ?? "");
		return {
			kind: "task",
			sourceId: taskSourceId(row),
			project: await this.#projectOf(row.repo),
			title: `작업 결과: ${oneLine(row.title, 100)}`,
			goal: oneLine(goal ?? row.title, GOAL_MAX),
			criteria,
			commits,
			summary: outcome?.summary ?? [],
			leftovers: [],
			source: [`TASK ${row.taskId} (위험도 ${row.risk})`, `스레드 ${row.threadRef}`, `호스트 ${row.host ?? "로컬"}`],
		};
	}

	// ---- conversation turns ----

	/**
	 * A conversation turn ended with a changed head in `rows` (its `turn_snapshots` rows): kept in the turn ledger at once,
	 * because those rows are pruned and gc'd long before the day's note goes out. A lane's or [TASK]'s own thread is
	 * left to their result notes.
	 */
	async recordTurn(turn: {
		originKey: string;
		opRef: string;
		threadRef: string;
		rows: readonly { repo: string; headBefore: string; headAfter: string; endedAt: number }[];
	}): Promise<void> {
		const config = this.#deps.config();
		const { store, timezone } = this.#deps;
		if (config === undefined) return;
		const origin = parseChatOrigin(turn.originKey);
		if (origin === undefined) return;
		try {
			if (store.getLaneByOrigin(turn.originKey) !== undefined || store.tasks.hasOrigin(turn.originKey)) return;
			const texts = store.turnTexts(turn.originKey, turn.opRef);
			const groupKey =
				origin.kind === "ch" && origin.threadId !== undefined
					? `thread:${turn.threadRef}`
					: `turn:${turn.originKey}:${turn.opRef}`;
			for (const row of turn.rows) {
				if (row.headBefore === row.headAfter || !(await this.#wanted(config, row.repo))) continue;
				store.addWikiTurn({
					originKey: turn.originKey,
					opRef: turn.opRef,
					repo: row.repo,
					threadRef: turn.threadRef,
					groupKey,
					day: localDay(row.endedAt, timezone),
					inbound: texts.inbound,
					conclusion: texts.conclusion,
					commits: (await this.#commitsOf(row.repo, `${row.headBefore}..${row.headAfter}`)).slice(0, COMMITS_MAX),
					endedAt: row.endedAt,
				});
			}
		} catch (error) {
			this.#fail(`turn:${turn.originKey}:${turn.opRef}`, error);
		}
	}

	/**
	 * Writes the turn notes that are due: a channel thread's day once the day is over, a DM or thread-less turn at the
	 * first call after it ended. Rows of a group that was already written are just marked.
	 */
	async flushTurns(): Promise<void> {
		const config = this.#deps.config();
		const { store, clock, timezone } = this.#deps;
		if (config === undefined || this.#flushing) return;
		this.#flushing = true;
		try {
			const today = localDay(clock.now(), timezone);
			const groups = new Map<string, WikiTurnRow[]>();
			for (const row of store.listUnsentWikiTurns()) {
				const key = `${row.groupKey}|${row.day}`;
				groups.set(key, [...(groups.get(key) ?? []), row]);
			}
			for (const rows of groups.values()) {
				const first = rows[0] as WikiTurnRow;
				if (first.groupKey.startsWith("thread:") && first.day >= today) continue;
				const sourceId = `ompbot-turns-${hashOf(first.groupKey)}-${first.day}`;
				if (store.wikiNoteState(sourceId)?.state === "sent" || (await this.#writeTurns(config, sourceId, rows))) {
					store.markWikiTurnsSent(rows.map((row) => row.id));
				}
			}
			store.pruneWikiNotes(clock.now() - KEEP_MS);
		} catch (error) {
			this.#fail("turns", error);
		} finally {
			this.#flushing = false;
		}
	}

	async #writeTurns(config: WikiNotesConfig, sourceId: string, rows: WikiTurnRow[]): Promise<boolean> {
		const first = rows[0] as WikiTurnRow;
		const commits = rows.flatMap((row) => row.commits);
		const lines = [
			"## 대화 작업",
			...rows.map((row, index) => {
				const own = row.commits.map((commit) => `\`${commit.sha}\` ${commit.subject}`).join("; ");
				return `${index + 1}. 요청: ${oneLine(row.inbound, REQUEST_MAX)}\n   - 저장소: ${row.repo}\n   - 커밋: ${own === "" ? "없음" : own}\n   - 결론: ${oneLine(row.conclusion, CONCLUSION_MAX)}`;
			}),
			"",
			"## 출처",
			`- 스레드 ${first.threadRef}`,
			`- 턴 ${rows.length}개 · 커밋 ${commits.length}개 · 날짜 ${first.day}`,
		];
		return this.#write(config, {
			sourceId,
			title: `대화 작업: ${oneLine(first.inbound, TITLE_MAX)}`,
			summary: lines.join("\n"),
			project: await this.#projectOf(first.repo),
			tags: ["ompbot", "work-outcome", "turns"],
		});
	}
}

const laneSourceId = (lane: LaneRow): string | undefined =>
	lane.meta.laneId === undefined ? undefined : `ompbot-lane-${lane.meta.laneId}`;
const taskSourceId = (row: TaskRow): string => `ompbot-task-${row.taskId}`;

/** The `# 목표` section of a task's spec.md. */
function goalOf(spec: string): string | undefined {
	const lines = spec.replace(/\r\n/g, "\n").split("\n");
	const start = lines.findIndex((line) => line.trim() === "# 목표");
	if (start === -1) return undefined;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^# /.test(line));
	const text = (end === -1 ? rest : rest.slice(0, end)).join(" ").trim();
	return text === "" ? undefined : text;
}

/** The draft as the note the wiki gets. */
export function renderNote(draft: NoteDraft): WikiNote {
	const lines = ["## 목표", draft.goal, "", "## 수락기준 결과"];
	if (draft.criteria.length === 0) lines.push("- 등록된 수락기준 없음");
	for (const item of draft.criteria) {
		lines.push(`- ${item.id} (${item.result}): ${item.text}`);
		for (const evidence of item.evidence) lines.push(`  - ${evidence}`);
	}
	if (draft.summary.length > 0) lines.push("", "## 요약", ...draft.summary.map((line) => `- ${line}`));
	lines.push("", "## 커밋");
	if (draft.commits.length === 0) lines.push("- 확인된 커밋 없음");
	for (const commit of draft.commits.slice(0, COMMITS_MAX)) lines.push(`- \`${commit.sha}\` ${commit.subject}`);
	if (draft.commits.length > COMMITS_MAX) lines.push(`- 외 ${draft.commits.length - COMMITS_MAX}개`);
	if (draft.landing !== undefined) lines.push("", "## 착지", ...draft.landing.lines.map((line) => `- ${line}`));
	if (draft.leftovers.length > 0) lines.push("", "## 후속·남은 것", ...draft.leftovers.map((line) => `- ${line}`));
	lines.push("", "## 출처", ...draft.source.map((line) => `- ${line}`));
	return {
		sourceId: draft.sourceId,
		title: draft.title,
		summary: redact(lines.join("\n")),
		project: draft.project,
		tags: ["ompbot", "work-outcome", draft.kind],
	};
}
