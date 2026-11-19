import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogFields, Logger } from "../src/log";
import { newestSessionFile } from "../src/omp/session-heal";
import {
	buildFloorsPrompt,
	FLOORS_DYNAMIC_HEADING,
	floorsSystemPrompt,
	type PersonaFiles,
	PINNED_OWNER_DOCS_FILE,
	pinPrefix,
	SOUL_MAX_BYTES,
	type SpawnPromptOptions,
	spawnSystemPrompt,
} from "../src/safety/prompt";
import { runBounded } from "./helpers/bounded-child";

const NOW = Date.parse("2026-11-11T08:00:00.000Z");
const MINUTE = 60_000;
const ORIGIN = "discord/dm/200000000000000001";
const SOUL = "SOUL-MARKER-이름은떡";
const OWNER_V1 = "OWNER-MARKER-v1 오너는 결론부터 원한다";
const OWNER_V2 = "OWNER-MARKER-v2 오너는 표를 좋아한다";
const PERSONA = "PERSONA-MARKER 존댓말";

interface LogRecord {
	level: string;
	event: string;
	fields: LogFields;
}

let dir: string;
let records: LogRecord[];
let log: Logger;
let files: PersonaFiles;

const record =
	(level: string) =>
	(event: string, fields: LogFields = {}): void => {
		records.push({ level, event, fields });
	};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-spawn-prompt-"));
	records = [];
	log = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
	const workspace = join(dir, "workspace");
	mkdirSync(workspace);
	files = {
		soul: join(workspace, "soul.md"),
		owner: join(workspace, "owner.md"),
		persona: join(workspace, "persona.md"),
	};
	writeFileSync(files.soul as string, SOUL);
	writeFileSync(files.owner as string, OWNER_V1);
	writeFileSync(files.persona as string, PERSONA);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const sessionDir = (epoch = 1, origin = ORIGIN): string =>
	join(dir, "sessions", encodeURIComponent(origin), `e${epoch}`);

