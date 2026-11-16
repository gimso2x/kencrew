/**
 * Handoff risk scan: before a brief goes to an unattended herdr worker, look for irreversible commands in it.
 * Pure — reads no files, git or network. A command in a clause that forbids it ("…은 하지 않는다", "never …") is a
 * normal worker instruction and only counts as advisory; a marker in another clause or parenthesis does not count.
 */

import { posix } from "node:path";
import { INVISIBLE } from "./injection";

export type HandoffVerdict = "clear" | "advisory" | "high_risk";
export interface HandoffFinding {
	rule: string;
	line: number;
	excerpt: string;
	severity: "advisory" | "high_risk";
}
export interface HandoffScan {
	verdict: HandoffVerdict;
	findings: HandoffFinding[];
	truncated: boolean;
}

export const HANDOFF_SCAN_BYTES = 65536;
const EXCERPT_CHARS = 160;
/** Characters an excerpt keeps before a command that lies past its head. */
const EXCERPT_LEAD = 80;
const DEFAULT_PROTECTED_BRANCHES = ["main", "master"] as const;

/** The rest of a shell command after its verb: up to the next `;`, `&`, `|`, or the end of an inline code span. */
const SEGMENT = "[^;&|`\\n]*";

/**
 * One argument of a git global option: a quoted string holding a blank, or a word without whitespace or a command
 * separator (a quoted string without a blank is such a word too, so no argument has two readings).
 */
const GIT_OPTION_ARG = "(?:\"[^\"`\\s]*\\s[^\"`\\n]*\"|'[^'`\\s]*\\s[^'`\\n]*'|[^\\s;&|`]+)";
/** git global options that may take their value as the next word (`-C <dir>`, `--git-dir <dir>`), past their `-`. */
const GIT_ARG_OPTION_NAME = "(?:[Cc]|-(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source))";
/**
 * `git` and the global options before its subcommand (`git -C <dir> reset …`): one that takes the next word, or any
 * other word starting with `-` (`--literal-pathspecs`, `--exec-path=/x`), so an option missing from a list does not
 * hide the subcommand. The bare word never matches an option taking an argument, so every option run has one reading.
 */
const GIT_GLOBAL_OPTION_RUN = new RegExp(
	`\\bgit((?:\\s+(?:-${GIT_ARG_OPTION_NAME}\\s+${GIT_OPTION_ARG}|-(?!${GIT_ARG_OPTION_NAME}(?=\\s|$))[^\\s;&|\`]+))*)`,
	"gi",
);

/**
 * `text` with the global options after every `git` blanked out (newlines kept), so `git -C <dir> reset --hard` reads
 * as `git reset --hard` at the same indices. One left-to-right pass: the git rules need no option group of their
 * own, which re-walked a long option run from every `git` in it.
 */
export function blankGitGlobalOptions(text: string): string {
	return text.replace(
		GIT_GLOBAL_OPTION_RUN,
		(match: string, options: string) => `${match.slice(0, 3)}${options.replace(/[^\n]/g, " ")}`,
	);
}

/** `git branch` delete and force flags, case-sensitive: `-d` alone is the safe delete. */
const BRANCH_DELETE = "(?:--delete|-[a-zA-Z]*d[a-zA-Z]*)(?![\\w-])";
const BRANCH_FORCE = "(?:--force|-[a-zA-Z]*f[a-zA-Z]*)(?![\\w-])";

/** `--staged` anywhere later in the command: a `git restore` naming it leaves the work tree alone. */
const RESTORE_STAGED = "[^;&|`\\n]*--staged";

/**
 * One pattern rule. A rule with a `verb` starts every match with it (`git reset`) and reads the rest of the command
 * after it (`SEGMENT`): a later occurrence of the same verb in the same command sees only part of what an earlier one
 * saw, so once one fails the rest of that command is skipped for that verb (`ruleMatches`).
 */
interface PatternRule {
	rule: string;
	pattern: RegExp;
	/** The pattern's own start, with the verb word as its one group. */
	verb?: RegExp;
}

