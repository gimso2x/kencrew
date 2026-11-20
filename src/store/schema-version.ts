import type { Database } from "bun:sqlite";

/**
 * The schema generation of `ompbot.db`, kept in `PRAGMA user_version` (no table). The ad hoc `PRAGMA table_info`
 * migrations stay as they are; `Store` raises the marker once they have all run. Baseline = 1; 2 = `inbound.state` accepts `uncertain` (+ `uncertain_reason`, `uncertain_at`).
 * RULE: a commit that changes the schema (table, column, index) bumps this by 1.
 */
export const SCHEMA_VERSION = 2;

export function readSchemaVersion(db: Database): number {
	return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function newerSchemaMessage(dbVersion: number): string {
	return `newer_schema: db schema version ${dbVersion} is newer than this code's ${SCHEMA_VERSION}; the code was rolled back past a schema change - restore a backup taken by this code (ompbot restore <backup db>)`;
}

export class NewerSchemaError extends Error {
	readonly code = "newer_schema";
	readonly dbVersion: number;

	constructor(dbVersion: number) {
		super(newerSchemaMessage(dbVersion));
		this.name = "NewerSchemaError";
		this.dbVersion = dbVersion;
	}
}

/** Refuses a database written by newer code. Call on a write connection before any pragma, DDL or migration. */
export function checkSchemaVersion(db: Database): void {
	const version = readSchemaVersion(db);
	if (version > SCHEMA_VERSION) throw new NewerSchemaError(version);
}

/** Raises an older marker (0 = never stamped) to the code's version; called after every migration has run. */
export function stampSchemaVersion(db: Database): void {
	if (readSchemaVersion(db) < SCHEMA_VERSION) db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
