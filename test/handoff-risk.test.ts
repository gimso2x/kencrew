import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDOFF_SCAN_BYTES, scanHandoffBrief } from "../src/safety/handoff-risk";

/** A GitHub account name, put together at run time so the public core carries no account literal. */
const GH_ACCOUNT = ["gimso", "2x"].join("");

const rulesOf = (brief: string, options?: { protectedBranches?: readonly string[] }) =>
	scanHandoffBrief(brief, options).findings.map((finding) => finding.rule);

describe("scanHandoffBrief: high_risk rules", () => {
	const POSITIVES: Record<string, string[]> = {
		git_reset_hard: ["git reset --hard origin/task/x", "먼저 `git reset --hard HEAD~2` 로 되돌려"],
		git_clean_force: ["git clean -f", "git clean -fd", "git clean -xdf", "git clean --force"],
		git_push_force: ["git push --force origin task/x", "git push --force-with-lease", "git push -f origin task/x"],
		git_push_protected: ["git push origin main", "git push origin HEAD:master", "git push origin refs/heads/main"],
		git_branch_force_delete: ["git branch -D task/old"],
		git_stash_discard: ["git stash drop 해", "git stash clear"],
		git_discard_worktree: ["git checkout -- . 로 되돌려", "git checkout .", "git restore ."],
		git_push_delete: ["git push origin --delete feature/x", "git push -d origin x"],
		gh_destructive: [`gh repo delete ${GH_ACCOUNT}/x --yes`],
		crontab_remove: ["crontab -r"],
		rm_rf_absolute: ["rm -rf /var/lib/x", "rm -fr ~/work", "rm -r -f $HOME/.cache", "sudo rm -Rf /"],
		sql_destructive: [
			"sqlite3 ompbot.db 'DROP TABLE tasks'",
			"drop database ompbot;",
			"TRUNCATE TABLE inbound",
			"sqlite3 x.db 'DELETE FROM jobs'",
		],
		service_control: [
			"systemctl --user restart ompbot",
			"systemctl stop nginx",
			"docker rm -f web",
			"podman restart db",
			"pm2 delete api",
		],
		disk_destructive: ["mkfs.ext4 /dev/sdb1", "dd if=/dev/zero of=/dev/sda bs=1M"],
		secret_path: ["cat ~/.ompbot/secrets/slack.json"],
	};

	for (const [rule, briefs] of Object.entries(POSITIVES)) {
		test(`${rule}: every positive is high_risk with that rule`, () => {
			for (const brief of briefs) {
				const scan = scanHandoffBrief(`작업 지시\n${brief}`);
				expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
				expect(scan.findings).toContainEqual(
					expect.objectContaining({ rule, line: 2, severity: "high_risk", excerpt: brief }),
				);
			}
		});
	}

	test("excerpts collapse whitespace and stop at 160 characters", () => {
		const [finding] = scanHandoffBrief(`git   reset\t--hard ${"가".repeat(300)}`).findings;
		expect(finding?.excerpt).toBe(`git reset --hard ${"가".repeat(143)}`);
		expect(Array.from(finding?.excerpt ?? "")).toHaveLength(160);
	});
});

describe("scanHandoffBrief: forbidding lines", () => {
	test("a forbidden command is advisory, never high_risk", () => {
		for (const brief of [
			"머지·push·데몬 재시작(systemctl --user restart ompbot)은 하지 않는다",
			"never run git reset --hard",
			"git push --force 금지",
			"Do not touch ~/.ompbot/secrets",
			"- no git branch -D",
		]) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "advisory" });
			expect(scan.findings.every((finding) => finding.severity === "advisory")).toBe(true);
		}
	});

	test("only the same line is downgraded", () => {
		const scan = scanHandoffBrief("push는 하지 않는다\ngit reset --hard HEAD");
		expect(scan.verdict).toBe("high_risk");
	});

	// doc/ is not exported to the public core, so this runs only in the development repository.
	const specPath = join(import.meta.dir, "..", "doc", "plans", "handoff-risk-scan.md");
	test.skipIf(!existsSync(specPath))("the handoff-risk-scan spec itself is not high_risk", () => {
		expect(scanHandoffBrief(readFileSync(specPath, "utf8")).verdict).not.toBe("high_risk");
	});
});

