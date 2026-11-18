import { type BigIntStats, type Dirent, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { blankGitGlobalOptions, expandGitAliases, highRiskCommandRule } from "../safety/handoff-risk";
import { isInside } from "../safety/inside";

/**
 * First-cut permission policy for the Claude Code driver: file edits inside the
 * session workspace and harmless tool calls run without asking; dangerous Bash
 * escalates to an owner approval card; Bash touching the bot's secrets
 * directory is refused outright (it is a floor, not a judgment call).
 */

/** Tools that edit files; allowed only when every target path stays inside the workspace. */
const EDIT_TOOLS: Record<string, true> = {
	Edit: true,
	Write: true,
	MultiEdit: true,
	NotebookEdit: true,
};

/** Input keys that name file paths, per editing tool. */
const EDIT_PATH_KEYS: Record<string, string[]> = {
	Edit: ["file_path"],
	Write: ["file_path"],
	MultiEdit: ["file_path"],
	NotebookEdit: ["notebook_path"],
};

/** Bash patterns that always go to an owner approval card (rule-guards parity). */
const DANGEROUS_BASH: RegExp[] = [
	// GNU rm takes any unique prefix of its long options: `--r` / `--rec…` is `--recursive`, `--f` / `--for…` `--force`.
	/rm\s+(?=[^;\n|]*\s)(?:[^;\n|]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--r(?:e(?:c(?:u(?:r(?:s(?:i(?:ve?)?)?)?)?)?)?)?(?![\w-]))/,
	/rm\s+(?:[^;\n|]*\s)?(?:-[a-zA-Z]*f[a-zA-Z]*\s|--f(?:o(?:r(?:ce?)?)?)?\s)+(?:-[a-zA-Z]*[rR]|--r(?:e(?:c(?:u(?:r(?:s(?:i(?:ve?)?)?)?)?)?)?)?(?![\w-]))/,
	/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
	/\b(shutdown|reboot|halt|poweroff)\b/,
	// The git, gh, crontab and disk rules are the brief scan's table (`highRiskCommandRule`); only what that table
	// does not hold stays here, also tried with git global options blanked and aliases expanded: a `+refspec` force
	// push and merging or closing a PR.
	/\bgit\s+push\b[^;\n|]*\s\+\S+/,
	/\bgh\s+pr\s+(?:merge|close)\b/,
	/\b(curl|wget)\b[^;\n|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/,
	/\bkillall\b/,
	// SIGKILL however it is spelled: `-9`, `-KILL`, `-SIGKILL`, `-s KILL`, `-n 9`, `--signal KILL`.
	/\bkill\s+(?:-[sn]\s*|--signal[\s=]+|-)(?:9|(?:SIG)?KILL)\b/i,
	// Mode 777 however it is spelled (`0777`) and behind any options (`-vR`, `--recursive`).
	/\bchmod\s+(?:[^;\n|]*\s)?0*777(?![\w])/,
];

/** Where relative arguments resolve and what `~` / `$HOME` / `${HOME}` expand to. */
interface BashPathContext {
	cwd: string;
	userHome: string;
}

const GLOB_CHAR = /[*?[]/;

function insideOrSelf(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir === "/" ? dir : `${dir}/`);
}

/** A leading `~`, `$HOME` or `${HOME}` (alone or before `/`), which the shell expands to the user's home. */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/** A word naming the home: a leading `~`, or `$HOME` / `${HOME…}` anywhere in it. */
const USES_HOME = /^~|\$\{?HOME(?![A-Za-z0-9_])/;

/** A leading `~`, `~+` (the cwd) or `~-` (the previous cwd) before `/` or alone. */
const TILDE_PREFIX = /^~([+-]?)(?=\/|$)/;

/**
 * `$HOME`, `$PWD`, `$OLDPWD` anywhere in a word (`/tmp/../$HOME/x`), braced too and with a parameter operator after
 * the name (`${HOME:-x}`, `${PWD%/*}`).
 */
const LOCATION_VARIABLE = /\$\{(HOME|PWD|OLDPWD)(?![A-Za-z0-9_])([^}]*)\}|\$(HOME|PWD|OLDPWD)(?![A-Za-z0-9_])/g;

/** Operators that yield the value itself when it is set and not empty (`:-` `-` `:=` `=` `:?` `?`), with a plain word after. */
const KEEPS_VALUE = /^:?[-=?][^$`{}]*$/;

/**
 * A word with the shell's home and working-directory spellings expanded: a leading `~` / `~+`, and `$HOME` / `$PWD`
 * (braced, or with an operator that keeps the value) wherever they stand. `undefined` when the result cannot be
 * judged: the previous cwd (`~-`, `$OLDPWD`), the cwd when it is not known, or another operator (`${HOME:0}`,
 * `${PWD%/*}`).
 */
function expandWord(word: string, home: string, cwd: string | undefined): string | undefined {
	let head = "";
	let rest = word;
	const tilde = TILDE_PREFIX.exec(word);
	if (tilde !== null) {
		const value = tilde[1] === "" ? home : tilde[1] === "+" ? cwd : undefined;
		if (value === undefined) return undefined;
		head = value;
		rest = word.slice(tilde[0].length);
	}
	let judged = true;
	const expanded = rest.replace(LOCATION_VARIABLE, (_match, braced?: string, operator?: string, bare?: string) => {
		const name = braced ?? bare;
		const value = name === "HOME" ? home : name === "PWD" ? cwd : undefined;
		if (value === undefined || (operator !== undefined && operator !== "" && !KEEPS_VALUE.test(operator)))
			judged = false;
		return value ?? "";
	});
	return judged ? `${head}${expanded}` : undefined;
}

/** One shell glob path component as a regex; like bash, a leading `.` is only matched by a literal `.`. */
function globComponentMatches(pattern: string, name: string): boolean {
	if (!GLOB_CHAR.test(pattern)) return pattern === name;
	if (name.startsWith(".") && !pattern.startsWith(".")) return false;
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern.charAt(i);
		if (ch === "*") source += ".*";
		else if (ch === "?") source += ".";
		else if (ch === "[") {
			const close = pattern.indexOf("]", i + 2);
			if (close < 0) source += "\\[";
			else {
				const body = pattern
					.slice(i + 1, close)
					.replace(/^!/, "^")
					.replace(/\\/g, "\\\\");
				source += `[${body}]`;
				i = close;
			}
		} else source += ch.replace(/[.+^${}()|\\\]]/g, "\\$&");
	}
	try {
		return new RegExp(`^${source}$`).test(name);
	} catch {
		// An unparsable bracket (`[z-a]`) is judged as a match: the guard fails closed.
		return true;
	}
}

/**
 * Whether a resolved path, glob components included, can name `secretsDir` or something inside it. A `**` component
 * may stand for any number of components, dot directories included (ripgrep and globstar spellings fail closed).
 */
function pathReachesSecrets(path: string, secretsDir: string): boolean {
	if (!GLOB_CHAR.test(path)) return insideOrSelf(path, secretsDir);
	const parts = path.split("/");
	const secretParts = secretsDir.split("/");
	const matchFrom = (p: number, s: number): boolean => {
		if (s === secretParts.length) return true;
		const part = parts[p];
		if (part === undefined) return false;
		if (part === "**") return p + 1 === parts.length || matchFrom(p + 1, s) || matchFrom(p, s + 1);
		return globComponentMatches(part, secretParts[s] ?? "") && matchFrom(p + 1, s + 1);
	};
	return matchFrom(0, 0);
}

/** Whether a resolved path, glob components included, can name `secretsDir` itself or one of its ancestors. */
function pathCoversSecrets(path: string, secretsDir: string): boolean {
	if (!GLOB_CHAR.test(path)) return insideOrSelf(secretsDir, path);
	const parts = path.split("/");
	if (parts.length > secretsDir.split("/").length) return false;
	return parts.every((part, index) => globComponentMatches(part, secretsDir.split("/")[index] ?? ""));
}

/** `/proc/<pid>/root`, `/proc/self/root` and `/proc/thread-self/root` are the process's own view of `/`. */
const PROC_ROOT = /^\/proc\/(?:self|thread-self|\d+)\/root(?=\/|$)/;

function withoutProcRoot(path: string): string {
	return path.replace(PROC_ROOT, "") || "/";
}

/** `/proc/self/cwd` and `/proc/thread-self/cwd`: the working directory of the process opening the path. */
const PROC_SELF_CWD = /^\/proc\/(?:self|thread-self)\/cwd(?=\/|$)/;

/** Symlinks followed while resolving one path before giving up, the kernel's ELOOP limit. */
const MAX_LINKS = 40;

/**
 * Where an absolute `path` (`..` not yet folded) really leads, resolved component by component from the root the way
 * the kernel walks it: a symlink — dangling ones included — is replaced by its target (a relative target read from the
 * link's directory) and a `..` after one climbs from where the link led. The first missing component and everything
 * after it is a name still to be created and is appended as spelled. `/proc/self/cwd` and `/proc/thread-self/cwd`,
 * however they are reached (`/proc//self/cwd`, `/tmp/../proc/self/cwd`), are `cwd` — the shell's directory, not the
 * guard's. `undefined` when it cannot be judged: more than `MAX_LINKS` links (a cycle), an lstat/readlink error other
 * than a missing name, another process's `/proc/<pid>/cwd`, or a cwd alias while `cwd` is not known. Each caller reads
 * that as the blocking answer.
 */
function physicalPath(path: string, cwd?: string): string | undefined {
	const pending = path.split("/").filter((part) => part !== "");
	let current = "/";
	let links = 0;
	for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
		if (part === ".") continue;
		if (part === "..") {
			current = dirname(current);
			continue;
		}
		if (current === "/proc" && /^(?:self|thread-self|\d+)$/.test(part)) {
			let ahead = 0;
			while (pending[ahead] === ".") ahead++;
			if (pending[ahead] === "cwd") {
				if (cwd === undefined || /^\d/.test(part)) return undefined;
				pending.splice(0, ahead + 1);
				current = cwd;
				continue;
			}
		}
		const next = join(current, part);
		try {
			if (!lstatSync(next).isSymbolicLink()) {
				current = next;
				continue;
			}
			if (++links > MAX_LINKS) return undefined;
			const target = readlinkSync(next);
			if (isAbsolute(target)) current = "/";
			pending.unshift(...target.split("/").filter((piece) => piece !== ""));
		} catch (error) {
			// A missing name (or a file used as a directory, which the kernel refuses too) starts the part to be created.
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return resolve(next, ...pending);
			return undefined;
		}
	}
	return current;
}

/**
 * A path argument with its home and cwd spellings expanded (`expandWord`), as spelled (folded against `cwd`) and as
 * physically reached (`undefined` when that cannot be judged, and for a relative path or a cwd spelling while `cwd`
 * is not known). `/proc/self/cwd` stands for `cwd` — the process opening the path runs there — and another process's
 * `/proc/<pid>/cwd` cannot be judged.
 */
function locate(
	arg: string,
	cwd: string | undefined,
	userHome: string,
): { lexical: string; physical: string | undefined } {
	const expanded = expandWord(arg, userHome, cwd);
	if (expanded === undefined || (cwd === undefined && !isAbsolute(expanded)))
		return { lexical: arg, physical: undefined };
	const rooted = withoutProcRoot(isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`);
	const joined = globstarParents(
		cwd === undefined ? rooted : withoutProcRoot(rooted.replace(PROC_SELF_CWD, () => cwd)),
	);
	return { lexical: withoutProcRoot(resolve(joined)), physical: physicalPath(joined, cwd) };
}

/** A `**` component with a `..` right after it. */
const GLOBSTAR_PARENT = /(^|\/)\*\*\/\.\.(?=\/|$)/;

/**
 * `**` may match no directory, so a `..` after it may climb from where the `**` stands: `a/**\/..` is read as
 * `a/../**`, which names everything it can (folding the `..` into the `**` would keep only `a`).
 */
function globstarParents(path: string): string {
	let read = path;
	for (
		let next = read.replace(GLOBSTAR_PARENT, "$1../**");
		next !== read;
		next = read.replace(GLOBSTAR_PARENT, "$1../**")
	)
		read = next;
	return read;
}

/** `dev:ino` of every file under `dir` with another link; a missing directory or an entry gone before its stat is skipped. */
function inodesUnder(dir: string): Set<string> {
	const inodes = new Set<string>();
	let names: string[];
	try {
		names = readdirSync(dir, { recursive: true, encoding: "utf8" });
	} catch {
		return inodes;
	}
	for (const name of names) {
		try {
			const stat = statSync(join(dir, name), { bigint: true });
			if (stat.isFile() && stat.nlink > 1n) inodes.add(`${stat.dev}:${stat.ino}`);
		} catch {
			// Vanished or unreadable: it cannot be compared, so it is not counted as a link target.
		}
	}
	return inodes;
}

/** Entries looked at under one directory for a hard link to a secret; past it the walk is judged to reach one. */
const LINK_WALK_LIMIT = 20_000;

/**
 * Whether a file under `dir` (symlinks not followed, like `grep -r` and `rg`) shares its `dev:ino` with one of
 * `inodes`; true when the tree has more than {@link LINK_WALK_LIMIT} entries (fail closed).
 */
function linkedFileUnder(dir: string, inodes: Set<string>): boolean {
	const pending = [dir];
	let seen = 0;
	for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (++seen > LINK_WALK_LIMIT) return true;
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) {
				try {
					const stat = statSync(path, { bigint: true });
					if (stat.nlink > 1n && inodes.has(`${stat.dev}:${stat.ino}`)) return true;
				} catch {
					// Vanished or unreadable: nothing to compare.
				}
			}
		}
	}
	return false;
}

