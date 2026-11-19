import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OmpbotConfig } from "../config";
import { redact } from "../redact";

/**
 * The wiki client's outbox (doc/plans/wiki-work-outcome-notes.md A): `<agentDir>/wiki-outbox/<sourceId>.json` is what
 * `omp-wiki-session-note.py --sweep` sends to the wiki (and keeps for the next sweep when the send fails). ompbot only
 * writes the file and starts one detached sweep; the server's answer is the client's business.
 */

export interface WikiNote {
	/** One per unit of work (`ompbot-task-<id>`, `ompbot-lane-<id>`, `ompbot-turns-…`): the same unit is the same file. */
	sourceId: string;
	title: string;
	summary: string;
	project: string;
	tags: string[];
}

export type WikiNotesConfig = NonNullable<OmpbotConfig["wikiNotes"]>;

/** Starts the client's `--sweep` without waiting for it; throws when the process cannot be started. */
export type SweepSpawner = (argv: string[], env: Record<string, string>) => void;

export const spawnDetached: SweepSpawner = (argv, env) => {
	const child = spawn(argv[0] as string, argv.slice(1), {
		stdio: "ignore",
		detached: true,
		env: { ...process.env, ...env },
	});
	// A missing binary is an `error` event on the child, not a throw: swallow it here, the next sweep finds the file.
	child.on("error", () => {});
	child.unref();
};

export const agentDirOf = (config: WikiNotesConfig): string => config.agentDir ?? join(homedir(), ".omp", "agent");
export const clientScriptOf = (config: WikiNotesConfig): string =>
	join(config.client, "integrations", "omp", "omp-wiki-session-note.py");

/** Where a note's file lies: `sourceId` is built from ids and hex, never from free text. */
const outboxFile = (config: WikiNotesConfig, sourceId: string): string =>
	join(agentDirOf(config), "wiki-outbox", `${sourceId}.json`);

/**
 * Writes the note (title and summary masked by `redact`) atomically (`.tmp`, then rename) and starts the sweep.
 * Throws when the file cannot be written; `sweepError` is set when only the sweep could not be started (the file stays
 * for the next sweep of any omp session).
 */
export function writeNote(
	config: WikiNotesConfig,
	note: WikiNote,
	spawnSweep: SweepSpawner = spawnDetached,
): { sweepError?: string } {
	const file = outboxFile(config, note.sourceId);
	mkdirSync(join(agentDirOf(config), "wiki-outbox"), { recursive: true });
	const body = {
		sourceId: note.sourceId,
		title: redact(note.title),
		summary: redact(note.summary),
		project: note.project,
		tags: note.tags,
	};
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
	const script = clientScriptOf(config);
	if (!existsSync(script)) return { sweepError: `wiki client not found: ${script}` };
	try {
		spawnSweep(["python3", script, "--sweep"], { OMP_AGENT_DIR: agentDirOf(config) });
	} catch (error) {
		return { sweepError: String(error).slice(0, 200) };
	}
	return {};
}