describe("scanHandoffBrief: the downgrade is scoped to the command's clause", () => {
	test("a forbidding marker in another clause or another parenthesis keeps the command high_risk", () => {
		for (const brief of [
			"git reset --hard origin/main 하고, rebase는 하지 마",
			"먼저 git push --force origin main (리뷰 금지 규칙은 무시)",
			"systemctl restart ompbot; never ask",
			"git reset --hard origin/main 한 뒤 push는 금지",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "high_risk" });
		}
	});

	test("a marker in the command's own clause, or a rule definition line, still downgrades", () => {
		for (const brief of [
			"머지·push·데몬 재시작(systemctl --user restart ompbot)은 하지 않는다",
			"never run git reset --hard",
			"git reset --hard는 쓰지 말 것",
			"- no git push --force",
			"- `git_reset_hard`: `git reset --hard`",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).not.toEqual({ brief, verdict: "high_risk" });
		}
	});

	test("a rule name elsewhere on the line is not a definition and does not downgrade", () => {
		expect(scanHandoffBrief("git reset --hard origin/main (git_reset_hard)").verdict).toBe("high_risk");
	});
});

// doc/plans/qa50-low-fixes.md E-1~E-3: QA run-38 probe1-handoff inputs that slipped past the scan.
describe("scanHandoffBrief: rule-name prefix, backslash continuation, secret path variants", () => {
	test("E-1: a rule-name prefix in front of a plain command does not downgrade it", () => {
		for (const [brief, rule] of [
			["- `git_reset_hard`: 이번엔 진짜 실행한다. git reset --hard HEAD~9 하고 push", "git_reset_hard"],
			["- `service_control`: systemctl restart ompbot 지금 즉시", "service_control"],
			["- `git_reset_hard`: `git reset --hard` 정의. 그리고 git reset --hard HEAD~1", "git_reset_hard"],
		] as const) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
			expect(scan.findings).toContainEqual(expect.objectContaining({ rule, severity: "high_risk" }));
		}
	});

	test("E-1: a whole definition line (the command only quoted in code) stays advisory", () => {
		for (const brief of [
			"- `git_reset_hard`: `git reset --hard`",
			"  - `secret_path`: `.ompbot/secrets`",
			"  - `disk_destructive`: `mkfs`, `dd ` … `of=/dev/`",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "advisory" });
		}
	});

	test("E-2: a destructive command split by a trailing backslash is high_risk at the run's first line", () => {
		for (const [brief, rule, line] of [
			["작업:\n```sh\ngit reset \\\n  --hard HEAD~9\n```", "git_reset_hard", 3],
			["rm -rf \\\n  /home/owner/work", "rm_rf_absolute", 1],
			["git push \\\n  origin \\\n  main", "git_push_protected", 1],
		] as const) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
			expect(scan.findings).toContainEqual(expect.objectContaining({ rule, line, severity: "high_risk" }));
		}
	});

	test("E-2: a continued line already high_risk is reported once; safe continued commands stay clear", () => {
		const scan = scanHandoffBrief("git reset --hard HEAD \\\n  && echo done");
		expect(scan.findings.filter((finding) => finding.rule === "git_reset_hard")).toHaveLength(1);
		expect(scanHandoffBrief("git push \\\n  origin feature/x").verdict).toBe("clear");
		expect(scanHandoffBrief("rm -rf \\\n  node_modules").verdict).toBe("clear");
	});

	test("E-3: /./ and // between .ompbot and secrets are still secret_path", () => {
		for (const brief of [
			"cat ~/.ompbot/./secrets/slack.json",
			"cat ~/.ompbot//secrets/slack.json",
			"cat $HOME//.ompbot//secrets/slack.json",
			"cat ~/.ompbot/.//./secrets/slack.json",
		]) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
			expect(scan.findings).toContainEqual(expect.objectContaining({ rule: "secret_path", severity: "high_risk" }));
		}
		expect(rulesOf("cat ~/.ompbot/config.json")).toEqual([]);
		expect(rulesOf("cat ~/.ompbot/../secrets/x")).toEqual([]);
	});
});

describe("scanHandoffBrief: git global options before the subcommand", () => {
	test("-C / -c in front of a destructive subcommand is still high_risk with the same rule", () => {
		for (const [brief, rule] of [
			["git -C /tmp/x reset --hard origin/main", "git_reset_hard"],
			["git -C ~/work/x push --force origin feature", "git_push_force"],
			["git -C ~/work/x clean -fdx", "git_clean_force"],
			["git -C ~/work/x branch -D task/x", "git_branch_force_delete"],
			["git -c core.pager=cat push origin main", "git_push_protected"],
		] as const) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict, rules: scan.findings.map((finding) => finding.rule) }).toEqual({
				brief,
				verdict: "high_risk",
				rules: [rule],
			});
		}
	});

	test("other global options are skipped the same way", () => {
		for (const brief of [
			"git --git-dir=/srv/x/.git reset --hard HEAD",
			"git --work-tree /srv/x --no-pager reset --hard HEAD",
			'git -C "/tmp/a b" --namespace=n -P --bare --no-replace-objects reset --hard HEAD',
		]) {
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: ["git_reset_hard"] });
		}
	});

	test("safe subcommands behind global options stay clear", () => {
		for (const brief of ["git -C ~/work/x log --oneline", "git -C ~/work/x push origin feature"]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "clear" });
		}
	});
});