/** The directory a glob path is read under: the components before its first glob component. */
function globBase(path: string): string {
	const parts = path.split("/");
	const first = parts.findIndex((part) => GLOB_CHAR.test(part));
	return first < 0 ? path : parts.slice(0, first).join("/") || "/";
}

/**
 * One secrets judgment. Paths compare with the directory both as spelled and physically (symlinks, `/proc/…/root`);
 * an existing file with more than one link also compares its `dev:ino` with the directory's multiply linked files —
 * read at most once per judgment and never kept across judgments, since a rotated token gets a new inode. When a
 * secret file has another link, a glob and a recursive walk look for it under the directory they read.
 */
interface SecretsJudge {
	home: string;
	/** The secrets directory's own name (`secrets`). */
	name: string;
	locate(arg: string, cwd: string | undefined, argHome?: string): { lexical: string; physical: string | undefined };
	isSecretsDir(dir: string): boolean;
	reaches(arg: string, cwd: string | undefined, argHome?: string): boolean;
	covers(arg: string, cwd: string | undefined, argHome?: string): boolean;
}

function secretsJudge(secretsDir: string, userHome: string): SecretsJudge {
	const lexicalSecrets = resolve(secretsDir);
	// The configured directory itself unresolvable (a link cycle on its way): compare as spelled only.
	const physicalSecrets = physicalPath(lexicalSecrets) ?? lexicalSecrets;
	const home = resolve(userHome);
	let inodes: Set<string> | undefined;
	const hardLinked = (path: string): boolean => {
		let stat: BigIntStats;
		try {
			stat = statSync(path, { bigint: true });
		} catch {
			return false;
		}
		if (!stat.isFile() || stat.nlink < 2n) return false;
		inodes ??= inodesUnder(physicalSecrets);
		return inodes.has(`${stat.dev}:${stat.ino}`);
	};
	/** A hard link to a secret file somewhere under `dir`; nothing to look for while no secret file has one. */
	const linkedUnder = (dir: string): boolean => {
		inodes ??= inodesUnder(physicalSecrets);
		return inodes.size > 0 && linkedFileUnder(dir, inodes);
	};
	return {
		home,
		name: basename(lexicalSecrets),
		locate: (arg: string, cwd: string | undefined, argHome = home) => locate(arg, cwd, argHome),
		isSecretsDir: (dir: string): boolean => insideOrSelf(dir, lexicalSecrets) || insideOrSelf(dir, physicalSecrets),
		reaches(arg: string, cwd: string | undefined, argHome = home): boolean {
			const { lexical, physical } = locate(arg, cwd, argHome);
			// Where it leads cannot be judged: it may lead in.
			if (physical === undefined) return true;
			if (pathReachesSecrets(lexical, lexicalSecrets) || pathReachesSecrets(physical, physicalSecrets)) return true;
			return GLOB_CHAR.test(physical) ? linkedUnder(globBase(physical)) : hardLinked(physical);
		},
		/**
		 * Whether `arg` names the secrets directory or an ancestor of it, or a directory holding a hard link to a
		 * secret file: a recursive walk from there reaches it.
		 */
		covers(arg: string, cwd: string | undefined, argHome = home): boolean {
			const { lexical, physical } = locate(arg, cwd, argHome);
			if (physical === undefined) return true;
			if (pathCoversSecrets(lexical, lexicalSecrets) || pathCoversSecrets(physical, physicalSecrets)) return true;
			return linkedUnder(globBase(physical));
		},
	};
}