/** An omp session file whose last model call was `ageMs` before `NOW` on `provider`. */
function sessionWithCall(dirPath: string, ageMs: number, provider = "anthropic"): void {
	mkdirSync(dirPath, { recursive: true });
	const at = new Date(NOW - ageMs).toISOString();
	const lines = [
		{ type: "session", id: "s1", timestamp: at },
		{ type: "message", id: "u1", timestamp: at, message: { role: "user", content: "hi" } },
		{
			type: "message",
			id: "a1",
			timestamp: at,
			message: {
				role: "assistant",
				provider,
				model: "claude-test",
				content: [{ type: "text", text: "ok" }],
				usage: { input: 10, cacheRead: 30_000, cacheWrite: 100 },
			},
		},
		// Written at child exit, after the last call: must not count as a call.
		{ type: "custom", customType: "session_exit", id: "x1", timestamp: new Date(NOW - 1000).toISOString() },
	];
	writeFileSync(
		join(dirPath, "2026-11-11T07-00-00-000Z_s1.jsonl"),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

function spawn(overrides: Partial<SpawnPromptOptions> = {}): string {
	return spawnSystemPrompt({
		secretsDir: "/home/test/.ompbot/secrets",
		originKey: ORIGIN,
		sessionDir: sessionDir(),
		files,
		now: NOW,
		log,
		...overrides,
	});
}

const spawnLogs = (): LogFields[] =>
	records.filter((r) => r.event === "omp_spawn_prompt" && r.level === "info").map((r) => r.fields);
const lastSpawnLog = (): LogFields => {
	const all = spawnLogs();
	const last = all[all.length - 1];
	if (last === undefined) throw new Error("no omp_spawn_prompt log");
	return last;
};
const HASH = /^[0-9a-f]{16}$/;

describe("omp_spawn_prompt log (AC-1)", () => {
	test("every spawn logs the part hashes, the dynamic line names and pinned, never the raw owner docs", () => {
		const text = spawn();
		expect(spawnLogs()).toHaveLength(1);
		const fields = lastSpawnLog();
		expect(fields.origin).toBe(ORIGIN);
		expect(fields.epoch).toBe(1);
		for (const key of ["floors_static", "owner_docs", "prompt"]) expect(String(fields[key])).toMatch(HASH);
		expect(typeof fields.floors_dynamic).toBe("string");
		expect(fields.pinned).toBe(false);
		// The text itself carries the owner docs; the log does not.
		expect(text).toContain(SOUL);
		expect(text).toContain(OWNER_V1);
		const logged = JSON.stringify(records);
		for (const raw of [SOUL, OWNER_V1, PERSONA]) expect(logged).not.toContain(raw);

		spawn();
		expect(spawnLogs()).toHaveLength(2);
	});

	test("peerTouched shows in floors_dynamic while floors_static stays the same", () => {
		spawn({ peerTouched: false });
		const clean = lastSpawnLog();
		spawn({ peerTouched: true });
		const touched = lastSpawnLog();
		expect(String(clean.floors_dynamic).split(",")).not.toContain("peerTouched");
		expect(String(touched.floors_dynamic).split(",")).toContain("peerTouched");
		expect(touched.floors_static).toBe(clean.floors_static);
		expect(touched.prompt).not.toBe(clean.prompt);
	});

	test("a lane origin logs too, with no owner docs and no sidecar", () => {
		const lane = "lane/T-1";
		const laneDir = sessionDir(1, lane);
		const text = spawn({ originKey: lane, sessionDir: laneDir });
		expect(text).not.toContain(OWNER_V1);
		expect(lastSpawnLog().origin).toBe(lane);
		expect(lastSpawnLog().pinned).toBe(false);
		expect(() => statSync(join(laneDir, PINNED_OWNER_DOCS_FILE))).toThrow();
	});

	test("the unpinned text equals floorsSystemPrompt for the same inputs", () => {
		expect(spawn()).toBe(floorsSystemPrompt("/home/test/.ompbot/secrets", ORIGIN, files));
	});
});

describe("owner docs pinned per epoch while the cache is warm (AC-2)", () => {
	test("owner.md edited within an hour of the last call: the append text stays byte-identical", () => {
		const first = spawn();
		const sidecar = join(sessionDir(), PINNED_OWNER_DOCS_FILE);
		expect(statSync(sidecar).mode & 0o777).toBe(0o600);
		sessionWithCall(sessionDir(), 10 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const second = spawn();
		expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
		expect(second).toContain(OWNER_V1);
		expect(second).not.toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(true);
	});

	test("last call over an hour ago: the new owner.md goes in and the sidecar is rewritten", () => {
		spawn();
		sessionWithCall(sessionDir(), 61 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const text = spawn();
		expect(text).toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(false);
		const sidecar = join(sessionDir(), PINNED_OWNER_DOCS_FILE);
		expect(readFileSync(sidecar, "utf8")).toContain(OWNER_V2);
		expect(statSync(sidecar).mode & 0o777).toBe(0o600);
	});

	test("a new epoch gets the new owner.md even when the old epoch is warm", () => {
		spawn();
		sessionWithCall(sessionDir(1), 5 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const text = spawn({ sessionDir: sessionDir(2) });
		expect(text).toContain(OWNER_V2);
		expect(lastSpawnLog().epoch).toBe(2);
		expect(lastSpawnLog().pinned).toBe(false);
	});

	test("a provider with no known cache TTL never pins", () => {
		spawn();
		sessionWithCall(sessionDir(), 5 * MINUTE, "openai");
		writeFileSync(files.owner as string, OWNER_V2);
		expect(spawn()).toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(false);
	});
});

/** The sidecar body (after its header line): the pinned static floors plus owner docs. */
const sidecarBody = (dirPath = sessionDir()): string => {
	const raw = readFileSync(join(dirPath, PINNED_OWNER_DOCS_FILE), "utf8");
	return raw.slice(raw.indexOf("\n") + 1);
};
const sidecarHeader = (dirPath = sessionDir()): string => {
	const raw = readFileSync(join(dirPath, PINNED_OWNER_DOCS_FILE), "utf8");
	return raw.slice(0, raw.indexOf("\n"));
};
const sha16 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
const HERDR_MARK = "herdr";

describe("static floors pinned with the owner docs while the cache is warm (AC-1)", () => {
	test("a changed static floors input on a warm respawn keeps the first spawn's text byte for byte", () => {
		const first = spawn({ herdr: false });
		expect(first).not.toContain(HERDR_MARK);
		sessionWithCall(sessionDir(), 10 * MINUTE);

		const second = spawn({ herdr: true });
		expect(lastSpawnLog().pinned).toBe(true);
		expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
		expect(second).not.toContain(HERDR_MARK);
		// The sidecar holds the static floors and the owner docs together.
		expect(sidecarBody().startsWith("# ompbot 운영 안내 / ompbot operating floors")).toBe(true);
		expect(sidecarBody()).toContain(OWNER_V1);
	});

	test("cold cache: the new static floors go in and the sidecar is rewritten with them", () => {
		spawn({ herdr: false });
		sessionWithCall(sessionDir(), 61 * MINUTE);

		const text = spawn({ herdr: true });
		expect(lastSpawnLog().pinned).toBe(false);
		expect(text).toBe(floorsSystemPrompt("/home/test/.ompbot/secrets", ORIGIN, files, undefined, true));
		expect(sidecarBody()).toContain(HERDR_MARK);
		expect(text.startsWith(sidecarBody())).toBe(true);
		expect(statSync(join(sessionDir(), PINNED_OWNER_DOCS_FILE)).mode & 0o777).toBe(0o600);
	});

	test("warm but no sidecar: fresh static floors, the sidecar is written, no warning", () => {
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const text = spawn({ herdr: true });
		expect(lastSpawnLog().pinned).toBe(false);
		expect(text).toContain(HERDR_MARK);
		expect(sidecarBody()).toContain(HERDR_MARK);
		expect(records.some((r) => r.level === "warn")).toBe(false);
		spawn({ herdr: false });
		expect(lastSpawnLog().pinned).toBe(true);
	});

	test("warm but a corrupt v2 sidecar: fresh static floors replace it", () => {
		spawn({ herdr: false });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const sidecar = join(sessionDir(), PINNED_OWNER_DOCS_FILE);
		writeFileSync(sidecar, readFileSync(sidecar, "utf8").replace("Hard floors", "Soft floors"));

		const text = spawn({ herdr: true });
		expect(lastSpawnLog().pinned).toBe(false);
		expect(text).toContain(HERDR_MARK);
		expect(sidecarBody()).toContain(HERDR_MARK);
	});
});

describe("dynamic lines are never pinned and always last (AC-2)", () => {
	const PEERS = { peers: [{ name: "peer-bot", mention: "<@U999>" }] };

	test("a warm respawn with changed dynamic lines keeps the pinned prefix byte for byte and swaps only the tail", () => {
		const first = spawn({ peerTouched: false });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const prefix = sidecarBody();
		expect(first.startsWith(prefix)).toBe(true);

		const second = spawn({ peerTouched: true, surface: PEERS });
		expect(lastSpawnLog().pinned).toBe(true);
		expect(second.startsWith(prefix)).toBe(true);
		expect(second).not.toBe(first);
		const tail = second.slice(prefix.length);
		expect(tail.startsWith(FLOORS_DYNAMIC_HEADING)).toBe(true);
		expect(tail).toContain("peer-bot = <@U999>");
		expect(String(lastSpawnLog().floors_dynamic).split(",")).toEqual(
			expect.arrayContaining(["peerTouched", "peers", "resume"]),
		);
		// The pinned unit never holds a dynamic line.
		expect(prefix).not.toContain("peer-bot");
		expect(prefix).not.toContain(FLOORS_DYNAMIC_HEADING);
	});

	test("the dynamic block comes after the owner docs and the answer format section", () => {
		const text = spawn({ peerTouched: true, surface: { noLaneChannel: true, ...PEERS } });
		const at = text.indexOf(FLOORS_DYNAMIC_HEADING);
		expect(at).toBeGreaterThan(text.indexOf(PERSONA));
		expect(at).toBeGreaterThan(text.indexOf("## 답변 형식 / Answer format"));
		expect(text.slice(at)).toContain("ompbot_work_start");
		expect(text.indexOf("[자동 후속]")).toBeGreaterThan(at);
	});

	test("the unpinned text with dynamic lines equals floorsSystemPrompt for the same inputs", () => {
		const surface = { noLaneChannel: true, ...PEERS };
		expect(spawn({ herdr: true, peerTouched: true, surface })).toBe(
			floorsSystemPrompt("/home/test/.ompbot/secrets", ORIGIN, files, undefined, true, false, true, surface),
		);
	});
});

describe("sidecar format versions (AC-3)", () => {
	test("a v1 sidecar (owner docs only) is replaced without a warning", () => {
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const v1Body = `\n\n[오너 관찰지] old\n${OWNER_V2}`;
		writeFileSync(
			join(sessionDir(), PINNED_OWNER_DOCS_FILE),
			`ompbot-pinned-owner-docs v1 sha256=${createHash("sha256").update(v1Body).digest("hex")}\n${v1Body}`,
		);
		const text = spawn();
		expect(lastSpawnLog().pinned).toBe(false);
		expect(text).toContain(OWNER_V1);
		expect(text).not.toContain(OWNER_V2);
		expect(records.some((r) => r.level === "warn")).toBe(false);
		expect(sidecarHeader().startsWith("ompbot-pinned-owner-docs v3 ")).toBe(true);
	});

	test("an unknown header is replaced without a warning", () => {
		sessionWithCall(sessionDir(), 10 * MINUTE);
		writeFileSync(join(sessionDir(), PINNED_OWNER_DOCS_FILE), `something-else v9\n${OWNER_V2}`);
		const text = spawn();
		expect(lastSpawnLog().pinned).toBe(false);
		expect(text).not.toContain(OWNER_V2);
		expect(records.some((r) => r.level === "warn")).toBe(false);
		expect(sidecarHeader().startsWith("ompbot-pinned-owner-docs v3 ")).toBe(true);
	});
});

describe("sidecar forgery (qa-l #77)", () => {
	const sidecar = (): string => join(sessionDir(), PINNED_OWNER_DOCS_FILE);
	const forged = "# FORGED floors\n";

	test("a tampered body with its own sha256 (v2 form) is not trusted", () => {
		spawn({ herdr: false });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const body = forged + OWNER_V1;
		writeFileSync(
			sidecar(),
			`ompbot-pinned-owner-docs v2 static=${forged.length} sha256=${createHash("sha256").update(body).digest("hex")}\n${body}`,
		);
		const text = spawn({ herdr: false });
		expect(lastSpawnLog().pinned).toBe(false);
		expect(text).not.toContain("FORGED");
		expect(records.some((r) => r.level === "warn")).toBe(false);
		expect(sidecarHeader().startsWith("ompbot-pinned-owner-docs v3 ")).toBe(true);
	});

	test("a tampered body with an arbitrary mac under the current key id is replaced and reported once", () => {
		spawn({ herdr: false });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const keyId = /key=([0-9a-f]{16}) /.exec(sidecarHeader())?.[1] as string;
		expect(keyId).toBeDefined();
		writeFileSync(
			sidecar(),
			`ompbot-pinned-owner-docs v3 static=${forged.length} key=${keyId} mac=${"0".repeat(64)}\n${forged}${OWNER_V1}`,
		);
		const text = spawn({ herdr: false });
		expect(lastSpawnLog().pinned).toBe(false);
		expect(text).not.toContain("FORGED");
		expect(records.filter((r) => r.level === "warn" && r.event === "pinned_owner_docs_unusable")).toHaveLength(1);
	});

	test("a v2 sidecar is replaced by v3 without a report", () => {
		spawn({ herdr: false });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const raw = readFileSync(sidecar(), "utf8");
		const body = raw.slice(raw.indexOf("\n") + 1);
		const staticLength = /static=(\d+)/.exec(raw)?.[1];
		writeFileSync(
			sidecar(),
			`ompbot-pinned-owner-docs v2 static=${staticLength} sha256=${createHash("sha256").update(body).digest("hex")}\n${body}`,
		);
		spawn({ herdr: false });
		expect(lastSpawnLog().pinned).toBe(false);
		expect(records.some((r) => r.level === "warn")).toBe(false);
		expect(sidecarHeader().startsWith("ompbot-pinned-owner-docs v3 ")).toBe(true);
	});

	test("same key: pinned; another key (daemon restart): rewritten without a report; the key never reaches the file", () => {
		const fresh = { floors: "FLOORS-A\n", owner: "OWNER-A\n" };
		const reports: unknown[] = [];
		const report = (error: unknown) => reports.push(error);
		const keyA = Buffer.alloc(32, 7);
		const keyB = Buffer.alloc(32, 9);
		const dirPath = sessionDir();
		expect(pinPrefix(dirPath, fresh, true, report, keyA).pin).toBe("none");
		const written = readFileSync(join(dirPath, PINNED_OWNER_DOCS_FILE), "utf8");
		expect(written).not.toContain(keyA.toString("hex"));
		expect(written).not.toContain(keyA.toString("base64"));
		const other = { floors: "FLOORS-B\n", owner: "OWNER-B\n" };
		const same = pinPrefix(dirPath, other, true, report, keyA);
		expect(same).toEqual({ ...fresh, pin: "mac" });
		const restarted = pinPrefix(dirPath, other, true, report, keyB);
		expect(restarted).toEqual({ ...other, pin: "none" });
		expect(reports).toEqual([]);
		const rewritten = readFileSync(join(dirPath, PINNED_OWNER_DOCS_FILE), "utf8");
		expect(rewritten).toContain("FLOORS-B");
		expect(rewritten).not.toContain(keyB.toString("hex"));
		expect(rewritten).not.toContain(keyB.toString("base64"));
	});
});

describe("callers and hashes (AC-4)", () => {
	test("buildFloorsPrompt (Teams QA, dispatch simple) puts the static floors first and the dynamic block last", () => {
		const text = buildFloorsPrompt("/home/test/.ompbot/secrets", ORIGIN, false, false, true);
		const at = text.indexOf(FLOORS_DYNAMIC_HEADING);
		expect(at).toBeGreaterThan(text.indexOf("## 답변 형식 / Answer format"));
		expect(text.slice(at)).toContain("[자동 후속]");
		expect(text.slice(0, at)).not.toContain("[자동 후속]");
		// No dynamic line, no dynamic block.
		expect(buildFloorsPrompt("/s", "monitor/m1")).not.toContain(FLOORS_DYNAMIC_HEADING);
	});

	test("a lane origin with dynamic lines: no sidecar, dynamic block last", () => {
		const lane = "ompbot/work/lane1";
		const laneDir = sessionDir(1, lane);
		sessionWithCall(laneDir, 10 * MINUTE);
		const text = spawn({ originKey: lane, sessionDir: laneDir, peerTouched: true });
		expect(lastSpawnLog().pinned).toBe(false);
		expect(text.indexOf(FLOORS_DYNAMIC_HEADING)).toBeGreaterThan(0);
		expect(() => statSync(join(laneDir, PINNED_OWNER_DOCS_FILE))).toThrow();
	});

	test("a monitor origin pins its static floors and owner docs while warm", () => {
		const monitor = "monitor/m1";
		const monitorDir = sessionDir(1, monitor);
		const first = spawn({ originKey: monitor, sessionDir: monitorDir });
		expect(first).toContain(OWNER_V1);
		sessionWithCall(monitorDir, 10 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const second = spawn({ originKey: monitor, sessionDir: monitorDir, secretsDir: "/other/secrets" });
		expect(lastSpawnLog().pinned).toBe(true);
		expect(second).toBe(first);
		expect(second).not.toContain("/other/secrets");
	});

	test("a pinned spawn logs floors_static and owner_docs hashed from the text it sends", () => {
		spawn({ herdr: false });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);
		const text = spawn({ herdr: true, peerTouched: true });
		const fields = lastSpawnLog();
		expect(fields.pinned).toBe(true);
		const ownerAt = text.indexOf("\n\n[정체성(soul)]");
		const dynamicAt = text.indexOf(FLOORS_DYNAMIC_HEADING);
		expect(fields.floors_static).toBe(sha16(text.slice(0, ownerAt)));
		expect(fields.owner_docs).toBe(sha16(text.slice(ownerAt, dynamicAt)));
		expect(fields.prompt).toBe(sha16(text));
	});
});

describe("unusable sidecar (AC-3)", () => {
	test("a corrupted sidecar: fresh owner docs, pinned=false, no throw", () => {
		spawn();
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const sidecar = join(sessionDir(), PINNED_OWNER_DOCS_FILE);
		writeFileSync(sidecar, readFileSync(sidecar, "utf8").replace("OWNER-MARKER-v1", "OWNER-MARKER-vX"));
		writeFileSync(files.owner as string, OWNER_V2);

		const text = spawn();
		expect(text).toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(false);
		expect(records.some((r) => r.level === "warn" && r.event === "pinned_owner_docs_unusable")).toBe(true);
		// Rewritten from the fresh text, so the next warm spawn pins it again.
		spawn();
		expect(lastSpawnLog().pinned).toBe(true);
	});

	test("an unreadable sidecar (a directory in its place): fresh owner docs, pinned=false, no throw", () => {
		sessionWithCall(sessionDir(), 10 * MINUTE);
		mkdirSync(join(sessionDir(), PINNED_OWNER_DOCS_FILE));
		writeFileSync(files.owner as string, OWNER_V2);

		let text = "";
		expect(() => {
			text = spawn();
		}).not.toThrow();
		expect(text).toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(false);
		expect(records.some((r) => r.level === "warn" && r.event === "pinned_owner_docs_unusable")).toBe(true);
		expect(JSON.stringify(records)).not.toContain(OWNER_V2);
	});
});

describe("qa50b-low lane L", () => {
	const options = (extra: Partial<SpawnPromptOptions> = {}): SpawnPromptOptions => ({
		secretsDir: join(dir, "secrets"),
		originKey: ORIGIN,
		sessionDir: sessionDir(),
		files,
		herdr: true,
		ownerDialogs: true,
		peerTouched: true,
		now: NOW,
		log,
		...extra,
	});

	test("L-11 an owner doc past its cap injects its head, cut at the cap on a whole character", () => {
		// 3 bytes per character: the cap falls inside one, which must not leave a broken character.
		writeFileSync(files.soul as string, `${SOUL}\n${"가".repeat(SOUL_MAX_BYTES)}TAIL-MARKER`);
		const errors: string[] = [];
		const prompt = spawnSystemPrompt(options({ onPersonaError: (error) => errors.push(String(error)) }));
		expect(errors).toEqual([]);
		expect(prompt).toContain(SOUL);
		expect(prompt).not.toContain("TAIL-MARKER");
		expect(prompt).not.toContain("\uFFFD");
		const soulPart = prompt.slice(prompt.indexOf(SOUL), prompt.indexOf("[오너 관찰지]")).trimEnd();
		expect(Buffer.byteLength(soulPart)).toBeLessThanOrEqual(SOUL_MAX_BYTES);
		expect(prompt).toContain(OWNER_V1);
	});

	test("L-이관1 hostTools:false leaves out every host tool line (agy and claude children have none)", () => {
		const hostToolNames = [
			"discord_send_file",
			"ompbot_request_approval",
			"ompbot_monitor_add",
			"ompbot_dispatch",
			"ompbot_work_start",
		];
		const withTools = spawnSystemPrompt(options({ surface: { noLaneChannel: true } }));
		for (const name of hostToolNames.filter((n) => n !== "ompbot_work_start")) expect(withTools).toContain(name);
		const without = spawnSystemPrompt(options({ hostTools: false, surface: { noLaneChannel: true } }));
		for (const name of hostToolNames) expect({ name, found: without.includes(name) }).toEqual({ name, found: false });
		expect(without).toContain("This session has no ompbot host tools");
		// The owner docs and the hard floors stay.
		expect(without).toContain(SOUL);
		expect(without).toContain("비밀 읽기 금지");
	});
});

describe("a FIFO in the session dir (qa-l #78)", () => {
	const SRC = join(import.meta.dir, "..", "src");
	/** A FIFO open would block the child for good, so it runs bounded; the test's own timeout sits above that limit. */
	const CHILD_TEST_MS = 30_000;
	const mkfifo = (path: string): void => {
		expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
	};
	/** Builds the spawn prompt in a bounded child; prints `done` and then one line per warning event. */
	const spawnInChild = () =>
		runBounded(
			`const { spawnSystemPrompt } = await import(${JSON.stringify(join(SRC, "safety", "prompt.ts"))});
			 const warns = [];
			 const quiet = () => {};
			 spawnSystemPrompt({ secretsDir: "/home/test/.ompbot/secrets", originKey: ${JSON.stringify(ORIGIN)},
			   sessionDir: ${JSON.stringify(sessionDir())}, files: ${JSON.stringify(files)}, now: ${NOW},
			   log: { debug: quiet, info: quiet, error: quiet, warn: (event, fields) => warns.push(event + " " + fields.error) } });
			 console.log(["done", ...warns].join("\\n"));`,
		);

	test(
		"a FIFO sidecar on a warm cache is reported and the prompt is still built",
		async () => {
			sessionWithCall(sessionDir(), 10 * MINUTE);
			mkfifo(join(sessionDir(), PINNED_OWNER_DOCS_FILE));
			const result = await spawnInChild();
			expect(result.timedOut).toBe(false);
			const [done, ...warns] = result.stdout.trim().split("\n");
			expect(done).toBe("done");
			expect(warns).toHaveLength(1);
			expect(warns[0]).toStartWith("pinned_owner_docs_unusable ");
			expect(warns[0]).toContain("not a regular file");
		},
		CHILD_TEST_MS,
	);

	test(
		"the newest .jsonl being a FIFO is skipped for the next regular file, without a report",
		async () => {
			sessionWithCall(sessionDir(), 10 * MINUTE);
			const fifo = join(sessionDir(), "2026-11-11T07-30-00-000Z_s2.jsonl");
			mkfifo(fifo);
			expect(newestSessionFile(sessionDir())).toBe(join(sessionDir(), "2026-11-11T07-00-00-000Z_s1.jsonl"));
			const result = await spawnInChild();
			expect(result.timedOut).toBe(false);
			expect(result.stdout.trim()).toBe("done");
		},
		CHILD_TEST_MS,
	);
});

describe("floors tool lines match the session (qa-l low B)", () => {
	// qa-l #75: Teams owner 1:1 sessions register no monitor tools, so the prompt must not tell them to use them.
	test("the monitor tools line is for Discord owner DMs only", () => {
		const secrets = join(dir, "secrets");
		expect(buildFloorsPrompt(secrets, "discord/dm/1234567890")).toContain("ompbot_monitor_add"); // gitleaks:allow (fake channel id)
		expect(buildFloorsPrompt(secrets, "teams/dm/t0123456789abcdef")).not.toContain("ompbot_monitor_add");
	});

	// qa-l #76: a lane session runs in the lane's worktree, not the ompbot workspace.
	test("a lane session's cwd line names the lane directory", () => {
		const secrets = join(dir, "secrets");
		const lane = buildFloorsPrompt(secrets, "ompbot/work/lane1", false, false, false, {
			lanePlatform: "discord",
			laneCwd: "/wt/lane1",
		});
		expect(lane).toContain("/wt/lane1");
		expect(lane).not.toContain("Your cwd is the ompbot workspace");
		expect(buildFloorsPrompt(secrets, ORIGIN)).toContain("Your cwd is the ompbot workspace");
	});
});

describe("owner docs survive a daemon restart (another key, same floors)", () => {
	const keyA = Buffer.alloc(32, 7);
	const keyB = Buffer.alloc(32, 9);
	const keyIdOf = (key: Buffer): string => createHash("sha256").update(key).digest("hex").slice(0, 16);
	/** Replace the sidecar body, keeping the header (and so keyA's key id with a MAC that no longer matches). */
	const rewriteBody = (body: string): void => {
		const raw = readFileSync(join(sessionDir(), PINNED_OWNER_DOCS_FILE), "utf8");
		writeFileSync(join(sessionDir(), PINNED_OWNER_DOCS_FILE), `${raw.slice(0, raw.indexOf("\n"))}\n${body}`);
	};

	test("warm, same floors, edited owner.md: the old owner docs stay, pin=owner, the sidecar is re-signed for keyB", () => {
		const first = spawn({ key: keyA });
		expect(sidecarHeader()).toContain(`key=${keyIdOf(keyA)}`);
		sessionWithCall(sessionDir(), 10 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const text = spawn({ key: keyB });
		expect(text).toBe(first);
		expect(text).toContain(OWNER_V1);
		expect(text).not.toContain(OWNER_V2);
		expect(lastSpawnLog().pin).toBe("owner");
		expect(lastSpawnLog().pinned).toBe(true);
		expect(records.some((r) => r.level === "warn")).toBe(false);
		expect(sidecarHeader()).toContain(`key=${keyIdOf(keyB)}`);
		expect(spawn({ key: keyB })).toBe(first);
		expect(lastSpawnLog().pin).toBe("mac");
	});

	test("a forged floors part under keyA: the floors are the fresh static floors, the forged text never goes in", () => {
		const first = spawn({ key: keyA, herdr: false });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const body = sidecarBody();
		const staticLength = Number(/static=(\d+)/.exec(sidecarHeader())?.[1]);
		rewriteBody(`# FORGED floors\n${body.slice(staticLength)}`);

		const text = spawn({ key: keyB, herdr: false });
		expect(text).not.toContain("FORGED");
		expect(text).toBe(first);
		expect(lastSpawnLog().pin).toBe("none");
		expect(sidecarBody()).toBe(body);
	});

	test("an owner part over the owner docs cap is not reused: the fresh owner docs go in", () => {
		spawn({ key: keyA });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const body = sidecarBody();
		const staticLength = Number(/static=(\d+)/.exec(sidecarHeader())?.[1]);
		rewriteBody(`${body.slice(0, staticLength)}${"X".repeat(60_000)}`);

		const text = spawn({ key: keyB });
		expect(text).not.toContain("XXXX");
		expect(text).toContain(OWNER_V1);
		expect(lastSpawnLog().pin).toBe("none");
		expect(sidecarBody()).not.toContain("XXXX");
	});

	test("cold cache under keyB: the new owner docs go in with pin=none", () => {
		spawn({ key: keyA });
		sessionWithCall(sessionDir(), 61 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const text = spawn({ key: keyB });
		expect(text).toContain(OWNER_V2);
		expect(lastSpawnLog().pin).toBe("none");
		expect(lastSpawnLog().pinned).toBe(false);
	});

	test("the same key id with a wrong mac is still reported and not pinned", () => {
		spawn({ key: keyA, herdr: false });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		rewriteBody(sidecarBody().replace(OWNER_V1, "OWNER-FORGED"));
		const text = spawn({ key: keyA, herdr: false });
		expect(text).not.toContain("OWNER-FORGED");
		expect(lastSpawnLog().pin).toBe("none");
		expect(records.filter((r) => r.level === "warn" && r.event === "pinned_owner_docs_unusable")).toHaveLength(1);
	});
});