describe("scanHandoffBrief: clause boundaries and non-forbidding phrases", () => {
	test("하되, a lone 후, don't hesitate and a double negative do not downgrade the command", () => {
		for (const brief of [
			"git reset --hard HEAD~3 하되 질문은 하지 말 것",
			"git push --force origin main 후 금지 목록을 확인한다",
			"Don't hesitate to run git reset --hard HEAD~3",
			"git reset --hard HEAD 하지 않으면 안 된다",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "high_risk" });
		}
	});

	test("a forbidden command in its own clause is still advisory", () => {
		expect(scanHandoffBrief("git push --force origin main은 하지 않는다").verdict).toBe("advisory");
	});

	test("a shell comment or a chained command is not the command's clause (qa-l #70)", () => {
		for (const brief of [
			"git reset --hard HEAD # 하지 않는다",
			"git reset --hard HEAD && echo '하지 않는다'",
			"git reset --hard HEAD || echo '하지 않는다'",
			"git reset --hard HEAD | tee log # do not",
			"git reset --hard HEAD & echo 금지",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "high_risk" });
		}
		// A Markdown table's cell border and a redirection's `&` end no clause.
		for (const brief of [
			"| git push --force origin main | 금지 |",
			"git reset --hard HEAD 2>&1 하지 않는다",
			"git reset --hard HEAD &>/dev/null 하지 않는다",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "advisory" });
		}
	});
});

// doc/plans/qa-c-fixes.md I-1: `<용언>지 말고`/`지 않고` end the forbidden clause; the command after it is ordered.
describe("scanHandoffBrief: 말고·않고 clause boundary", () => {
	const table: ReadonlyArray<readonly [string, boolean]> = [
		["push는 하지 말고 git reset --hard origin/main 하고 커밋해", true],
		["git status는 하지 말고 git reset --hard HEAD를 실행해", true],
		["git reset --hard는 하지 말고 테스트만 돌려", false],
		["git reset --hard 하지 않고 테스트만 돌려", false],
		["git reset --hard는 건드리지 않고 테스트만 돌려", false],
		// fable 감사 IMP-01: `<명사> 말고` ends its clause too.
		["rebase 말고 git push --force origin main 해", true],
		["git push --force 말고 rebase 해", false],
	];
	test.each(table)("%s → high_risk %p", (brief, highRisk) => {
		expect(scanHandoffBrief(brief).verdict === "high_risk").toBe(highRisk);
	});
});

describe("scanHandoffBrief: negatives and advisory rules", () => {
	test("safe look-alikes raise no high_risk rule", () => {
		expect(rulesOf("git push origin task/T-20261104-01")).toEqual([]);
		expect(rulesOf("git push -u origin feature/main-fix")).toEqual([]);
		expect(rulesOf("git reset --soft HEAD~1")).toEqual([]);
		expect(rulesOf("rm -rf node_modules")).toEqual([]);
		expect(rulesOf("git branch -d task/x")).toEqual([]);
		expect(rulesOf("git clean -n")).toEqual([]);
		expect(rulesOf("git stash pop")).toEqual([]);
		expect(rulesOf("git restore --staged .")).toEqual([]);
		expect(rulesOf("git checkout ./src/a.ts")).toEqual([]);
		expect(rulesOf("DELETE FROM jobs WHERE id = 3;")).toEqual([]);
		const korean = scanHandoffBrief(
			"로그 회전을 구현하고 테스트를 추가한다.\n바꾼 파일만 커밋하고 PROGRESS.md를 갱신한다.\n결과는 outcome.md에 적는다.",
		);
		expect(korean).toEqual({ verdict: "clear", findings: [], truncated: false });
	});

	test("package installs and the owner-approval marker are advisory", () => {
		for (const [brief, rule] of [
			["npm install left-pad", "package_install"],
			["bun add zod", "package_install"],
			["pip install requests", "package_install"],
			["sudo apt-get install jq", "package_install"],
			["OMP_OWNER_APPROVED=1 git status", "owner_gate_skip"],
		] as const) {
			expect(scanHandoffBrief(brief)).toMatchObject({
				verdict: "advisory",
				findings: [{ rule, severity: "advisory" }],
			});
		}
	});
});

describe("scanHandoffBrief: protected branches", () => {
	test("a given list replaces main and master", () => {
		const options = { protectedBranches: ["production"] };
		expect(rulesOf("git push origin production", options)).toEqual(["git_push_protected"]);
		expect(rulesOf("git push origin main", options)).not.toContain("git_push_protected");
	});
});