const ANSI_C_ESCAPES: Record<string, string> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
};

/**
 * The text of an ANSI-C quoted string (`$'…'`) whose body starts at `start`, decoded the way bash does
 * (`\057`, `\x2f`, `\u002f`, `\n`…), and the index of its closing quote (the last index when unterminated).
 */
function ansiC(command: string, start: number): { text: string; end: number } {
	let text = "";
	let i = start;
	for (; i < command.length; i++) {
		const ch = command.charAt(i);
		if (ch === "'") return { text, end: i };
		if (ch !== "\\" || i + 1 >= command.length) {
			text += ch;
			continue;
		}
		const rest = command.slice(i + 1);
		const octal = /^[0-7]{1,3}/.exec(rest);
		const hex =
			/^x([0-9A-Fa-f]{1,2})/.exec(rest) ?? /^u([0-9A-Fa-f]{1,4})/.exec(rest) ?? /^U([0-9A-Fa-f]{1,8})/.exec(rest);
		if (octal !== null) {
			text += String.fromCharCode(Number.parseInt(octal[0], 8) & 0xff);
			i += octal[0].length;
		} else if (hex?.[1] !== undefined) {
			const code = Number.parseInt(hex[1], 16);
			text += code <= 0x10ffff ? String.fromCodePoint(code) : "";
			i += hex[0].length;
		} else if (rest.startsWith("c") && rest.length > 1) {
			text += String.fromCharCode(rest.charCodeAt(1) & 0x1f);
			i += 2;
		} else {
			const next = rest.charAt(0);
			text += ANSI_C_ESCAPES[next] ?? next;
			i += 1;
		}
	}
	return { text, end: i - 1 };
}

/** Most words one brace expansion yields; past it the rest is not judged (a mistake guard, not a sandbox). */
const BRACE_LIMIT = 256;

/**
 * The words a shell brace expansion makes of `word` (`a{b,c}d` → `abd`, `acd`; nested and `{x..y}` sequences too),
 * at most {@link BRACE_LIMIT}; the word itself when it has none. Quotes are already gone, so a quoted `{a,b}` is
 * expanded too — that only adds candidates to judge.
 */
function expandBraces(word: string): string[] {
	for (let i = word.indexOf("{"); i >= 0; i = word.indexOf("{", i + 1)) {
		const parts = braceParts(word, i);
		if (parts === undefined) continue;
		const words: string[] = [];
		for (const part of parts.items) {
			words.push(...expandBraces(`${word.slice(0, i)}${part}${word.slice(parts.close + 1)}`));
			if (words.length >= BRACE_LIMIT) return words.slice(0, BRACE_LIMIT);
		}
		return words;
	}
	return [word];
}

/** The items of the brace expression opening at `open` and its closing index; `undefined` when bash keeps it literal. */
function braceParts(word: string, open: number): { items: string[]; close: number } | undefined {
	let depth = 0;
	const commas: number[] = [];
	for (let j = open; j < word.length; j++) {
		const ch = word.charAt(j);
		if (ch === "{") depth++;
		else if (ch === "," && depth === 1) commas.push(j);
		else if (ch === "}" && --depth === 0) {
			if (commas.length > 0) {
				const items: string[] = [];
				let from = open + 1;
				for (const comma of [...commas, j]) {
					items.push(word.slice(from, comma));
					from = comma + 1;
				}
				return { items, close: j };
			}
			const sequence = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])$/.exec(word.slice(open + 1, j));
			const items = sequence === null ? undefined : braceSequence(sequence[1] as string, sequence[2] as string);
			return items === undefined ? undefined : { items, close: j };
		}
	}
	return undefined;
}

/** `{a..e}` / `{1..3}` items; `undefined` for a mixed letter/number pair, which bash keeps literal. */
function braceSequence(from: string, to: string): string[] | undefined {
	const numeric = /\d/.test(from);
	if (numeric !== /\d/.test(to)) return undefined;
	const a = numeric ? Number(from) : from.charCodeAt(0);
	const b = numeric ? Number(to) : to.charCodeAt(0);
	// A run past the limit is cut: the words past it are not judged anyway.
	const step = a <= b ? 1 : -1;
	const items: string[] = [];
	for (let n = a; step > 0 ? n <= b : n >= b; n += step) {
		items.push(numeric ? String(n) : String.fromCharCode(n));
		if (items.length >= BRACE_LIMIT) break;
	}
	return items;
}