// Long options are matched with the unique prefixes git accepts too (`--har`, `--forc`, `--del`, `--mir`).
const HIGH_RISK_PATTERNS: readonly PatternRule[] = [
	{
		rule: "git_reset_hard",
		pattern: new RegExp(`\\bgit\\s+reset\\b${SEGMENT}\\s--ha(?:rd?)?(?![\\w-])`, "i"),
		verb: /\bgit\s+(reset)\b/i,
	},
	{
		rule: "git_clean_force",
		pattern: new RegExp(`\\bgit\\s+clean\\b${SEGMENT}\\s(?:-[a-z]*f[a-z]*|--f(?:o(?:r(?:ce?)?)?)?)(?![\\w-])`, "i"),
		verb: /\bgit\s+(clean)\b/i,
	},
	// `--mirror` rewrites and deletes every remote ref to match the local ones.
	{
		rule: "git_push_force",
		pattern: new RegExp(
			`\\bgit\\s+push\\b${SEGMENT}\\s(?:--for(?:c(?:e(?:-[\\w-]*)?)?)?|--mi(?:r(?:r(?:or?)?)?)?|-[a-z]*f[a-z]*)(?![\\w-])`,
			"i",
		),
		verb: /\bgit\s+(push)\b/i,
	},
	// `-D`, or delete and force together in one word (`-df`) or two (`-d -f`, `--delete --force`); only the verb
	// ignores case. The two words are looked for once from the verb, each by a lookahead, so no word is tried as the
	// first of a pair against every later one.
	{
		rule: "git_branch_force_delete",
		pattern: new RegExp(
			`\\b[gG][iI][tT]\\s+[bB][rR][aA][nN][cC][hH]\\b(?:${SEGMENT}\\s(?:-[a-zA-Z]*D|-[a-zA-Z]*(?:d[a-zA-Z]*f|f[a-zA-Z]*d)[a-zA-Z]*(?![\\w-]))|(?=${SEGMENT}\\s${BRANCH_DELETE})(?=${SEGMENT}\\s${BRANCH_FORCE})${SEGMENT}\\s(?:${BRANCH_DELETE}|${BRANCH_FORCE}))`,
		),
		verb: /\b[gG][iI][tT]\s+([bB][rR][aA][nN][cC][hH])\b/,
	},
	{ rule: "git_stash_discard", pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i },
	// A forced checkout or switch, or a checkout / restore of the whole tree (`.`, `./`, `:/`); a restore that names
	// only `--staged` leaves the work tree alone unless `--worktree` / `-W` comes with it.
	{
		rule: "git_discard_worktree",
		pattern: new RegExp(
			`\\bgit\\s+(?:(?:checkout|switch)\\b${SEGMENT}\\s(?:-[a-z]*f[a-z]*|--force|--discard-changes)(?![\\w-])|(?:checkout\\b|restore\\b(?:(?=${SEGMENT}\\s(?:--worktree|-[a-z]*w[a-z]*)(?![\\w-]))|(?!${RESTORE_STAGED})))${SEGMENT}\\s(?:\\.\\/?|:\\/\\.?)(?=\\s|$|[;&|\`]))`,
			"i",
		),
		verb: /\bgit\s+(checkout|switch|restore)\b/i,
	},
	{
		rule: "git_push_delete",
		pattern: new RegExp(`\\bgit\\s+push\\b${SEGMENT}\\s(?:--de(?:l(?:e(?:te?)?)?)?|-d)(?![\\w-])`, "i"),
		verb: /\bgit\s+(push)\b/i,
	},
	{ rule: "gh_destructive", pattern: /\bgh\s+repo\s+delete\b/i },
	{
		rule: "crontab_remove",
		pattern: new RegExp(`\\bcrontab\\b${SEGMENT}\\s-[a-z]*r[a-z]*(?![\\w-])`, "i"),
		verb: /\b(crontab)\b/i,
	},
	{
		rule: "sql_destructive",
		pattern: /\b(?:drop\s+(?:table|database)|truncate\s+table|delete\s+from\s+\w+\s*(?:;|$|['"`]))/i,
	},
	{
		rule: "service_control",
		pattern:
			/\bsystemctl(?:\s+-{1,2}[\w=-]+)*\s+(?:restart|stop|start|disable|kill)\b|\b(?:docker|podman)\s+(?:(?:container|compose)\s+)?(?:rm|stop|kill|restart)\b|\bpm2\s+(?:restart|stop|delete)\b/i,
	},
	{
		rule: "disk_destructive",
		pattern: new RegExp(`\\bmkfs\\b|\\bdd\\s${SEGMENT}\\bof=/dev/`, "i"),
		verb: /\b(mkfs(?=\b)|dd(?=\s))/i,
	},
	// `/./` and `//` between the two names are the same directory (`~/.ompbot/./secrets`, `$HOME//.ompbot//secrets`);
	// `$OMPBOT_HOME` is the bot home too.
	{ rule: "secret_path", pattern: /(?:\.ompbot|\$\{?OMPBOT_HOME\}?)\/(?:\.?\/)*secrets/i },
];

/** `git push --all` / `--branches` / `--prune`: every local branch, or deleting remote ones without a local one. */
const PUSH_ALL_REFS: PatternRule = {
	rule: "git_push_all_refs",
	pattern: new RegExp(`\\bgit\\s+push\\b${SEGMENT}\\s(?:--al(?:l)?|--branches|--pru(?:ne?)?)(?![\\w-])`, "i"),
	verb: /\bgit\s+(push)\b/i,
};

const ADVISORY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
	[
		"package_install",
		/\b(?:npm\s+(?:install|i)\b|bun\s+(?:add|install)\b|pip3?\s+install\b|apt(?:-get)?\s+install\b)/i,
	],
	["owner_gate_skip", /OMP_OWNER_APPROVED/i],
];

/** Forbidding markers: a high_risk hit whose clause carries one of these is downgraded to advisory. */
const FORBIDDING =
	/하지\s*마|하지\s*않|지\s*말고|지\s*않고|않는다|금지|말\s*것|말고|\bnever\b|\bdo\s+not\b|\bdon['’]t\b|\bmust\s+not\b|\bforbidden\b|^\s*[-*]\s+no\s/i;
/**
 * Phrases that contain a forbidding marker but order or urge the command: "don't hesitate to", "do not forget / skip /
 * fail to", "never forget", a double negative "…않으면 안" / "하지 않을 수 없다", "잊지 말고", "…말고는 (방법이) 없다".
 */
const NOT_FORBIDDING =
	/\b(?:do\s+not|don['’]t|never|must\s+not|mustn['’]t)\s+(?:hesitate|forget|skip|omit|miss|fail|neglect|leave\s+out)\b|\bforbidden\s+to\s+(?:skip|omit)\b|(?:하지\s*)?않으면\s*안|하지\s*않을\s*수\s*(?:가\s*)?없|(?:잊|빠뜨리|빼먹)지\s*말고|말고는[^.。!?\n]{0,20}?없/gi;

const HIGH_RISK_RULES = new Set([
	...HIGH_RISK_PATTERNS.map(({ rule }) => rule),
	"git_push_protected",
	"rm_rf_absolute",
]);

/** A pattern rule ready to run: global and sticky copies of its pattern, a global copy of its verb. */
interface CompiledRule {
	rule: string;
	global: RegExp;
	sticky: RegExp;
	verb?: RegExp;
}

function compileRule({ rule, pattern, verb }: PatternRule): CompiledRule {
	return {
		rule,
		global: new RegExp(pattern.source, `${pattern.flags}g`),
		sticky: new RegExp(pattern.source, `${pattern.flags}y`),
		verb: verb === undefined ? undefined : new RegExp(verb.source, `${verb.flags}g`),
	};
}

const HIGH_RISK_COMPILED = HIGH_RISK_PATTERNS.map(compileRule);
const PUSH_ALL_REFS_COMPILED = compileRule(PUSH_ALL_REFS);

/** Where the command a verb at `at` belongs to ends: the next `;`, `&`, `|`, backtick or newline. */
const COMMAND_END = /[;&|`\n]/g;

/**
 * Every match of a rule in `text`, as `matchAll` finds them. A verb rule is tried at each of its verbs instead of at
 * every index, and a verb whose try fails skips the later occurrences of the same verb word up to the end of its
 * command — they could only see less of it. A `restore` is the exception: a `--staged` after it hides one that comes
 * after that `--staged`, so it skips only up to the last one. Without this a 64KB line of verbs that never match is
 * rescanned to its end from each verb.
 */
function ruleMatches(text: string, { global, sticky, verb }: CompiledRule): Array<[number, number]> {
	const matches: Array<[number, number]> = [];
	if (verb === undefined) {
		if (text.search(global) < 0) return matches;
		for (const m of text.matchAll(global)) matches.push([m.index, m.index + m[0].length]);
		return matches;
	}
	if (text.search(verb) < 0) return matches;
	let resume = 0;
	const failedUntil = new Map<string, number>();
	for (const found of text.matchAll(verb)) {
		const word = (found[1] ?? "").toLowerCase();
		if (found.index < resume || found.index < (failedUntil.get(word) ?? 0)) continue;
		sticky.lastIndex = found.index;
		const match = sticky.exec(text);
		if (match !== null) {
			matches.push([found.index, found.index + match[0].length]);
			resume = found.index + match[0].length;
			continue;
		}
		COMMAND_END.lastIndex = found.index;
		const end = COMMAND_END.exec(text)?.index ?? text.length;
		const staged = word === "restore" ? text.slice(found.index, end).toLowerCase().lastIndexOf("--staged") : -1;
		failedUntil.set(word, staged < 0 ? end : found.index + staged);
	}
	return matches;
}

const KOREAN_CONNECTORS = "하고|하되|하며|한\\s+뒤|한\\s+다음|한\\s*후|해서|하여|그리고|다음에|후에|뒤에";
/**
 * Where one clause of a line ends and the next begins: `; , ， 、`, `. 。 ! ?` before whitespace, an English connector
 * or a lone `후` between spaces, a Korean connector with whitespace on one side. A forbidding `말고` (`<용언>지 말고`,
 * `<명사> 말고`) or `지 않고` ends its clause with a zero-width boundary after it, so the forbidding marker stays with the command before it and
 * the command after it is a clause of its own. The shell's command ends of {@link COMMAND_END} (`&&`, `||`, `|`, `&`)
 * end a clause too, and so does a shell comment's `#` (a word of its own after a blank): a marker in the comment or in
 * the next command does not forbid this one (qa-l #70). On a Markdown table row (a line starting with `|`) a single
 * `|` is a cell border, not a pipe: `| git push --force | 금지 |` keeps its marker. Parentheses are handled apart
 * (`commandContext`).
 */
const CLAUSE_BOUNDARY_PARTS = [
	"(?<=말고|지\\s*않고)(?=\\s)",
	// `&` of a redirection (`2>&1`, `&>`) joins no command.
	"&&|\\|\\||(?<![<>])&(?!>)|[;,，、]",
	"(?<=\\s)#(?=\\s|$)",
	"[.。!?](?=\\s)",
	"(?<=\\s)(?:and|then|but|after|before|후)(?=\\s)",
	`(?<=\\s)(?:${KOREAN_CONNECTORS})`,
	`(?:${KOREAN_CONNECTORS})(?=\\s)`,
];
const TABLE_ROW = /^\s*\|/;

interface ClauseBoundary {
	/** For `matchAll`. */
	all: RegExp;
	/** For searches started at a set `lastIndex`, kept apart because `matchAll` starts from the regex's `lastIndex`. */
	from: RegExp;
}

function clauseBoundary(parts: readonly string[]): ClauseBoundary {
	const source = parts.join("|");
	return { all: new RegExp(source, "gi"), from: new RegExp(source, "gi") };
}

const CLAUSE_BOUNDARY = clauseBoundary([...CLAUSE_BOUNDARY_PARTS, "\\|"]);
const TABLE_ROW_CLAUSE_BOUNDARY = clauseBoundary(CLAUSE_BOUNDARY_PARTS);

/** Stands in for text outside a command's context: neither whitespace nor a word character, so no marker spans it. */
const MASK = "\u0000";

interface Hit {
	rule: string;
	start: number;
	end: number;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `git push … <protected branch>`: the branch as a whole ref word (`main`, `HEAD:main`, `+main`, `refs/heads/main`).
 * A hit runs from the verb to the end of the first protected ref.
 */
function pushesProtected(line: string, branches: readonly string[]): Hit[] {
	if (branches.length === 0) return [];
	const names = branches.map(escapeRegExp).join("|");
	const ref = new RegExp(`(?<![\\w./-])(?:refs/heads/)?(?:${names})(?![\\w./-])`, "i");
	const hits: Hit[] = [];
	for (const match of line.matchAll(new RegExp(`\\bgit\\s+push\\b(${SEGMENT})`, "gi"))) {
		const segment = match[1] ?? "";
		const found = ref.exec(segment);
		if (found === null) continue;
		const segmentAt = match.index + match[0].length - segment.length;
		hits.push({ rule: "git_push_protected", start: match.index, end: segmentAt + found.index + found[0].length });
	}
	return hits;
}

/**
 * `rm` with recursive and force flags whose target starts at `/`, `~`, `$HOME` or a `${HOME…}` expansion
 * (`${HOME:-/}`); a hit ends at its last such word.
 */
function removesAbsoluteTree(line: string): Hit[] {
	const hits: Hit[] = [];
	for (const match of line.matchAll(new RegExp(`\\brm\\s(${SEGMENT})`, "gi"))) {
		const segment = match[1] ?? "";
		const segmentAt = match.index + match[0].length - segment.length;
		let recursive = false;
		let force = false;
		let absolute = false;
		let end = match.index;
		for (const found of segment.matchAll(/\S+/g)) {
			const word = found[0];
			// GNU rm takes any unique prefix of its long options (`--recurs`, `--forc`, `--r`).
			if (/^--r(?:e(?:c(?:u(?:r(?:s(?:i(?:ve?)?)?)?)?)?)?)?$/i.test(word)) recursive = true;
			else if (/^--f(?:o(?:r(?:ce?)?)?)?$/i.test(word)) force = true;
			else if (/^-[a-z]+$/i.test(word)) {
				if (/[rR]/.test(word)) recursive = true;
				if (/f/i.test(word)) force = true;
			} else if (/^["']?(?:\/|~|\$HOME\b|\$\{HOME(?!\w)[^}]*\})/.test(word)) absolute = true;
			else continue;
			// A clause mark glued to the target (`~/work,`) is a boundary, not part of the command.
			end = segmentAt + found.index + word.replace(/[;,，、.。!?]+$/, "").length;
		}
		if (recursive && force && absolute) hits.push({ rule: "rm_rf_absolute", start: match.index, end });
	}
	return hits;
}

/**
 * `cd` / `pushd` (past options and `--`) or `env -C` / `--chdir` into the bot home itself (`~/.ompbot`,
 * `$OMPBOT_HOME`, quoted or with a trailing `/`).
 */
const CD_BOT_HOME =
	/(?:\b(?:cd|pushd)\s+(?:(?:-[A-Za-z@]+|--)\s+)*|\benv\s+(?:[^\s;&|`]+\s+)*?(?:-[A-Za-z]*C\s*|--chdir(?:=|\s+)))["']?[^\s;&|`'"]*(?:\.ompbot|\$\{?OMPBOT_HOME\}?)\/?["']?(?=[\s;&|`]|$)/gi;
/** A path under the bot home with a `..` in it (`~/.ompbot/logs/../secrets`): the rest after the bot home. */
const BOT_HOME_CLIMB = /(?:\.ompbot|\$\{?OMPBOT_HOME\}?)((?:\/[^\s/;&|`'"]*)*\/\.\.(?:\/[^\s/;&|`'"]*)*)/gi;

/** `secret_path` through a `..` that stays inside the bot home: `~/.ompbot/logs/../secrets`, not `~/.ompbot/../secrets`. */
function climbsIntoSecrets(line: string): Hit[] {
	const hits: Hit[] = [];
	for (const match of line.matchAll(BOT_HOME_CLIMB)) {
		if (/^home\/secrets(?:\/|$)/i.test(posix.normalize(`home${match[1]}`)))
			hits.push({ rule: "secret_path", start: match.index, end: match.index + match[0].length });
	}
	return hits;
}
/** A relative `secrets` path word (`secrets/x`, `secrets`), not one named under another directory. */
const RELATIVE_SECRETS = /(?<![\w.$/-])secrets(?=\/|[\s;&|`'"]|$)/gi;

/**
 * `secret_path` spelled relative to the bot home: a `cd` into it and a later `secrets/…` on the line. A hit runs from
 * the last such `cd` before a `secrets` to that `secrets`.
 */
function entersBotHome(line: string): Hit[] {
	const secrets = Array.from(line.matchAll(RELATIVE_SECRETS), (m) => [m.index, m.index + m[0].length] as const);
	if (secrets.length === 0) return [];
	const hits: Hit[] = [];
	let next = 0;
	for (const cd of line.matchAll(CD_BOT_HOME)) {
		while (next < secrets.length && (secrets[next] as readonly [number, number])[0] < cd.index + cd[0].length) next++;
		const after = secrets[next];
		if (after === undefined) break;
		if (hits.at(-1)?.end === after[1]) hits.pop();
		hits.push({ rule: "secret_path", start: cd.index, end: after[1] });
	}
	return hits;
}

interface ParenGroup {
	open: number;
	close: number;
	/** The innermost group around this one. */
	parent?: ParenGroup;
	/** The groups directly inside this one, by `open`. */
	children: ParenGroup[];
}

/** Balanced `( )` / `（ ）` pairs of a line, by `open`, with their nesting; an unmatched one is ordinary text. */
function parenGroups(line: string): { groups: ParenGroup[]; top: ParenGroup[] } {
	const groups: ParenGroup[] = [];
	const stack: number[] = [];
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === "(" || char === "（") stack.push(i);
		else if (char === ")" || char === "）") {
			const open = stack.pop();
			if (open !== undefined) groups.push({ open, close: i, children: [] });
		}
	}
	groups.sort((a, b) => a.open - b.open);
	const top: ParenGroup[] = [];
	const around: ParenGroup[] = [];
	for (const group of groups) {
		while (around.length > 0 && (around.at(-1) as ParenGroup).close < group.open) around.pop();
		const parent = around.at(-1);
		if (parent === undefined) top.push(group);
		else {
			group.parent = parent;
			parent.children.push(group);
		}
		around.push(group);
	}
	return { groups, top };
}

/** A visible run of a level string: where it starts in the level string and the line indices it copies. */
interface Run {
	at: number;
	from: number;
	to: number;
}

/**
 * One nesting level as matched for clause boundaries: its text with each hidden run standing as one {@link MASK} — no
 * boundary or marker matches a mask, so one stands for any number — the visible runs, and the boundaries found.
 */
interface Level {
	text: string;
	runs: Run[];
	/** Clause boundaries of `text` in order (they never overlap), as `[start, end)`. */
	boundaries: Array<[number, number]>;
	/** The boundary set of the line's kind (a Markdown table row has no single-`|` boundary). */
	boundary: ClauseBoundary;
	/** Per hidden range, the index in `text` of the mask standing for it (overlapping ranges share one). */
	maskAt: number[];
}

/** `[lo, hi)` of a line with the `hidden` line ranges (sorted by start, overlaps merged into one mask) masked. */
function maskedLevel(line: string, lo: number, hi: number, hidden: ReadonlyArray<readonly [number, number]>): Level {
	const runs: Run[] = [];
	const maskAt: number[] = [];
	let text = "";
	let pos = lo;
	for (const [from, to] of hidden) {
		if (from > pos) {
			runs.push({ at: text.length, from: pos, to: from });
			text += line.slice(pos, from);
		}
		if (from >= pos) text += MASK;
		maskAt.push(text.length - 1);
		pos = Math.max(pos, to);
	}
	if (pos < hi) {
		runs.push({ at: text.length, from: pos, to: hi });
		text += line.slice(pos, hi);
	}
	const boundary = TABLE_ROW.test(line) ? TABLE_ROW_CLAUSE_BOUNDARY : CLAUSE_BOUNDARY;
	const boundaries = Array.from(text.matchAll(boundary.all), (b): [number, number] => [b.index, b.index + b[0].length]);
	return { text, runs, boundaries, boundary, maskAt };
}

/** The line ranges of `runs` that fall inside the level-string positions `[from, to)`. */
function runRanges(runs: readonly Run[], from: number, to: number): Array<[number, number]> {
	return runs.flatMap((run): Array<[number, number]> => {
		const start = Math.max(from, run.at);
		const end = Math.min(to, run.at + (run.to - run.from));
		return start < end ? [[run.from + start - run.at, run.from + end - run.at]] : [];
	});
}

/** The number of leading entries of a sorted list for which `before` holds. */
function countBefore<T>(items: readonly T[], before: (item: T) => boolean): number {
	let lo = 0;
	let hi = items.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (before(items[mid] as T)) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** The end of the last boundary ending at or before `at` (0 when none); boundaries never overlap, so ends are sorted. */
function clauseStart(boundaries: ReadonlyArray<readonly [number, number]>, at: number): number {
	const count = countBefore(boundaries, ([, end]) => end <= at);
	return count === 0 ? 0 : (boundaries[count - 1] as readonly [number, number])[1];
}

/** The level string of `[lo, hi)` with only its child groups masked, built and matched once per level and line. */
function sharedLevel(
	line: string,
	levels: Map<number, Level>,
	lo: number,
	hi: number,
	children: readonly ParenGroup[],
): Level {
	let level = levels.get(lo);
	if (level === undefined) {
		level = maskedLevel(
			line,
			lo,
			hi,
			children.map((group) => [group.open, group.close + 1] as const),
		);
		levels.set(lo, level);
	}
	return level;
}

/**
 * The visible `[from, to)` ranges (line indices) of one nesting level `[lo, hi)`: the clause holding `span`, without
 * `span` and without the groups directly inside the level, as if matched on the level string with `span` masked too.
 * The level string with only its child groups masked is built and matched once per level (`levels`) and shared by
 * every span in it, which keeps a line with many hits linear: a span that is a child group is already one mask
 * there; a span inside one visible run takes its clause start from the shared boundaries (no boundary reaches
 * across a span's first character, which is never a blank) and its clause end from one search starting right after
 * it, skipping a zero-width `말고`/`않고` boundary that would only look back into the span. A span overlapping a child
 * group is matched on its own masked string.
 */
function levelRanges(
	line: string,
	levels: Map<number, Level>,
	lo: number,
	hi: number,
	children: readonly ParenGroup[],
	span: { start: number; end: number },
): Array<[number, number]> {
	const level = sharedLevel(line, levels, lo, hi, children);
	const childIndex = countBefore(children, (group) => group.open < span.start);
	const child = children[childIndex];
	if (child !== undefined && child.open === span.start && child.close + 1 === span.end) {
		// Already one mask in the shared string: its boundaries are the ones this span sees.
		const spanAt = level.maskAt[childIndex] as number;
		const next = level.boundaries[countBefore(level.boundaries, ([start]) => start <= spanAt)];
		return runRanges(level.runs, clauseStart(level.boundaries, spanAt), next?.[0] ?? level.text.length);
	}
	const run = level.runs[countBefore(level.runs, (r) => r.to < span.end)];
	if (run !== undefined && run.from <= span.start) {
		const spanLo = run.at + (span.start - run.from);
		const spanHi = run.at + (span.end - run.from);
		// The first shared boundary ending past the span (a zero-width one right at its end ends there and is passed
		// over): starting at or after the span's end, it is the one a search from there finds; one running across that
		// end hides where such a search starts, so then the search is run.
		const next = level.boundaries[countBefore(level.boundaries, ([, end]) => end <= spanHi)];
		let to = next === undefined ? level.text.length : next[0];
		if (next !== undefined && next[0] < spanHi) {
			to = level.text.length;
			const search = level.boundary.from;
			search.lastIndex = spanHi;
			for (let boundary = search.exec(level.text); boundary !== null; ) {
				if (boundary.index > spanHi || boundary[0].length > 0) {
					to = boundary.index;
					break;
				}
				search.lastIndex = spanHi + 1;
				boundary = search.exec(level.text);
			}
		}
		return [
			...runRanges(level.runs, clauseStart(level.boundaries, spanLo), spanLo),
			...runRanges(level.runs, spanHi, to),
		];
	}
	const hidden = [...children.map((group) => [group.open, group.close + 1] as const), [span.start, span.end] as const]
		.filter(([from, to]) => to > lo && from < hi)
		.sort((a, b) => a[0] - b[0]);
	const own = maskedLevel(line, lo, hi, hidden);
	const spanAt = own.maskAt[hidden.findIndex(([from, to]) => from === span.start && to === span.end)] ?? -1;
	let from = 0;
	let to = own.text.length;
	for (const [start, end] of own.boundaries) {
		if (end <= spanAt) from = end;
		else if (start > spanAt && start < to) to = start;
	}
	return runRanges(own.runs, from, to);
}

/**
 * The text a forbidding marker must sit in to downgrade the command at `[start, end)`, as the line with everything
 * else masked: the command's clause, without the command itself and without the parentheses inside that clause. A
 * command inside a parenthesis adds the clause around that parenthesis, outward to the line level. Clause boundaries
 * are looked for with the command and the inner parentheses masked, so neither is ever cut. A masked run is one
 * {@link MASK}, however long.
 */
function commandContext(
	line: string,
	parens: { groups: readonly ParenGroup[]; top: readonly ParenGroup[] },
	levels: Map<number, Level>,
	start: number,
	end: number,
): string {
	let enclosing: ParenGroup | undefined;
	for (const group of parens.groups) {
		if (group.open < start && group.close >= end && (enclosing === undefined || group.open > enclosing.open))
			enclosing = group;
	}
	const ranges: Array<[number, number]> = [];
	let span = { start, end };
	for (;;) {
		const lo = enclosing === undefined ? 0 : enclosing.open + 1;
		const hi = enclosing === undefined ? line.length : enclosing.close;
		ranges.push(...levelRanges(line, levels, lo, hi, enclosing === undefined ? parens.top : enclosing.children, span));
		if (enclosing === undefined) break;
		span = { start: enclosing.open, end: enclosing.close + 1 };
		enclosing = enclosing.parent;
	}
	ranges.sort((a, b) => a[0] - b[0]);
	let context = "";
	let pos = 0;
	for (const [from, to] of ranges) {
		if (from > pos) context += MASK;
		context += line.slice(from, to);
		pos = to;
	}
	return pos < line.length ? `${context}${MASK}` : context;
}

/** The first `HANDOFF_SCAN_BYTES` bytes of `text` (UTF-8), cut back to a whole character. */
function headBytes(text: string): { head: string; truncated: boolean } {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= HANDOFF_SCAN_BYTES) return { head: text, truncated: false };
	let end = HANDOFF_SCAN_BYTES;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return { head: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/**
 * Whether `hit` is the quoted pattern of a line defining its rule (- `git_reset_hard`: `git reset --hard`): such a
 * line documents this scanner, not an order. Only a hit starting inside the inline code spans listed right after the
 * `` `rule`: `` prefix counts — in the markdown spelling a definition may run on into the prose after its span
 * (`` `git clean` 뒤에 `-f` ``) — and the same command in the plain text, or in a code span after it, is an order like
 * on any other line.
 */
function definesRule(line: string, hit: Hit): boolean {
	const prefix = new RegExp(`^\\s*[-*]?\\s*\`${escapeRegExp(hit.rule)}\`\\s*:`).exec(line);
	if (prefix === null) return false;
	// The definition is the list of code spans right after the prefix (`DROP TABLE`, `DROP DATABASE`); a span after
	// prose (`… 이제 \`git reset --hard HEAD~9\` 를 실행`) is an order.
	const list = /^(?:[\s,，、/·|]*`[^`\n]*`)+/.exec(line.slice(prefix[0].length));
	if (list === null) return false;
	for (const span of list[0].matchAll(/`[^`\n]*`/g)) {
		const open = prefix[0].length + span.index;
		if (hit.start > open && hit.start < open + span[0].length - 1) return true;
	}
	return false;
}

/**
 * One spelling of a line: its text and, per character of it, the index in the line as written that character comes
 * from, so a hit found in a spelling is judged and excerpted where it stands in the line.
 */
interface Spelling {
	text: string;
	/** Absent for the line as written, where every character comes from its own index. */
	origin?: number[];
}

/** A replacement of `[start, end)` of a spelling's text by `insert`. */
interface Edit {
	start: number;
	end: number;
	insert: string;
}

/** Where the character at `index` of a spelling stands in the line as written; past the end, just after the last. */
function inLine({ text, origin }: Spelling, index: number): number {
	if (origin === undefined) return index;
	return index < text.length ? (origin[index] as number) : (origin.at(-1) ?? -1) + 1;
}

/** `spelling` with `edits` (sorted, not overlapping) applied; an inserted character comes from where its edit starts. */
function edited(spelling: Spelling, edits: readonly Edit[]): Spelling {
	if (edits.length === 0) return spelling;
	let text = "";
	const origin: number[] = [];
	let pos = 0;
	const copy = (to: number): void => {
		text += spelling.text.slice(pos, to);
		for (let index = pos; index < to; index++) origin.push(inLine(spelling, index));
	};
	for (const { start, end, insert } of edits) {
		copy(start);
		text += insert;
		const from = inLine(spelling, start);
		for (let k = 0; k < insert.length; k++) origin.push(from);
		pos = end;
	}
	copy(spelling.text.length);
	return { text, origin };
}

/** `spelling` with every match of the global `pattern` replaced by `insert`. */
function replaced(spelling: Spelling, pattern: RegExp, insert = ""): Spelling {
	if (spelling.text.search(pattern) < 0) return spelling;
	const edits: Edit[] = [];
	for (const m of spelling.text.matchAll(pattern)) edits.push({ start: m.index, end: m.index + m[0].length, insert });
	return edited(spelling, edits);
}

/**
 * The line as the shell reads its words: a quoted word without blanks loses its quotes (`'--hard'` → `--hard`) and a
 * backslash before a word character or `-` goes (`\\--hard`, `--h\\ard`). A quote right after a letter stays, so
 * `don't` keeps its forbidding marker.
 */
function shellSpelling(spelling: Spelling): Spelling {
	const quotes = Array.from(spelling.text.matchAll(/(?<!\w)(['"])([^'"\s`]*)\1/g), (m) => [
		{ start: m.index, end: m.index + 1, insert: "" },
		{ start: m.index + m[0].length - 1, end: m.index + m[0].length, insert: "" },
	]).flat();
	return replaced(edited(spelling, quotes), /\\(?=[\w-])/g);
}

/**
 * The line as markdown renders it: HTML comments gone, a backtick a blank, emphasis marks (`*`, and `_` at a word's
 * edge) gone — `` `git` reset `--hard` `` and `git **reset** --hard` read as the command they show. With the
 * backticks gone a list mark between code spans (`` `a`, `b` `` · `、`) is what keeps two commands apart, so it ends
 * a command like `;`.
 */
function markdownSpelling(spelling: Spelling): Spelling {
	const comments: Edit[] = [];
	for (let open = spelling.text.indexOf("<!--"); open >= 0; ) {
		const close = spelling.text.indexOf("-->", open + 4);
		if (close < 0) break;
		comments.push({ start: open, end: close + 3, insert: "" });
		open = spelling.text.indexOf("<!--", close + 3);
	}
	const bare = edited(spelling, comments);
	return replaced(replaced(replaced(bare, /`/g, " "), /[,，、·]/g, ";"), /\*+|(?<!\w)_+|_+(?!\w)/g);
}

/** Options before a git subcommand that take the next word as their value. */
const GIT_VALUE_OPTION = /^(?:-[Cc]|--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source))$/;

/** The shell word starting at `at`, quotes removed, and where it ends: at a blank or a separator outside quotes. */
function shellWord(text: string, at: number): { word: string; end: number } {
	let word = "";
	let quote = "";
	let index = at;
	for (; index < text.length; index++) {
		const ch = text.charAt(index);
		if (quote !== "") {
			if (ch === quote) quote = "";
			else word += ch;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (/[\s;&|`]/.test(ch)) break;
		else word += ch;
	}
	return { word, end: index };
}

/**
 * Edits that replace a git alias defined on its own command line (`git -c alias.h=reset h --hard`) by what it runs:
 * the options and the alias word become its value (`git reset --hard`). Each `git` reads its options once; one
 * inside options already read is not read again.
 */
function gitAliasEdits(text: string): Edit[] {
	const edits: Edit[] = [];
	let read = 0;
	for (const git of text.matchAll(/\bgit(?=[ \t])/gi)) {
		if (git.index < read) continue;
		const aliases = new Map<string, string>();
		let at = git.index + 3;
		for (;;) {
			while (/[ \t]/.test(text.charAt(at))) at++;
			const { word, end } = shellWord(text, at);
			read = end;
			if (word === "") break;
			if (!word.startsWith("-")) {
				const value = aliases.get(word.toLowerCase());
				if (value !== undefined) edits.push({ start: git.index + 3, end, insert: ` ${value}` });
				break;
			}
			at = end;
			if (word !== "-c" && !GIT_VALUE_OPTION.test(word)) continue;
			while (/[ \t]/.test(text.charAt(at))) at++;
			const option = shellWord(text, at);
			at = option.end;
			// Alias names ignore case, like every git config variable name.
			const alias = word === "-c" ? /^alias\.([^=]+)=(.*)$/is.exec(option.word) : null;
			if (alias !== null) aliases.set((alias[1] as string).toLowerCase(), alias[2] as string);
		}
	}
	return edits;
}

/** `text` with every git alias defined on its own command line replaced by what it runs (`gitAliasEdits`). */
export function expandGitAliases(text: string): string {
	return edited({ text }, gitAliasEdits(text)).text;
}

/**
 * The findings of one line of a brief (`line` is its 1-based number for the report) in three spellings: as written,
 * as the shell reads its words (`shellSpelling`), and with its git aliases expanded, invisible characters dropped and
 * markdown rendered before the shell reading. A rule keeps the more severe finding, its excerpt cut from the line as
 * written.
 */
function scanLine(text: string, line: number, branches: readonly string[]): HandoffFinding[] {
	const written: Spelling = { text };
	// Each spelling only when the line has what it changes; most lines are scanned once.
	const aliased = /alias\./i.test(text) ? edited(written, gitAliasEdits(text)) : written;
	const rendered = /[`*_<,，、·]/.test(text)
		? markdownSpelling(replaced(aliased, INVISIBLE))
		: replaced(aliased, INVISIBLE);
	const shellRead = (spelling: Spelling): Spelling =>
		/['"\\]/.test(spelling.text) ? shellSpelling(spelling) : spelling;
	const findings: HandoffFinding[] = [];
	const scanned = new Set<string>();
	for (const spelling of [written, shellRead(written), shellRead(rendered)]) {
		if (scanned.has(spelling.text)) continue;
		scanned.add(spelling.text);
		for (const finding of scanSpelling(spelling, line, branches, text)) {
			const index = findings.findIndex((found) => found.rule === finding.rule);
			const found = findings[index];
			if (found === undefined) findings.push(finding);
			else if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[found.severity]) findings[index] = finding;
		}
	}
	return findings;
}

/**
 * At most {@link EXCERPT_CHARS} characters of `text` with whitespace collapsed: its head, or — when the command at
 * index `at` would fall past the head — a window from {@link EXCERPT_LEAD} characters before it, marked with a
 * leading `…`, so an approval card shows the command it asks about.
 */
function excerptOf(text: string, at = 0): string {
	const chars = Array.from(text.replace(/\s+/g, " ").trim());
	const offset = Array.from(text.slice(0, at).replace(/\s+/g, " ").trimStart()).length;
	if (chars.length <= EXCERPT_CHARS || offset + EXCERPT_LEAD <= EXCERPT_CHARS)
		return chars.slice(0, EXCERPT_CHARS).join("");
	const start = Math.min(offset - EXCERPT_LEAD, chars.length - (EXCERPT_CHARS - 1));
	return `…${chars.slice(start, start + EXCERPT_CHARS - 1).join("")}`;
}

/**
 * The findings of a spelling of the line `written`, one per rule, with the excerpt cut from `written` around the
 * rule's first ordered hit, else its first hit. A rule definition line is recognized where the hit stands in
 * `written` (`definesRule`).
 */
function scanSpelling(
	spelling: Spelling,
	line: number,
	branches: readonly string[],
	written: string,
): HandoffFinding[] {
	const { text } = spelling;
	// The rules run on the text with git global options blanked (same indices) and, for a command inside an option's
	// value (`git -c alias.x='!rm -rf /' x`), on the text itself; a hit both find is kept once.
	const blanked = blankGitGlobalOptions(text);
	const found = new Map<string, Hit>();
	for (const spelling of blanked === text ? [text] : [blanked, text]) {
		for (const compiled of HIGH_RISK_COMPILED) {
			for (const [start, end] of ruleMatches(spelling, compiled)) {
				found.set(`${compiled.rule}:${start}:${end}`, { rule: compiled.rule, start, end });
			}
		}
	}
	const hits: Hit[] = [
		...found.values(),
		...pushesProtected(blanked, branches),
		...removesAbsoluteTree(text),
		...entersBotHome(text),
		...climbsIntoSecrets(text),
	];
	/** Where each advisory-only rule found matches first. */
	const advisoryAt = new Map<string, number>();
	for (const [rule, pattern] of ADVISORY_PATTERNS) {
		const at = text.search(pattern);
		if (at >= 0) advisoryAt.set(rule, at);
	}
	const pushAll = ruleMatches(blanked, PUSH_ALL_REFS_COMPILED)[0];
	if (pushAll !== undefined) advisoryAt.set(PUSH_ALL_REFS.rule, pushAll[0]);
	const rules = [...new Set(hits.map((hit) => hit.rule)), ...advisoryAt.keys()];
	if (rules.length === 0) return [];
	const groups = parenGroups(text);
	const levels = new Map<number, Level>();
	// A context is pieces of the line, and no phrase spans the mask between them: a line without a phrase has none.
	const phrases = text.search(NOT_FORBIDDING) >= 0;
	return rules.map((rule) => {
		const ruleHits = hits.filter((hit) => hit.rule === rule);
		// A marker inside a `NOT_FORBIDDING` phrase ("don't hesitate to", "…않으면 안") does not forbid.
		const ordered = ruleHits.find((hit) => {
			const inWritten = { rule, start: inLine(spelling, hit.start), end: inLine(spelling, hit.end - 1) + 1 };
			if (definesRule(written, inWritten)) return false;
			const context = commandContext(text, groups, levels, hit.start, hit.end);
			return !FORBIDDING.test(phrases ? context.replace(NOT_FORBIDDING, MASK) : context);
		});
		const severity = HIGH_RISK_RULES.has(rule) && ordered !== undefined ? "high_risk" : "advisory";
		const at = (ordered ?? ruleHits[0])?.start ?? advisoryAt.get(rule) ?? 0;
		return { rule, line, excerpt: excerptOf(written, inLine(spelling, at)), severity };
	});
}

/** The rules naming a shell command by its own words; the rest (`sql_destructive`, `service_control`, `secret_path`) read prose. */
const COMMAND_RULES = HIGH_RISK_COMPILED.filter(({ rule }) => /^(?:git_|gh_|crontab_|disk_)/.test(rule));

/**
 * Backticks and redirections (`2>&1`, `&>`, `>&`): `SEGMENT` ends a command at them, which suits an inline code span in
 * a brief, but in a command about to run the words after them still belong to the same command.
 */
const SEGMENT_BREAKS = /`|[0-9]*>&[0-9-]*|&>/g;

/**
 * The first command rule a single shell command matches, for a caller judging a command about to run (the Claude
 * permission gate): the brief scan's own table, tried on the command as written, with git global options blanked and
 * with command-line git aliases expanded, each also with backticks and redirections blanked. No clause or
 * forbidding-marker reading: a command is not prose.
 */
export function highRiskCommandRule(command: string): string | undefined {
	const shapes = [command, blankGitGlobalOptions(command), expandGitAliases(command)];
	for (const text of new Set([...shapes, ...shapes.map((shape) => shape.replace(SEGMENT_BREAKS, " "))])) {
		for (const compiled of COMMAND_RULES) {
			if (ruleMatches(text, compiled).length > 0) return compiled.rule;
		}
	}
	return undefined;
}

/** A line ending in a backslash (trailing blanks allowed) is continued on the next one, as in a shell script. */
const CONTINUED = /\\[ \t\r]*$/;

const SEVERITY_RANK = { advisory: 0, high_risk: 1 } as const;

/**
 * Scans the first `HANDOFF_SCAN_BYTES` of a brief line by line for the high-risk patterns above; a hit whose own
 * clause forbids the command (`commandContext`) is downgraded to advisory. Lines joined by trailing backslashes are
 * also scanned as one line — joined with a blank and without one — reported at the first of them, so a command split
 * across them, even inside a word, is still seen; a rule a joined line finds no more severely than one of its own
 * lines (or the other joining) already did is not reported twice.
 */
export function scanHandoffBrief(brief: string, options: { protectedBranches?: readonly string[] } = {}): HandoffScan {
	const branches = options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
	const { head, truncated } = headBytes(brief);
	const findings: HandoffFinding[] = [];
	// Every character Slack, editors and browsers break a line at, numbered in order (CRLF is one break).
	const lines = head.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);
	for (let first = 0; first < lines.length; ) {
		let last = first;
		while (last + 1 < lines.length && CONTINUED.test(lines[last] ?? "")) last++;
		const own: HandoffFinding[] = [];
		for (let index = first; index <= last; index++) own.push(...scanLine(lines[index] ?? "", index + 1, branches));
		findings.push(...own);
		if (last > first) {
			const parts = lines
				.slice(first, last + 1)
				.map((text, offset) => (first + offset < last ? text.replace(CONTINUED, "") : text));
			// Joined with a blank (a break between words) and without one (the shell's reading of a break inside a word).
			for (const joined of [parts.join(" "), parts.join("")]) {
				for (const finding of scanLine(joined, first + 1, branches)) {
					const seen = own.some(
						(found) => found.rule === finding.rule && SEVERITY_RANK[found.severity] >= SEVERITY_RANK[finding.severity],
					);
					if (seen) continue;
					findings.push(finding);
					own.push(finding);
				}
			}
		}
		first = last + 1;
	}
	const verdict: HandoffVerdict = findings.some((finding) => finding.severity === "high_risk")
		? "high_risk"
		: findings.length > 0 || truncated
			? "advisory"
			: "clear";
	return { verdict, findings, truncated };
}