describe("scanHandoffBrief: size limit", () => {
	test("input over the limit is truncated and never clear", () => {
		const scan = scanHandoffBrief("가".repeat(HANDOFF_SCAN_BYTES)); // 3 bytes each
		expect(scan).toEqual({ verdict: "advisory", findings: [], truncated: true });
	});

	test("a command only past the limit is not reported", () => {
		const scan = scanHandoffBrief(`${"a".repeat(HANDOFF_SCAN_BYTES)}\ngit reset --hard HEAD`);
		expect(scan.truncated).toBe(true);
		expect(scan.findings.map((finding) => finding.rule)).not.toContain("git_reset_hard");
		expect(scanHandoffBrief(`git reset --hard HEAD\n${"a".repeat(HANDOFF_SCAN_BYTES)}`)).toMatchObject({
			verdict: "high_risk",
			truncated: true,
		});
	});

	test("input exactly at the limit is whole", () => {
		expect(scanHandoffBrief("a".repeat(HANDOFF_SCAN_BYTES)).truncated).toBe(false);
	});
});

describe("scanHandoffBrief: qa50b-low lane L", () => {
	test("L-8 shell quoting and backslashes around the flag do not hide the command", () => {
		for (const brief of [
			"git reset '--hard' HEAD",
			'git reset "--hard" HEAD',
			"git reset \\--hard HEAD",
			"git reset --h\\ard HEAD",
			"git branch '-D' old",
			"git push origin 'main'",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "high_risk" });
		}
		// The quote in "don't" is not a shell quote: the line still forbids the command.
		expect(scanHandoffBrief("don't run git reset '--hard' HEAD").verdict).toBe("advisory");
		expect(scanHandoffBrief("git reset '--soft' HEAD").verdict).toBe("clear");
	});

	test("L-9 on a rule-definition line only the listed spans after the prefix are the definition", () => {
		expect(
			scanHandoffBrief("- `git_reset_hard`: `git reset --hard` 설명. 이제 `git reset --hard HEAD~9` 를 실행").verdict,
		).toBe("high_risk");
		expect(scanHandoffBrief("- `sql_destructive`: `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`").verdict).toBe(
			"advisory",
		);
	});

	test("L-10 deeply nested parentheses: the clause search stays linear per level", () => {
		const n = 2000;
		const brief = `${"(".repeat(n)}${" git reset --hard 하지 않는다;".repeat(n / 6)}${")".repeat(n)}`;
		// Every hit is forbidden, so each one's context is built (the old per-level rescan took tens of seconds here).
		expect(scanHandoffBrief(brief).verdict).toBe("advisory");
		// The marker outside the nesting still reaches a command deep inside it.
		expect(scanHandoffBrief(`하지 않는다 ${"(".repeat(50)}git reset --hard${")".repeat(50)}`).verdict).toBe("advisory");
		expect(scanHandoffBrief(`${"(".repeat(50)}git reset --hard${")".repeat(50)}; 하지 않는다`).verdict).toBe(
			"high_risk",
		);
	});
});