/**
 * Shell segments (split on `;` `|` `&` `(` `)` and newlines) of words (split on blanks, `<` and `>`). Operators count
 * only outside quotes — `echo "a > b; c"` is one command — and quote characters are dropped; a backslash outside
 * single quotes makes the next character literal. Blanks split quoted text too, so a quoted command line
 * (`bash -c "cat …"`) still has its paths judged, and a newline inside quotes stands as a `;` word between the words
 * around it, so the command line a shell or `eval` rebuilds from them keeps its commands apart. A command
 * substitution — `$( … )` inside double quotes, backticks anywhere outside single quotes — is command syntax again
 * until it closes: its operators and redirections split there too.
 */
interface ShellSegment {
	words: string[];
	/**
	 * What ended it: `(` opens a subshell or a substitution and `)` closes one, `|` pipes it into the next segment,
	 * `;` is any other operator or a newline, and `""` the end of the command line.
	 */
	end: "(" | ")" | "|" | ";" | "";
	/** Its words that start right where a subshell or substitution closed (`/x` of `"$(pwd)"/x`). */
	glued: string[];
}

function shellSegments(command: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let words: string[] = [];
	let glued: string[] = [];
	let word = "";
	/** The word being read starts right where a subshell or substitution closed. */
	let afterClose = false;
	let quote = "";
	/** Open substitutions: the quote to go back to when one closes and, for `$(`, the parentheses opened inside it. */
	const substitutions: Array<{ quote: string; backtick: boolean; depth: number }> = [];
	const endWord = (): void => {
		if (word !== "") {
			words.push(word);
			if (afterClose) glued.push(word);
		}
		word = "";
		afterClose = false;
	};
	const endSegment = (end: ShellSegment["end"]): void => {
		endWord();
		segments.push({ words, end, glued });
		words = [];
		glued = [];
		afterClose = end === ")";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command.charAt(i);
		if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
			i++;
			if (command.charAt(i) !== "\n") word += command.charAt(i);
		} else if (quote === "" && ch === "$" && command.charAt(i + 1) === "'") {
			const { text, end } = ansiC(command, i + 2);
			word += text;
			i = end;
		} else if (quote === "" && ch === "$" && command.charAt(i + 1) === '"') {
			// `$"…"` is a double-quoted string translated by the locale: the same text in the C locale.
			quote = '"';
			i++;
		} else if (quote === '"' && ch === "$" && command.charAt(i + 1) === "(") {
			word += ch;
			substitutions.push({ quote, backtick: false, depth: 0 });
			quote = "";
			i++;
			endSegment("(");
		} else if (ch === "`" && quote !== "'") {
			const open = substitutions.at(-1);
			if (open?.backtick === true) {
				substitutions.pop();
				quote = open.quote;
				endSegment(")");
			} else {
				// Kept on the word it opens in, like the `$` of `$(`: a `cd` to it cannot be followed.
				word += ch;
				substitutions.push({ quote, backtick: true, depth: 0 });
				quote = "";
				endSegment("(");
			}
		} else if (quote === "" ? ch === '"' || ch === "'" : ch === quote) quote = quote === "" ? ch : "";
		else if (quote === "" && /[;|&()\n]/.test(ch)) {
			const open = substitutions.at(-1);
			if (open !== undefined && !open.backtick && ch === "(") open.depth++;
			else if (open !== undefined && !open.backtick && ch === ")") {
				if (open.depth > 0) open.depth--;
				else {
					substitutions.pop();
					quote = open.quote;
				}
			}
			// `|` and `|&` pipe; `||` is a list operator like `;` and `&&`.
			const pipe = ch === "|" && command.charAt(i + 1) !== "|" && command.charAt(i - 1) !== "|";
			if (pipe && command.charAt(i + 1) === "&") i++;
			endSegment(ch === "(" || ch === ")" ? ch : pipe ? "|" : ";");
		} else if (quote !== "" && ch === "\n") {
			endWord();
			words.push(";");
		} else if ((quote === "" && (ch === "<" || ch === ">")) || /\s/.test(ch)) endWord();
		else word += ch;
	}
	endSegment("");
	return segments;
}

/**
 * A value glued to an option, minus one leading `@`, when it looks like a path (`/`, `~`, `$HOME`, `${HOME}` first, or
 * a `/` in it). Anything else (`a` of `ls -la`, `n` of `grep -rn`) is no operand: with an unknown cwd any relative one
 * would refuse the command.
 */
function gluedPath(value: string): string | undefined {
	const path = value.startsWith("@") ? value.slice(1) : value;
	return /^(?:~|\$HOME|\$\{HOME\})/.test(path) || path.includes("/") ? path : undefined;
}

/**
 * Bash touching the bot secrets directory is refused without a card (hard floor 3). Judged by path, not by text:
 * the command splits on `;` `&&` `||` `|` `&` parentheses, newlines and redirections outside quotes, a virtual cwd
 * follows `cd` / `pushd` / `popd` (behind `time`, `command`, `builtin`, `{`, `!`, `if`/`then`/`do`… and `NAME=value`
 * prefixes, after their options and `--`), and every argument not starting with `-` (and every `=value`, and a value
 * glued to a short option or an `@` when it looks like a path: `-o/x`, `-d@~/x`, `@a/b`, never the `a` of `ls -la`) is expanded
 * (`~`, `~+`, `$HOME` / `$PWD` anywhere in it, braced or behind an operator that keeps the value, ANSI-C `$'…'`,
 * braces `{a,b}` / `{a..z}`; another operator such as `${HOME:0}` cannot be judged), resolved against that cwd and
 * compared component by component — glob components
 * (`secre*`, `*`) match the secrets directory's own names — then again after symlinks resolve, and an existing hard
 * link by inode. A `HOME` set on the way (`HOME=…`, `export HOME=…`, `env HOME=…`) adds what `~` may mean from then
 * on. A directory change it cannot resolve (`cd "$D"`, `cd $(…)`, `pushd +1`, a relative `cd` with
 * `CDPATH` set) makes the cwd unknown, and any relative argument after it is refused (fail closed); a `cd` to a
 * directory it cannot see may fail at run time, so the directory before it stays a candidate. A recursive search
 * (`grep -r`, `rg`) rooted at the secrets directory or one of its ancestors is refused too, cwd known or not, and so
 * is a copy or archive (`cp -a`, `tar`, `rsync`, `zip -r`) of one and a `find` that runs, deletes or writes from one —
 * named by path (`/bin/grep`) or behind a wrapper (`env`, `nice`, `xargs`…) — and a `find` listing one whose output
 * a later `xargs` or `read` takes. A command line given to `bash -c`, `eval` or `env -S` is judged as one, from the
 * same cwd, and the command after `env -C <dir>` from that directory.
 * A mistake guard, not a sandbox: variables assembled at run time and script files are not seen.
 */
