import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupSkillRevision, listSkillRevisions, rollbackSkill } from "../src/review/skills";

let dir: string;
let skill: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-skills-qa-j-"));
	skill = join(dir, "managed-skills", "demo");
	mkdirSync(skill, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("skills rollback (qa-j)", () => {
	// qa n62: two revisions saved in one millisecond are `<stamp>.md` and `<stamp>-2.md`; the second is the newer.
	test("the newest revision wins when two were saved in the same millisecond", () => {
		const now = Date.UTC(2026, 10, 14, 1, 2, 3, 4);
		writeFileSync(join(skill, "SKILL.md"), "v1");
		const first = backupSkillRevision(skill, now) as string;
		writeFileSync(join(skill, "SKILL.md"), "v2");
		const second = backupSkillRevision(skill, now) as string;
		expect(second).not.toBe(first);
		expect(listSkillRevisions(skill)).toEqual([second, first]);
		writeFileSync(join(skill, "SKILL.md"), "v3");
		expect(rollbackSkill(skill)).toBe(second);
		expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe("v2");
	});

	// qa n61: the swap writes both files; a link in either slot must not carry the write out of the skill directory.
	test("a symlinked SKILL.md or revision slot is refused and the target stays untouched", () => {
		const outside = join(dir, "outside.md");
		writeFileSync(outside, "secret");
		mkdirSync(join(skill, "revisions"));
		writeFileSync(join(skill, "revisions", "2026-11-14T00-00-00-000Z.md"), "old");
		symlinkSync(outside, join(skill, "SKILL.md"));
		expect(() => rollbackSkill(skill)).toThrow("symbolic link");
		expect(readFileSync(outside, "utf8")).toBe("secret");
		rmSync(join(skill, "SKILL.md"));
		writeFileSync(join(skill, "SKILL.md"), "now");
		rmSync(join(skill, "revisions", "2026-11-14T00-00-00-000Z.md"));
		symlinkSync(outside, join(skill, "revisions", "2026-11-14T00-00-00-000Z.md"));
		expect(() => rollbackSkill(skill)).toThrow("symbolic link");
		expect(readFileSync(outside, "utf8")).toBe("secret");
		expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe("now");
	});

	// qa-l low B #42: the skill directory itself and hard-linked files are links out of the skill too.
	test("a symlinked skill directory or a hard-linked SKILL.md is refused and the target stays untouched", () => {
		const outside = join(dir, "outside.md");
		writeFileSync(outside, "secret");
		mkdirSync(join(skill, "revisions"));
		const slot = join(skill, "revisions", "2026-11-14T00-00-00-000Z.md");
		writeFileSync(slot, "old");
		linkSync(outside, join(skill, "SKILL.md"));
		expect(() => rollbackSkill(skill)).toThrow("hard link");
		expect(readFileSync(outside, "utf8")).toBe("secret");

		const real = join(dir, "managed-skills", "real");
		mkdirSync(join(real, "revisions"), { recursive: true });
		writeFileSync(join(real, "SKILL.md"), "now");
		writeFileSync(join(real, "revisions", "2026-11-14T00-00-00-000Z.md"), "old");
		const linked = join(dir, "managed-skills", "linked");
		symlinkSync(real, linked);
		expect(() => rollbackSkill(linked)).toThrow("symbolic link");
		expect(readFileSync(join(real, "SKILL.md"), "utf8")).toBe("now");
	});

	// qa-l low B #41: a revision slot that cannot be written must leave SKILL.md as it was.
	test("a failed slot write keeps the current SKILL.md", () => {
		writeFileSync(join(skill, "SKILL.md"), "now");
		mkdirSync(join(skill, "revisions"));
		const slot = join(skill, "revisions", "2026-11-14T00-00-00-000Z.md");
		writeFileSync(slot, "old");
		chmodSync(slot, 0o444);
		chmodSync(join(skill, "revisions"), 0o555);
		try {
			expect(() => rollbackSkill(skill)).toThrow();
			expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe("now");
		} finally {
			chmodSync(join(skill, "revisions"), 0o755);
		}
	});
});