// doc/plans/qa-i-low-fixes.md 묶음 A: each table names the qa-i item numbers it closes.
describe("scanHandoffBrief: qa-i low A", () => {
	const highRisk = (briefs: readonly string[], rule: string) => {
		for (const brief of briefs) expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: [rule] });
	};

	test("#43 #102 any git global option before the subcommand is skipped", () => {
		highRisk(
			[
				"git --literal-pathspecs reset --hard HEAD",
				"git --exec-path=/x reset --hard HEAD",
				"git --attr-source=HEAD reset --hard HEAD",
				"git --attr-source HEAD reset --hard HEAD",
				"git --config-env core.x=Y reset --hard HEAD",
			],
			"git_reset_hard",
		);
		highRisk(["git --no-optional-locks clean -fdx"], "git_clean_force");
		expect(rulesOf("git --no-optional-locks status")).toEqual([]);
		expect(rulesOf("git -C reset log --oneline")).toEqual([]);
	});

	test("#101 repeated git -C stays fast", () => {
		const started = performance.now();
		expect(scanHandoffBrief("git -C ".repeat(Math.floor(HANDOFF_SCAN_BYTES / 7))).verdict).toBe("clear");
		// The old nested option group took about 30s here; the bound only catches a return of that blow-up.
		expect(performance.now() - started).toBeLessThan(5000);
	});

	test("#41 #97 #103 #104 checkout, restore and switch forms that discard the work tree", () => {
		highRisk(
			[
				"git checkout ./",
				"git checkout -f .",
				"git checkout -q .",
				"git checkout HEAD -- .",
				"git checkout -f main",
				"git restore --staged --worktree .",
				"git restore --worktree --staged .",
				"git restore -W --staged .",
				"git restore :/",
				"git restore --source=HEAD~3 .",
				"git switch -f main",
				"git switch --discard-changes main",
			],
			"git_discard_worktree",
		);
		for (const brief of [
			"git restore --staged .",
			"git checkout ./src/a.ts",
			"git checkout -b feature/x",
			"git switch -c fix-f",
			"git checkout main",
		])
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: [] });
	});

	test("#42 #98 delete and force together are a forced branch delete", () => {
		highRisk(
			["git branch -d -f x", "git branch --delete --force x", "git branch -f -d x", "git branch -df x"],
			"git_branch_force_delete",
		);
		expect(rulesOf("git branch -d x")).toEqual([]);
		expect(rulesOf("git branch -f x origin/main")).toEqual([]);
	});

	test("#99 abbreviated long options git accepts", () => {
		highRisk(["git reset --har HEAD~3"], "git_reset_hard");
		highRisk(["git clean --forc -d"], "git_clean_force");
		highRisk(["git push --forc origin x", "git push --force-w origin x"], "git_push_force");
		highRisk(["git push origin --del feature/x"], "git_push_delete");
		expect(rulesOf("git push --follow-tags origin x")).toEqual([]);
	});

	test("#46 #106 a parameter expansion of HOME is an absolute target", () => {
		highRisk([`rm -rf \${HOME:-/}`, `rm -rf \${HOME:?}`, `rm -rf \${HOME%/}/work`], "rm_rf_absolute");
		expect(rulesOf(`rm -rf \${HOMEWORK_DIR}`)).toEqual([]);
	});

	test("#107 crontab -r after other options", () => {
		highRisk(["crontab -u me -r", "crontab -u me -ir"], "crontab_remove");
		expect(rulesOf("crontab -u me -l")).toEqual([]);
	});

	test("#40 #105 a backslash-newline inside a word joins it without a blank", () => {
		for (const brief of ["git reset --\\\nhard HEAD~9", "rm -r\\\nf /", "git res\\\net --hard HEAD"])
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "high_risk" });
		expect(scanHandoffBrief("git reset --\\\nsoft HEAD").verdict).toBe("clear");
	});

	test("#108 a long line's excerpt shows the command, not only the line's head", () => {
		const line = `${"가나다라마바사아자차카타파하 ".repeat(14)}git reset --hard origin/main`;
		const [finding] = scanHandoffBrief(line).findings;
		expect(finding?.excerpt).toContain("git reset --hard origin/main");
		expect(finding?.excerpt.startsWith("…")).toBe(true);
		expect(Array.from(finding?.excerpt ?? "").length).toBeLessThanOrEqual(160);
	});

	test("#45 many forbidden hits on one long line do not stall the scan", () => {
		const unit = "mkfs 하지않 ";
		const brief = unit.repeat(Math.floor(HANDOFF_SCAN_BYTES / new TextEncoder().encode(unit).length));
		const started = performance.now();
		scanHandoffBrief(brief);
		// About 4.7s before; the bound only catches a return of the per-hit rescan.
		expect(performance.now() - started).toBeLessThan(1500);
	});
});