export function bashTouchesSecrets(command: string, secretsDir: string, context: BashPathContext): boolean {
	if (secretsDir === "") return false;
	const start = physicalPath(resolve(context.cwd));
	const judge = secretsJudge(secretsDir, context.userHome);
	return commandTouchesSecrets(command, judge, start === undefined ? undefined : [start], [judge.home]);
}

/** Commands that read paths from their standard input: a listing piped into them is read file by file. */
const STDIN_PATH_READERS: Record<string, true> = {
	xargs: true,
	parallel: true,
	read: true,
	mapfile: true,
	readarray: true,
	cpio: true,
};

/**
 * {@link bashTouchesSecrets} for one command line run from `startCwds`: every directory the shell may stand in
 * (`undefined`: a directory change the guard could not resolve), with `startHomes` every directory `~` may stand for
 * (`undefined`: a `HOME` the guard could not resolve).
 */
function commandTouchesSecrets(
	command: string,
	judge: SecretsJudge,
	startCwds: string[] | undefined,
	startHomes: string[] | undefined,
): boolean {
	let cwds = startCwds;
	let homes = startHomes;
	/** Judged against every home `~` may stand for; a home spelling with the home unknown cannot be judged. */
	const judged = (check: "reaches" | "covers", arg: string, at: string | undefined): boolean =>
		homes === undefined
			? USES_HOME.test(arg) || judge[check](arg, at)
			: homes.some((home) => judge[check](arg, at, home));
	/** A `find` earlier in this command line listed the secrets directory or an ancestor of it. */
	let listed = false;
	// OLDPWD and the directory stack may come from earlier calls of the same shell: unknown until set here.
	let oldCwds: string[] | undefined;
	const stack: Array<string[] | undefined> = [];
	/** `CDPATH` set by an earlier segment (`CDPATH=…;`, `export CDPATH=…`). */
	let cdpath = false;
	const segments = shellSegments(command);
	/** The directories each open subshell or substitution was entered from. */
	const scopes: Array<string[] | undefined> = [];
	/** The directories the previous segment started from. */
	let previousStart = cwds;
	for (const [index, { words, glued: afterSubstitution }] of segments.entries()) {
		// A subshell, a substitution and every element of a pipeline run in a child shell: a `cd` there leaves the
		// directories before it candidates once it ends.
		const previous = segments[index - 1];
		if (previous?.end === "|" || segments[index - 2]?.end === "|") cwds = eitherDirs(previousStart, cwds);
		if (previous?.end === "(") scopes.push(cwds);
		else if (previous?.end === ")" && scopes.length > 0) cwds = eitherDirs(scopes.pop(), cwds);
		previousStart = cwds;
		// What a substitution prints is not known: a word glued after one that goes on into a directory named like the
		// secrets directory may be in it (`"$(pwd)"/../secrets/x`).
		if (
			afterSubstitution
				.flatMap(expandBraces)
				.some((word) => word.split("/").some((part) => globComponentMatches(part, judge.name)))
		)
			return true;
		const { assigns, name, args } = simpleCommand(words);
		homes = homesAfter(words, homes, cwds);
		const spelled = [...assigns, ...args].flatMap((word) => {
			const eq = word.indexOf("=");
			const values = word.startsWith("-") ? [] : [word];
			if (eq >= 0 && eq + 1 < word.length) values.push(word.slice(eq + 1));
			// A value glued to a short option (`-o<path>`, `-d@<path>`) or behind `@` (curl's `@<file>`).
			const glued = [...(/^-[^-]./.test(word) ? [word.slice(2)] : []), ...values.filter((v) => v.startsWith("@"))];
			for (const value of glued) {
				const path = gluedPath(value);
				if (path !== undefined) values.push(path);
			}
			return values;
		});
		if (name?.includes("/")) spelled.push(name);
		const commands = name === undefined ? [] : commandsIn(name, args);
		// A path written in interpreter code is judged when it names a directory like the secrets one.
		for (const run of commands) {
			if (INTERPRETER.test(run.name)) spelled.push(...codePaths(run.args, judge.name));
		}
		const operands = spelled.flatMap(expandBraces).flatMap((word) => [word, ...fileUrlPaths(word)]);
		const dirChange = name === "cd" || name === "pushd" || name === "popd";
		const setsCdpath = (word: string) => word.startsWith("CDPATH=");
		if (name === undefined ? assigns.some(setsCdpath) : DECLARES[name] === true && args.some(setsCdpath)) cdpath = true;
		/** Resolved against the cwd: `/proc/self/cwd` is the cwd too. */
		const relative = (arg: string) => (!isAbsolute(arg) && !HOME_PREFIX.test(arg)) || PROC_SELF_CWD.test(arg);
		if (cwds === undefined) {
			if (!dirChange && operands.some(relative)) return true;
			if (operands.some((arg) => !relative(arg) && judged("reaches", arg, undefined))) return true;
			// An absolute root needs no cwd: copying or archiving an ancestor is judged the same.
			for (const walk of commands.map(walkOf)) {
				if (walk.roots.some((arg) => !relative(arg) && judged("covers", arg, undefined))) return true;
			}
		} else {
			const known = cwds;
			if (operands.some((arg) => known.some((at) => judged("reaches", arg, at)))) return true;
			for (const walk of commands.map(walkOf)) {
				for (const at of known) {
					// A tar member is read from under its `-C` / `--directory` too.
					const bases = [at];
					for (const dir of walk.dirs) {
						if (homes === undefined && USES_HOME.test(dir)) return true;
						for (const home of homes ?? [judge.home]) {
							const base = judge.locate(dir, at, home).physical;
							if (base === undefined) return true;
							bases.push(base);
						}
					}
					if (walk.dirs.length > 0 && operands.some((arg) => bases.some((base) => judged("reaches", arg, base))))
						return true;
					if (walk.roots.some((arg) => bases.some((base) => judged("covers", arg, base)))) return true;
				}
			}
		}
		for (const { name: run, args: runArgs } of commands) {
			if (run === "find") {
				const roots = findRoots(runArgs);
				if (roots.some((root) => (cwds ?? [undefined]).some((at) => judged("covers", root, at)))) listed = true;
			}
			if (listed && STDIN_PATH_READERS[run] === true) return true;
			const chdir = run === "env" ? envChdir(runArgs) : undefined;
			if (
				chdir !== undefined &&
				commandTouchesSecrets(chdir.rest.join(" "), judge, resolveDirs(chdir.dir, judge, cwds, homes, false), homes)
			)
				return true;
			const inner = innerCommandLine(run, runArgs);
			if (inner !== undefined && commandTouchesSecrets(inner, judge, cwds, homes)) return true;
		}
		if (!dirChange) continue;
		const viaCdpath = cdpath || assigns.some(setsCdpath);
		const dirArgs = dirOperands(args);
		const target = dirArgs[0];
		const before = cwds;
		if (name === "popd") cwds = dirArgs.length === 0 ? stack.pop() : undefined;
		else if (name === "pushd" && args.includes("-n")) {
			stack.push(target === undefined ? undefined : resolveDirs(target, judge, cwds, homes, viaCdpath));
			continue;
		} else if (name === "pushd" && (target === undefined || /^[+-]\d+$/.test(target))) cwds = undefined;
		else if (target === "-") cwds = oldCwds;
		// A bare `cd` goes to the home: every one `~` may stand for.
		else cwds = resolveDirs(target ?? "~", judge, cwds, homes, viaCdpath);
		if (name === "pushd") stack.push(before);
		oldCwds = before;
		if (cwds?.some((at) => judge.isSecretsDir(at)) === true) return true;
	}
	return false;
}

