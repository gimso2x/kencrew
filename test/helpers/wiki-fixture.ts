import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/log";
import { redact } from "../../src/redact";
import type { Store } from "../../src/store/db";
import type { TaskRow } from "../../src/tasks/ledger";
import { WikiNotes } from "../../src/wiki/notes";
import type { WikiNotesConfig } from "../../src/wiki/outbox";

/** A wiki client directory with its script in place, an outbox under a temp agent dir, and every sweep recorded. */
export interface WikiFixture {
	dir: string;
	/** `undefined` = the notes are off (as without `wikiNotes` in config.json). */
	config: WikiNotesConfig | undefined;
	sweeps: string[][];
	logs: string[];
	notes: WikiNotes;
	/** Ids of the notes now in the outbox (a sweep removes them in real life; tests remove them by hand). */
	outbox(): string[];
	read(sourceId: string): { sourceId: string; title: string; summary: string; project: string; tags: string[] };
	remove(): void;
}

export function wikiFixture(
	store: Store,
	options: {
		now?: () => number;
		spawnFails?: boolean;
		readTaskDoc?: (row: TaskRow, name: "spec.md" | "outcome.md") => Promise<string | undefined>;
		repos?: string[];
	} = {},
): WikiFixture {
	const dir = mkdtempSync(join(tmpdir(), "ompbot-wiki-"));
	const client = join(dir, "client");
	mkdirSync(join(client, "integrations", "omp"), { recursive: true });
	writeFileSync(join(client, "integrations", "omp", "omp-wiki-session-note.py"), "# fake client\n");
	const agentDir = join(dir, "agent");
	const sweeps: string[][] = [];
	const logs: string[] = [];
	const clock = { now: options.now ?? (() => Date.now()) };
	const fixture: WikiFixture = {
		dir,
		config: { client, agentDir, ...(options.repos === undefined ? {} : { repos: options.repos }) },
		sweeps,
		logs,
		notes: undefined as unknown as WikiNotes,
		outbox: () => {
			try {
				return readdirSync(join(agentDir, "wiki-outbox"))
					.filter((name) => name.endsWith(".json"))
					.map((name) => name.slice(0, -".json".length))
					.sort();
			} catch {
				return [];
			}
		},
		read: (sourceId) => JSON.parse(readFileSync(join(agentDir, "wiki-outbox", `${sourceId}.json`), "utf8")),
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
	fixture.notes = new WikiNotes({
		config: () => fixture.config,
		store,
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		clock,
		timezone: "Asia/Seoul",
		readTaskDoc: options.readTaskDoc ?? (async () => undefined),
		spawnSweep: (argv) => {
			if (options.spawnFails === true) throw new Error("spawn python3 ENOENT");
			sweeps.push(argv);
		},
	});
	return fixture;
}