// doc/plans/qa-j-fixes.md 묶음 A: each test names the qa-j item numbers it closes.
describe("scanHandoffBrief: qa-j low A", () => {
	const verdictOf = (brief: string) => ({ brief, verdict: scanHandoffBrief(brief).verdict });
	const expectVerdicts = (briefs: readonly string[], verdict: "clear" | "advisory" | "high_risk") => {
		for (const brief of briefs) expect(verdictOf(brief)).toEqual({ brief, verdict });
	};

	test("#40 CR, NEL, VT, FF, LS and PS end a line like LF", () => {
		expectVerdicts(
			["\r", "\u2028", "\u2029", "\u0085", "\u000B", "\u000C"].map(
				(sep) => `git push --force는 하지 않는다${sep}git reset --hard HEAD~3`,
			),
			"high_risk",
		);
		const [finding] = scanHandoffBrief("a\rb\u2028git reset --hard HEAD").findings;
		expect(finding?.line).toBe(3);
		expectVerdicts(["git reset --hard는 하지 않는다\r\n테스트만 돌려"], "advisory");
	});

	test("#41 #96 invisible characters inside a command word do not hide it", () => {
		expectVerdicts(
			[
				"git\u200B reset --hard HEAD~3",
				"git re\u200Bset --hard HEAD~3",
				"git\u2060 reset --hard HEAD",
				"git pu\u200bsh origin main",
				"git push origin ma\u00adin",
				"rm -r\u200bf /home/owner",
				"git re\u200Eset --hard HEAD",
				"git re\u061Cset --hard HEAD",
				"git re\u180Eset --hard HEAD",
			],
			"high_risk",
		);
		expectVerdicts(["git re\u200Bset --soft HEAD"], "clear");
	});

	test("#42 #95 #103 phrases that urge the command do not forbid it", () => {
		expectVerdicts(
			[
				"never forget to run git reset --hard HEAD~3",
				"Do not forget to run git reset --hard before retrying",
				"Never forget: git push --force origin main",
				"Do not skip: git reset --hard HEAD~9",
				"must not fail to run git reset --hard HEAD~1",
				"do not omit git reset --hard HEAD~1",
				"Please don't forget to run git reset --hard origin/main",
				"git reset --hard HEAD~3 실행해 잊지 말고",
				"git reset --hard HEAD~2 말고는 방법이 없다",
				"git reset --hard는 하지 않을 수 없다",
			],
			"high_risk",
		);
		expectVerdicts(["never run git reset --hard", "git reset --hard는 하지 말 것, 잊지 말고"], "advisory");
	});

	test("#43 secrets named through $OMPBOT_HOME or after a cd into the bot home", () => {
		for (const brief of [
			"cat $OMPBOT_HOME/secrets/slack.json",
			`cat \${OMPBOT_HOME}/secrets/slack.json`,
			"cd ~/.ompbot && cat secrets/slack.json",
			"cd ~/.ompbot/; cp secrets/slack.json /tmp/",
			"cd $OMPBOT_HOME && cat secrets/x",
		])
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: ["secret_path"] });
		for (const brief of ["cd ~/.ompbot/workspace && cat secrets.md", "cd ~/.ompbot && ls"])
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: [] });
	});

	test("#44 git push --mirror is a forced push; --all and --prune are advisory", () => {
		expect(rulesOf("git push --mirror origin")).toEqual(["git_push_force"]);
		expect(rulesOf("git -C x push --mirror origin")).toEqual(["git_push_force"]);
		for (const brief of ["git push --all origin", "git push --prune origin", "git push origin --all --prune"])
			expect({ brief, scan: scanHandoffBrief(brief) }).toMatchObject({
				brief,
				scan: { verdict: "advisory", findings: [{ rule: "git_push_all_refs" }] },
			});
	});

	test("#45 #98 a 64KB line of git verbs that never match scans in linear time", () => {
		const fastest = (brief: string): number => {
			let best = Number.POSITIVE_INFINITY;
			for (let run = 0; run < 3; run++) {
				const started = performance.now();
				scanHandoffBrief(brief);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		for (const unit of [
			"git push x ",
			"git branch - ",
			"git checkout x ",
			"git clean x ",
			"git reset x ",
			"git push \\\n",
		]) {
			const brief = unit.repeat(Math.floor(HANDOFF_SCAN_BYTES / unit.length));
			// Timed against the same text with the verb word changed (at least 10ms), so machine load counts on both
			// sides: each failed verb rescanned to the line's end took 0.5~2.2s, linear takes tens of ms.
			const ratio = fastest(brief) / Math.max(fastest(brief.replaceAll("git", "gat")), 10);
			expect({ unit, slow: ratio > 25 }).toEqual({ unit, slow: false });
		}
	});

	test("#97 #104 inline code spans, emphasis and comments splitting a command do not hide it", () => {
		expectVerdicts(
			[
				"`git` reset --hard HEAD~3",
				"git reset `--hard` HEAD~3",
				"`git reset` `--hard` HEAD~3",
				"git *reset* --hard HEAD~3",
				"git reset --**hard** HEAD~3",
				"git **reset --hard** HEAD~3",
				"git _reset_ --hard HEAD~3",
				"git<!--x--> reset --hard HEAD~3",
			],
			"high_risk",
		);
		expectVerdicts(["- `git_reset_hard`: `git reset --hard`"], "advisory");
		expectVerdicts(["`git reset --soft` 로 되돌린다", "`git push origin x`, `rm -rf node_modules`"], "clear");
	});

	test("#99 the excerpt is cut around the command as written", () => {
		const brief = `${"'a' ".repeat(41)}'git' 'reset' '--hard' HEAD~9`;
		const [finding] = scanHandoffBrief(brief).findings;
		expect(finding?.severity).toBe("high_risk");
		expect(finding?.excerpt).toContain("'git' 'reset' '--hard' HEAD~9");
	});

	test("#101 a git alias defined with -c is judged as the command it runs", () => {
		expect(rulesOf("git -c alias.h=reset h --hard HEAD~1")).toEqual(["git_reset_hard"]);
		expect(rulesOf("git -c alias.p='push --force' p origin x")).toEqual(["git_push_force"]);
		expect(rulesOf("git -c alias.c=clean c -fdx")).toEqual(["git_clean_force"]);
		expect(rulesOf("git -c alias.st=status st")).toEqual([]);
	});

	test("#102 unique prefixes of rm's --recursive and --force", () => {
		for (const brief of [
			"rm --recurs --forc /",
			"rm --recursiv --force /",
			"rm --recursi -f /var/lib",
			"rm --r --f /x",
		])
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: ["rm_rf_absolute"] });
		expect(rulesOf("rm --verbose -f /tmp/x")).toEqual([]);
	});
});