/**
 * Every directory a `cd` / `pushd` to `target` may leave the shell in, from each of `cwds` and with `~` standing for
 * each of `homes`; `undefined` when that cannot be judged (a variable, a substitution, an unknown cwd or home under a
 * relative or home target, a relative target searched through `CDPATH`). A target not seen as a directory may fail
 * to change into, so the directories before it stay candidates.
 */
function resolveDirs(
	target: string,
	judge: SecretsJudge,
	cwds: string[] | undefined,
	homes: string[] | undefined,
	viaCdpath: boolean,
): string[] | undefined {
	if (homes === undefined && USES_HOME.test(target)) return undefined;
	const found = new Set<string>();
	for (const home of homes ?? [judge.home]) {
		for (const base of cwds ?? [undefined]) {
			const expanded = expandWord(target, home, base);
			if (expanded === undefined || /[$`]/.test(expanded) || expanded.startsWith("~")) return undefined;
			// `CDPATH` is searched for a relative target not starting with `.` or `..`.
			if (viaCdpath && !isAbsolute(expanded) && !/^\.\.?(?:\/|$)/.test(expanded)) return undefined;
			const physical = judge.locate(expanded, base, home).physical;
			if (physical === undefined) return undefined;
			found.add(physical);
			if (!isDirectory(physical)) {
				if (cwds === undefined) return undefined;
				for (const at of cwds) found.add(at);
			}
		}
	}
	return [...found];
}

/**
 * The homes `~` and `$HOME` may stand for after the words of one segment: those before it, plus the value of every
 * `HOME=…` / `HOME+=…` word in it — an assignment, `export` / `declare` and `env` arguments alike, whether it lasts
 * past this command or not. `undefined` when a value cannot be judged (a variable or substitution, a relative value
 * with the cwd unknown).
 */
function homesAfter(words: string[], homes: string[] | undefined, cwds: string[] | undefined): string[] | undefined {
	let next = homes;
	for (const word of words) {
		const set = /^HOME(\+?)=(.*)$/s.exec(word);
		if (set === null) continue;
		if (next === undefined) return undefined;
		const values = new Set(next);
		for (const home of next) {
			for (const at of cwds ?? [undefined]) {
				const expanded = expandWord(set[2] as string, home, at);
				const value = set[1] === "+" && expanded !== undefined ? `${home}${expanded}` : expanded;
				if (value === undefined || /[$`]/.test(value) || value.startsWith("~")) return undefined;
				if (isAbsolute(value)) values.add(resolve(value));
				else if (at === undefined) return undefined;
				else values.add(resolve(at, value));
			}
		}
		next = [...values];
	}
	return next;
}

/**
 * The directory `env -C <dir>` / `-C<dir>` / `--chdir[=]<dir>` runs its command in and the words after it; `undefined`
 * when the options name none. Option clusters (`-iC <dir>`) and `-u <name>` before it are read too.
 */
function envChdir(args: string[]): { dir: string; rest: string[] } | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--chdir" || arg === "--unset" || arg === "-u") {
			if (arg === "--chdir" && args[i + 1] !== undefined)
				return { dir: args[i + 1] as string, rest: args.slice(i + 2) };
			i++;
		} else if (arg.startsWith("--chdir=")) return { dir: arg.slice(8), rest: args.slice(i + 1) };
		else if (/^-[^-]/.test(arg)) {
			// Letters until one that takes a value: `C` is the directory, `u` / `S` take theirs.
			const valued = /[CuS]/.exec(arg.slice(1));
			if (valued?.[0] === "C") {
				const glued = arg.slice(valued.index + 2);
				if (glued !== "") return { dir: glued, rest: args.slice(i + 1) };
				if (args[i + 1] !== undefined) return { dir: args[i + 1] as string, rest: args.slice(i + 2) };
			}
			if (valued?.[0] === "u" && arg.length === valued.index + 2) i++;
			if (valued?.[0] === "S") return undefined;
		} else if (!ASSIGNMENT.test(arg) && arg !== "-") return undefined;
	}
	return undefined;
}

/** Builtins that set a shell variable named in their arguments (`export CDPATH=…`). */
const DECLARES: Record<string, true> = { export: true, declare: true, typeset: true, readonly: true, local: true };

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The command a segment runs, by its name without a directory (`/bin/grep` → `grep`), and — behind a wrapper that
 * runs the rest of its arguments here (`env`, `nice`, `timeout`, `xargs`, a shell…; not `ssh`) — every later word as
 * a command of its own with the words after it.
 */
function commandsIn(name: string, args: string[]): Array<{ name: string; args: string[] }> {
	const command = basename(name);
	const commands = [{ name: command, args }];
	if (COMMAND_WRAPPERS[command] !== true || command === "ssh") return commands;
	args.forEach((word, index) => {
		commands.push({ name: basename(word), args: args.slice(index + 1) });
	});
	return commands;
}

/**
 * What a command walks: the roots of a recursive search (the cwd when only the pattern is given), copy or archive,
 * or of a `find` that runs, deletes or writes (`-exec`, `-delete`, `-fprint`…), and a tar's `-C` / `--directory`
 * directories.
 */
function walkOf({ name, args }: { name: string; args: string[] }): { roots: string[]; dirs: string[] } {
	const paths = args.filter((arg) => !arg.startsWith("-"));
	if (recursiveSearch(name, args)) return { roots: paths.length <= 1 ? [...paths, "."] : paths, dirs: [] };
	if (name === "find") return { roots: findActs(args) ? findRoots(args) : [], dirs: [] };
	if (!recursiveCopy(name, args)) return { roots: [], dirs: [] };
	if (name !== "tar") return { roots: paths, dirs: [] };
	const dirs = args.flatMap((arg) => {
		const glued = /^(?:-C|--directory=)(.+)$/.exec(arg);
		return glued?.[1] === undefined ? [] : [glued[1]];
	});
	args.forEach((arg, index) => {
		const next = args[index + 1];
		if ((arg === "-C" || arg === "--directory") && next !== undefined) dirs.push(next);
	});
	return { roots: [...paths, ...dirs], dirs };
}

/** A `find` expression with an action that reads, runs, deletes or writes, not only lists. */
function findActs(args: string[]): boolean {
	return args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(arg));
}

/** `find`'s starting points: the words before its expression, past `-H` / `-L` / `-P`, `-D <list>`, `-O<n>`; `.` when none. */
function findRoots(args: string[]): string[] {
	let i = 0;
	while (i < args.length && /^-(?:[HLP]|D|O\d*)$/.test(args[i] as string)) i += args[i] === "-D" ? 2 : 1;
	const roots: string[] = [];
	for (; i < args.length && !/^[-(!),]/.test(args[i] as string); i++) roots.push(args[i] as string);
	return roots.length === 0 ? ["."] : roots;
}

/** Every directory either list holds; unknown when either is. */
function eitherDirs(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
	if (a === undefined || b === undefined) return undefined;
	return [...new Set([...a, ...b])];
}

/** Interpreters that take code as an argument (`python3 -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `awk '…'`). */
const INTERPRETER = /^(?:python[\d.]*|pypy3?|node(?:js)?|bun|deno|ruby|perl|php[\d.]*|[gmn]?awk|lua[\d.]*|tclsh)$/;

/**
 * The path strings in an interpreter's arguments that have a component spelled `name` (`open('…/secrets/x')` →
 * `…/secrets/x`): code is not parsed, a string that names the secrets directory by its name is judged as a path.
 */
function codePaths(args: string[], name: string): string[] {
	return args.flatMap((arg) => arg.split(/[\s'"`(),;+{}[\]<>|&=]+/)).filter((token) => token.split("/").includes(name));
}

/**
 * The path a `file:` URL word names, as spelled and percent-decoded (`file:///x`, `file://localhost/x`, `file:/x`,
 * `file://$HOME/x`); none for any other word.
 */
function fileUrlPaths(word: string): string[] {
	const path = /^file:(?:\/\/(?:localhost(?=\/))?)?(.+)$/is.exec(word)?.[1];
	if (path === undefined) return [];
	try {
		const decoded = decodeURIComponent(path);
		return decoded === path ? [path] : [path, decoded];
	} catch {
		return [path];
	}
}

/** Shells whose `-c` argument is a command line. */
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true };

/**
 * The command line a command runs as its own (`bash -c '…'`, `eval …`, `env -S '…'`), rebuilt from the words the
 * segment split it into; `undefined` for any other command.
 */
function innerCommandLine(name: string, args: string[]): string | undefined {
	if (name === "eval") return args.join(" ");
	if (SHELLS[name] === true) {
		const option = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
		return option < 0 ? undefined : args.slice(option + 1).join(" ");
	}
	if (name !== "env") return undefined;
	const option = args.findIndex((arg) => /^(?:-S|--split-string(?:=|$))/.test(arg));
	if (option < 0) return undefined;
	const glued = (args[option] as string).replace(/^(?:-S|--split-string=?)/, "");
	return [glued, ...args.slice(option + 1)].join(" ");
}

/** Shell words that may stand before a command name without being it; `time`/`command`/`builtin` take options. */
// A Set, not a Record: an object with a `then` key is a thenable.
const COMMAND_PREFIX_WORDS = new Set(["{", "!", "if", "then", "elif", "else", "do", "while", "until"]);
const COMMAND_RUNNERS: Record<string, true> = { time: true, command: true, builtin: true };
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** One segment as `NAME=value` prefixes, the command name and its arguments, past keywords and runner words. */
function simpleCommand(words: string[]): { assigns: string[]; name?: string; args: string[] } {
	const assigns: string[] = [];
	let i = 0;
	while (i < words.length) {
		const word = words[i] as string;
		if (COMMAND_PREFIX_WORDS.has(word)) i++;
		else if (ASSIGNMENT.test(word)) {
			assigns.push(word);
			i++;
		} else if (COMMAND_RUNNERS[word] === true) {
			i++;
			while (words[i]?.startsWith("-") === true) i++;
		} else break;
	}
	return { assigns, name: words[i], args: words.slice(i + 1) };
}

/** `cd` / `pushd` / `popd` arguments past their options (`-P`, `-L`, `-e`, `-@`, `-n`) and `--`; a lone `-` is kept. */
function dirOperands(args: string[]): string[] {
	const end = args.indexOf("--");
	const options = end < 0 ? args : args.slice(0, end);
	const rest = end < 0 ? [] : args.slice(end + 1);
	return [...options.filter((arg) => arg === "-" || !/^-[A-Za-z@]+$/.test(arg)), ...rest];
}

/** A search that walks directories: `rg`, or `grep` with a recursive option. */
function recursiveSearch(name: string, args: string[]): boolean {
	if (name === "rg") return true;
	if (name !== "grep" && name !== "egrep" && name !== "fgrep") return false;
	return args.some(
		(arg) =>
			/^-[A-Za-z]*[rR]/.test(arg) ||
			arg === "--recursive" ||
			arg === "--dereference-recursive" ||
			arg === "--directories=recurse" ||
			arg === "recurse",
	);
}

/**
 * A copy or archive that reads whole directories: `cp` / `scp` with `-r` / `-R` / `-a` / `--recursive` / `--archive`,
 * `rsync`, `tar`, `zip -r` / `-R` / `--recurse-paths` and `7z`. Walks that only list (`find`, `du`, `ls -R`) are not
 * copies: from home their `.` would cover the secrets directory and block everyday commands.
 */
function recursiveCopy(name: string, args: string[]): boolean {
	if (name === "rsync" || name === "tar" || name === "7z") return true;
	if (name === "cp" || name === "scp")
		return args.some((arg) => /^-[A-Za-z]*[rRa]/.test(arg) || arg === "--recursive" || arg === "--archive");
	if (name === "zip") return args.some((arg) => /^-[A-Za-z]*[rR]/.test(arg) || arg === "--recurse-paths");
	return false;
}

/** Input keys that name a path in non-Bash tools (Read, Glob, Grep, LS, NotebookRead and the edit tools). */
const TOOL_PATH_KEYS = ["file_path", "notebook_path", "path"];

function fileUrlPath(url: string): string {
	try {
		return decodeURIComponent(new URL(url).pathname);
	} catch {
		return url.replace(/^file:\/*/i, "/");
	}
}

/** Tools that walk a directory tree from their `path` input (the cwd when it is absent). */
const RECURSIVE_TOOLS: Record<string, true> = { Grep: true, Glob: true, LS: true };

/**
 * A non-Bash tool touching the secrets directory, judged like a Bash argument: its path inputs, a Glob `pattern` and a
 * Grep `glob` / `include` (under its `path`, else the cwd) and a `file://` URL (WebFetch). A `path` input — for
 * Grep, Glob and LS also the cwd they default to — naming the secrets directory or an ancestor of it is a walk into it.
 */
function toolTouchesSecrets(
	toolName: string,
	input: Record<string, unknown>,
	secretsDir: string,
	context: BashPathContext,
): boolean {
	if (secretsDir === "") return false;
	const judge = secretsJudge(secretsDir, context.userHome);
	const cwd = physicalPath(resolve(context.cwd));
	// An unresolvable cwd: relative paths and default walks could start anywhere.
	if (cwd === undefined) return true;
	const args = TOOL_PATH_KEYS.map((key) => input[key]).filter(
		(value): value is string => typeof value === "string" && value !== "",
	);
	const { pattern, path, url } = input;
	const root = typeof path === "string" && path !== "" ? path : undefined;
	const nestedPatterns = [
		toolName === "Glob" ? pattern : undefined,
		toolName === "Grep" ? input.glob : undefined,
		toolName === "Grep" ? input.include : undefined,
	];
	for (const nested of nestedPatterns) {
		if (typeof nested !== "string" || nested === "") continue;
		const under = root !== undefined && !isAbsolute(nested) && !HOME_PREFIX.test(nested);
		args.push(under ? `${root}/${nested}` : nested);
	}
	if (typeof url === "string" && /^file:/i.test(url)) args.push(fileUrlPath(url));
	if (args.some((arg) => judge.reaches(arg, cwd))) return true;
	if (root !== undefined) return judge.covers(root, cwd);
	return RECURSIVE_TOOLS[toolName] === true && judge.covers(".", cwd);
}

/**
 * Whether every path the edit tool targets stays inside `cwd`, both compared after symlinks resolve (a link in the
 * workspace pointing at `~` is not a way out) and not through a hard link (an existing file with more than one link
 * may share its inode with a file outside); `~` / `$HOME` expand to `userHome`.
 */
export function editsInside(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	userHome: string = homedir(),
): boolean {
	const keys = EDIT_PATH_KEYS[toolName];
	if (keys === undefined) return false;
	const realCwd = physicalPath(resolve(cwd));
	if (realCwd === undefined) return false;
	const home = resolve(userHome);
	for (const key of keys) {
		const value = input[key];
		if (typeof value !== "string" || value === "") return false;
		const { physical } = locate(value, realCwd, home);
		// Unjudgeable (a link cycle): not shown to stay inside.
		if (physical === undefined || !isInside(physical, realCwd) || hasOtherLinks(physical)) return false;
	}
	return true;
}

/** An existing file with another hard link: editing it also changes that name, which may be outside the workspace. */
function hasOtherLinks(path: string): boolean {
	try {
		const stat = statSync(path);
		return stat.isFile() && stat.nlink > 1;
	} catch {
		return false;
	}
}

/** The permission answer the driver writes back to the CLI. */
export type PermissionDecision =
	| { behavior: "allow"; updatedInput: Record<string, unknown> }
	| { behavior: "deny"; message: string };

export interface ClassifyInput {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	/** Bot secrets directory; any tool referencing it is denied outright. */
	secretsDir?: string;
	/** Home that `~` / `$HOME` expand to when judging secrets access; default `os.homedir()`. */
	userHome?: string;
	/** Asks the owner (Slack approval card). Absent → dangerous Bash is denied. */
	ask?: (request: { toolName: string; command: string; description?: string }) => Promise<boolean>;
}

/**
 * Decision for one `can_use_tool` control request. Any tool touching the
 * secrets dir is denied (Bash by its arguments, other tools by their path
 * inputs and `file://` URLs); edit tools inside the workspace and every other
 * non-Bash tool are allowed; Bash matching a dangerous pattern goes to an owner
 * card (`ask` returning true approves it).
 */
export async function classifyPermission(classify: ClassifyInput): Promise<PermissionDecision> {
	const { toolName, input, cwd, secretsDir } = classify;
	const userHome = classify.userHome ?? homedir();
	const secretsDenied = (): PermissionDecision =>
		deny(`비밀 디렉터리(${secretsDir}) 접근은 금지되어 있습니다. / secrets directory access is forbidden`);
	if (toolName === "Bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (command === "") return deny("Bash call without a command");
		if (secretsDir !== undefined && bashTouchesSecrets(command, secretsDir, { cwd, userHome })) return secretsDenied();
		if (!isDangerousBash(command)) return allow(input);
		if (classify.ask === undefined) {
			return deny(
				"위험 명령이라 자동 거부됐습니다 (승인 채널 없음). / dangerous command auto-denied (no approval channel)",
			);
		}
		const approved = await classify.ask({
			toolName,
			command,
			description: typeof input.description === "string" && input.description !== "" ? input.description : undefined,
		});
		return approved ? allow(input) : deny("오너가 승인하지 않았습니다. / the owner did not approve this command");
	}
	if (secretsDir !== undefined && toolTouchesSecrets(toolName, input, secretsDir, { cwd, userHome })) {
		return secretsDenied();
	}
	if (EDIT_TOOLS[toolName] === true) {
		if (editsInside(toolName, input, cwd, userHome)) return allow(input);
		return {
			behavior: "deny",
			message:
				"작업 디렉터리 밖의 파일 편집은 오너 승인이 필요합니다. / editing files outside the workspace needs owner approval",
		};
	}
	return allow(input);
}

/** Commands that always need a card when they run, judged by command name so `rg service`, `cat docker-compose.yml` pass. */
const DANGEROUS_COMMANDS: Record<string, true> = {
	sudo: true,
	doas: true,
	su: true,
	pkill: true,
	systemctl: true,
	service: true,
	docker: true,
	podman: true,
	pm2: true,
};
/** Commands that run their arguments as a command line: a dangerous name anywhere after them counts. */
const COMMAND_WRAPPERS: Record<string, true> = {
	bash: true,
	sh: true,
	zsh: true,
	dash: true,
	env: true,
	xargs: true,
	nohup: true,
	timeout: true,
	nice: true,
	exec: true,
	eval: true,
	ssh: true,
	watch: true,
	setsid: true,
	stdbuf: true,
	ionice: true,
	script: true,
	busybox: true,
};

export function isDangerousBash(command: string): boolean {
	if (highRiskCommandRule(command) !== undefined) return true;
	const blanked = blankGitGlobalOptions(command);
	// A git alias defined on the command line (`git -c alias.h=push h +main`) runs its value.
	const aliased = expandGitAliases(command);
	if (DANGEROUS_BASH.some((pattern) => pattern.test(command) || pattern.test(blanked) || pattern.test(aliased)))
		return true;
	const dangerous = (word: string): boolean => DANGEROUS_COMMANDS[basename(word)] === true;
	// A command substitution (`$( )`, backticks) is a segment of its own, inside double quotes too (`shellSegments`).
	return shellSegments(command).some(({ words }) => {
		const { name, args } = simpleCommand(words);
		if (name === undefined) return false;
		return (
			dangerous(name) ||
			(COMMAND_WRAPPERS[basename(name)] === true && args.some(dangerous)) ||
			commandsIn(name, args).some(findDeletes)
		);
	});
}

/**
 * A `find` that deletes what it matches: `-delete`, or `rm` run by `-exec` / `-execdir` / `-ok` / `-okdir`. Not
 * `findActs`, which also holds for actions that only read or write a listing (`-exec wc`, `-fprint`, `-fls`).
 */
function findDeletes({ name, args }: { name: string; args: string[] }): boolean {
	return (
		name === "find" &&
		args.some(
			(arg, index) =>
				arg === "-delete" || (/^-(?:exec|execdir|ok|okdir)$/.test(arg) && basename(args[index + 1] ?? "") === "rm"),
		)
	);
}

function allow(input: Record<string, unknown>): PermissionDecision {
	return { behavior: "allow", updatedInput: input };
}

function deny(message: string): PermissionDecision {
	return { behavior: "deny", message };
}