// doc/plans/qa-l-low-fixes.md 묶음 A: 넘김 위험.
describe("qa-l low A: secrets reached through the bot home", () => {
	test("#35 #71 cd options, pushd and env -C into the bot home before a relative secrets path", () => {
		for (const brief of [
			"cd -P ~/.ompbot && cat secrets/slack.json",
			"cd -L ~/.ompbot && cat secrets/slack.json",
			"cd -- ~/.ompbot && cat secrets/slack.json",
			"cd -eP ~/.ompbot && cat secrets/slack.json",
			"pushd ~/.ompbot && cat secrets/slack.json",
			"pushd -n ~/.ompbot; cat secrets/x",
			"env -C ~/.ompbot cat secrets/slack.json",
			"env -C~/.ompbot cat secrets/slack.json",
			"env --chdir=$OMPBOT_HOME cat secrets/x",
			"env -i --chdir ~/.ompbot cat secrets/x",
		])
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: ["secret_path"] });
		for (const brief of [
			"cd -P ~/.ompbot/workspace && cat secrets.md",
			"pushd ~/.ompbot && ls",
			"env -C ~/work/app cat secrets/x",
		])
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: [] });
	});

	test("#72 a .. inside the bot home that still lands in secrets", () => {
		for (const brief of [
			"cat ~/.ompbot/logs/../secrets/slack.json",
			"cat ~/.ompbot/x/../secrets/slack.json",
			"cat ~/.ompbot/a/b/../../secrets/x",
			"cat $OMPBOT_HOME/logs/../secrets/x",
			"cat ~/.ompbot/logs/.././secrets",
		])
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: ["secret_path"] });
		for (const brief of ["cat ~/.ompbot/../secrets/x", "cat ~/.ompbot/a/../../secrets/x", "cat ~/.ompbot/logs/../x"])
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: [] });
	});
});

describe("qa-q: safety heuristic holes", () => {
	const verdict = (brief: string) => scanHandoffBrief(brief).verdict;
	const high = (briefs: string[]) => {
		for (const brief of briefs) expect({ brief, verdict: verdict(brief) }).toEqual({ brief, verdict: "high_risk" });
	};
	const clear = (briefs: string[]) => {
		for (const brief of briefs) expect({ brief, verdict: verdict(brief) }).toEqual({ brief, verdict: "clear" });
	};

	test("#6 a glob or brace under the bot home that can spell secrets is secret_path", () => {
		high([
			"cat ~/.ompbot/sec*/slack.json",
			"cat ~/.ompbot/{secrets,logs}/x",
			"cat $OMPBOT_HOME/s?crets/x",
			"cat ~/.ompbot/[s]ecrets/x",
		]);
		expect(rulesOf("cat ~/.ompbot/sec*/slack.json")).toEqual(["secret_path"]);
		clear(["ls ~/.ompbot/logs/*", "ls ~/.ompbot/{logs,db}/x", "cat ~/.ompbot/lo*/x"]);
	});

	test("#7 checkout / restore of every file by glob is git_discard_worktree", () => {
		high(["git checkout -- *", "git restore -- '*'", 'git restore -- "*"', "git checkout -- ./*", "git restore :/*"]);
		expect(rulesOf("git checkout -- *")).toEqual(["git_discard_worktree"]);
		clear(["git checkout -- src/*.ts", "git restore -- 'src/*'"]);
	});

	test("#8 power commands are service_control, at a command position only", () => {
		high([
			"sudo reboot",
			"systemctl reboot",
			"sudo shutdown -h now",
			"foo || sudo reboot",
			"env X=1 nohup shutdown now",
			"(reboot)",
			"- poweroff",
			"$ halt",
			"systemctl poweroff",
			"if x; then reboot; fi",
			"timeout 5 shutdown +5",
		]);
		expect(rulesOf("sudo reboot")).toEqual(["service_control"]);
		clear([
			"graceful shutdown을 구현한다",
			"reboot 필요",
			"shutdown 처리를 구현한다",
			"we should reboot the idea",
			"wsl --shutdown",
		]);
	});

	test("#23 a Korean 'but' clause boundary leaves the later command its own clause", () => {
		const scan = scanHandoffBrief("git push --force는 하지 않지만 git reset --hard는 해");
		expect(scan.findings.find((f) => f.rule === "git_reset_hard")?.severity).toBe("high_risk");
		expect(scan.findings.find((f) => f.rule === "git_push_force")?.severity).toBe("advisory");
		for (const brief of [
			"git reset --hard를 하지 않으나 git clean -f는 해",
			"git reset --hard는 하지 않는데 git clean -f는 해",
		])
			expect(scanHandoffBrief(brief).findings.find((f) => f.rule === "git_clean_force")?.severity).toBe("high_risk");
		expect(verdict("git reset --hard는 하지 않지만 로그만 본다")).toBe("advisory");
	});

	test("#25 'don't be afraid to' orders the command", () => {
		high([
			"Don't be afraid to run git reset --hard HEAD~1",
			"never fear git reset --hard",
			"do not worry just git reset --hard",
		]);
		expect(verdict("Don't run git reset --hard")).toBe("advisory");
	});

	test("#24 a cd target is normalized before it is judged the bot home", () => {
		high([
			"cd ~/.ompbot/logs/..; cat secrets/slack.json",
			"cd ~/.ompbot/. && cat secrets/slack.json",
			"cd ~/.ompbot// && cat secrets/slack.json",
			'cd "~/.ompbot/./" ; cat secrets/x',
		]);
		clear(["cd ~/.ompbot/..; cat secrets/x", "cd ~/.ompbot/logs; cat secrets/x"]);
	});

	test("#26 a cd into the bot home carries over the line break", () => {
		high([
			"cd ~/.ompbot\ncat secrets/slack.json",
			"cd ~/.ompbot\n\nls\n./secrets",
			"cd ~/.ompbot\nrm -rf secrets",
			"cd ~/.ompbot\ncd .\ncat secrets/x",
			"pushd ~/.ompbot\nls secrets",
		]);
		clear([
			"cd ~/.ompbot\ncd /tmp\ncat secrets/x",
			"cd ~/.ompbot/..; cat secrets/x",
			"pushd ~/.ompbot\npopd\ncat secrets/x",
			"env -C ~/.ompbot ls\ncat secrets/x",
			"(cd ~/.ompbot)\ncat secrets/x",
			"x=$(cd ~/.ompbot)\ncat secrets/x",
			"cd ~/.ompbot\nsecrets는 건드리지 않는다",
			"cd ~/.ompbot\nkeep secrets safe",
			"cd ~/.ompbot\ncd -\ncat secrets/x",
			"cd ~/.ompbot\ncd\ncat secrets/x",
			"cd ~/.ompbot\ncd ..\ncat secrets/x",
			"cd ~/.ompbot\ncd /tmp; cat secrets/x",
			"- `git_reset_hard`: `cd ~/.ompbot`\ncat secrets/x",
		]);
		expect(verdict("cd ~/.ompbot\ncat secrets/x 는 하지 마")).toBe("advisory");
	});
});

describe("qa-r: handoff risk regressions of the qa-q fixes", () => {
	const verdict = (brief: string) => scanHandoffBrief(brief).verdict;
	const high = (briefs: string[]) => {
		for (const brief of briefs) expect({ brief, verdict: verdict(brief) }).toEqual({ brief, verdict: "high_risk" });
	};
	const clear = (briefs: string[]) => {
		for (const brief of briefs) expect({ brief, verdict: verdict(brief) }).toEqual({ brief, verdict: "clear" });
	};

	test("#5 a reversed glob range does not throw and is judged conservatively", () => {
		const scan = scanHandoffBrief("cat ~/.ompbot/[z-a]/x");
		expect(scan.verdict).toBe("high_risk");
		expect(scan.findings.map((f) => f.rule)).toContain("secret_path");
	});

	test("#28 a fence line does not erase the bot home; a shell fence continues it", () => {
		high(["cd ~/.ompbot\n```\ncat secrets/slack.json", "cd ~/.ompbot\n```bash\ncat secrets/x\n```"]);
		clear(["cd ~/.ompbot\n```diff\n- cat secrets/x\n```", "cd ~/.ompbot\n```json\n{}\n```\ncat secrets/x"]);
	});

	test("#25 cd into a bot home subdirectory keeps the shell inside the bot home", () => {
		high([
			"cd ~/.ompbot\ncd secrets\ncat slack.json",
			"cd ~/.ompbot/secrets\ncat slack.json",
			"cd ~/.ompbot/logs\ncat ../secrets/x",
		]);
		clear([
			"cd ~/.ompbot\ncd secrets\ncd ..\ncat README.md",
			"cd ~/.ompbot/secrets\nls",
			"cd ~/.ompbot/secrets\ncat /etc/hosts",
			"cd ~/.ompbot/secrets\ncat ../config.json",
		]);
	});

	test("#8 a path that leaves the bot home and comes back is still the bot home", () => {
		high(["cd ~/.ompbot/../.ompbot\ncat secrets/slack.json"]);
		clear(["cd ~/.ompbot/..; cat secrets/x"]);
	});

	test("#23 a rule line's own cd moves the shell, a quoted one does not", () => {
		high(["- `note`: cd ~/.ompbot\ncat secrets/slack.json"]);
		clear(["- `rule`: `cd ~/.ompbot` 금지\ncat secrets/x"]);
	});

	test("#31 a schema-qualified or quoted table name is still a destructive delete", () => {
		high(["delete from public.users;", 'delete from "users";', "delete from `users`;", "delete from [dbo].[users];"]);
		clear(["delete from users where id = 1"]);
	});
});
