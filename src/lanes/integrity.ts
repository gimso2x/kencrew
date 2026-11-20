import { defaultGit, type GitRunner } from "./verify";

/** One reason a lane's "done" claim is not accepted as evidence of finished work. */
export interface IntegrityRefusal {
	category:
		| "unfinished_work_marker"
		| "skipped_test"
		| "stub_implementation"
		| "guard_deletion_without_adversarial_regression"
		| "unproven_claim_word"
		| "undeclared_feature_removal"
		| "commit_identity_mismatch"
		| "lane_diff_unavailable";
	excerpt: string;
	remedy: string;
}

export interface IntegrityInput {
	/** The lane's own done report (the claim summary). */
	summary: string;
	/** Unified diff of the lane's commits (`--unified=0`), or "" when it could not be collected. */
	diff: string;
}

/** Files whose added lines are judged: code only. Markdown/docs are not code and stay exempt; code under docs/ or examples/ is judged. */
const CODE_EXT =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|bash|zsh|ps1|go|rs|rb|java|kt|kts|scala|groovy|php|c|h|cc|cpp|cxx|hpp|cs|swift|m|mm|dart|lua|pl|ex|exs|zig|vue|svelte|sql|json|toml|yaml|yml|css|scss|html)$/i;
/** JavaScript-family files: `#name` is a private member there (code) and backtick strings may span lines. */
const JS_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/i;
const TEST_PATH =
	/(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:go|py|rs)$/i;
const LINKED_REASON = /(?:#\d+|https?:\/\/)/;
const UNFINISHED = /\b(?:TODO|FIXME|XXX|HACK|WIP|TBD)\b/i;
const SKIPPED_TEST =
	/(?:\b(?:test|it|describe)(?:\.(?:concurrent|serial|failing|sequential))*\.(?:skip|only|todo|skipIf)(?:\(|\.)|\b(?:xit|xtest|xdescribe)\(|\b(?:test|it|describe)\b[^\n]*\{[^}]*\bskip\s*:\s*true\b|\bpytest\.(?:mark\.skip(?:if)?\b|skip\s*\()|@unittest\.skip|\bt\.Skip(?:Now|f)?\(|#\[ignore\b)/;
/** A stub is a throwing/panicking body, judged on the raw line (its message is a string), or a stub macro/call outside string literals. */
const STUB_THROW = /\b(?:throw|raise|panic)\b.*not[ _-]?implemented/i;
const STUB_CALL = /(?:\btodo\s*![([{]|unimplemented[!]|\bnot_?implemented\s*\()/i;
const GUARD_WORD =
	/\b(?:throw|refuse|deny|reject|validate|sanitize|permission|allowlist|forbid|guard|assert)\b|권한|거부|검증|금지/i;
/** A line that declares or asserts in a test, so a negative word there names a case rather than a variable or comment. */
const TEST_DECLARATION =
	/\b(?:test|it|describe|specify)\s*(?:\.\w+)*\s*\(|\bexpect\s*\(|\bassert\w*|\bdef\s+test_|\bfn\s+\w+|\bfunc\s+Test|\bpytest\.raises|@Test\b/;
const NEGATIVE_TEST = /\b(?:refuses?|rejects?|denies?|blocks?|invalid|권한 없음|거부)/i;
const CLAIM_WORD =
	/(?:통과|검증 완료|수정 완료|고쳤|해결됐|해결됨|(?<![A-Za-z0-9_-])(?:verified|passing|passed|fixed|green)(?![A-Za-z0-9_-]))/i;
const COMMAND_TOKEN =
	/(?<![A-Za-z0-9_-])(?:bun\s+(?:run\s+)?(?:test|check|typecheck|x)|bunx|(?<![A-Za-z0-9_/.-])(?:tsc|biome)(?!\.\w)|(?:npm|yarn|pnpm)\s+(?:run\s+)?test|pytest|go\s+test|cargo\s+test|make\s+test|vitest|jest|git(?=\s))(?![A-Za-z0-9_-])/i;
/** A script file whose export declarations are public API; re-export lists and other languages are not judged. */
const EXPORT_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
const EXPORT_DECLARATION =
	/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\b\s*\*?|class\b|abstract\s+class\b|const\b|let\b|var\b|interface\b|type\b|enum\b)\s*([A-Za-z_$][\w$]*)/;
/** `false &&` / `&& false` / `if (false)` / `if (0)` on comment- and string-free code; a comparison with false is no switch-off. */
const FEATURE_OFF = /\bif\s*\(\s*(?:false|0)\s*\)|(?<![=!]=\s*|[=!]==\s*)\bfalse\b\s*&&|&&\s*false\b(?!\s*[=!]=)/;
/** How many refusals one verdict reports (a claim is judged again after its remedies are applied). */
export const MAX_REFUSALS = 8;

interface DiffLine {
	file: string;
	text: string;
	/** Hunk ordinal within the diff: a block comment opened in one hunk does not run into the next. */
	hunk: number;
	/** Removed lines only: the line's code with comments cut away, read in old-side order within the hunk. */
	code?: string;
	/** Removed lines only: the file's new path, so an edit in a renamed file pairs with its added line. */
	newFile?: string;
}

const OCTAL_ESCAPE_RUN = /(?:\\[0-3][0-7]{2})+/g;

/** Decodes git's C-style quoted path (`"b/src/\355\225\234.ts"`): octal byte runs are UTF-8, plus the usual escapes. */
function unquoteGitPath(raw: string): string {
	let path = raw.replace(/\t.*$/, "").replace(/\r$/, "");
	if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path;
	path = path.slice(1, -1).replace(OCTAL_ESCAPE_RUN, (run) => {
		const bytes = run
			.slice(1)
			.split("\\")
			.map((octal) => Number.parseInt(octal, 8));
		return new TextDecoder().decode(Uint8Array.from(bytes));
	});
	const simple: Record<string, string> = { t: "\t", n: "\n", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };
	return path.replace(/\\(["\\tnrabfv])/g, (_, ch: string) => simple[ch] ?? ch);
}

/**
 * Splits a unified diff into added/removed code lines, dropping non-code files. A `--- ` line is a file header only in a
 * file's header block (before its first `@@`, reset by the next `diff ` line) and only when a `+++ ` line follows it:
 * inside a hunk, `--- x`/`+++ x` are a removed `-- x` and an added `++ x` line. For a deleted file the `+++` side is
 * /dev/null, so the `---` path names the file.
 */
function parseDiff(diff: string): { added: DiffLine[]; removed: DiffLine[] } {
	const added: DiffLine[] = [];
	const removed: DiffLine[] = [];
	const lines = diff.split("\n");
	// Removed lines belong to the old path, added ones to the new: a rename to a non-code name keeps its removals judged.
	let oldFile = "";
	let newFile = "";
	let inHunk = false;
	let hunk = 0;
	// Block-comment state of the old side (context and removed lines); a hunk starts outside any comment.
	let oldInBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.startsWith("diff ")) {
			inHunk = false;
			continue;
		}
		if (!inHunk && line.startsWith("--- ") && (lines[i + 1] as string | undefined)?.startsWith("+++ ")) {
			// `a/`/`b/` prefixes are dropped after unquoting git's C-style quoting.
			const oldPath = unquoteGitPath(line.slice(4)).replace(/^[ab]\//, "");
			const newPath = unquoteGitPath((lines[i + 1] as string).slice(4)).replace(/^[ab]\//, "");
			oldFile = oldPath === "/dev/null" ? newPath : oldPath;
			newFile = newPath === "/dev/null" ? oldPath : newPath;
			i += 1;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			hunk += 1;
			oldInBlock = false;
			continue;
		}
		if (line.startsWith("+")) {
			if (CODE_EXT.test(newFile)) added.push({ file: newFile, text: line.slice(1), hunk });
		} else if (line.startsWith("-")) {
			if (CODE_EXT.test(oldFile)) {
				const text = line.slice(1);
				const scan = isUnfinishedMarker(text, oldInBlock, JS_EXT.test(oldFile));
				// A leading `*` outside a seen block comment may be a continued multiplication, so it stays code.
				const code = !oldInBlock && /^\s*\*/.test(text) ? text : scan.code;
				oldInBlock = scan.inBlock;
				removed.push({ file: oldFile, text, hunk, code, newFile });
			}
		} else if (line.startsWith(" ") && inHunk) {
			oldInBlock = isUnfinishedMarker(line.slice(1), oldInBlock, JS_EXT.test(oldFile)).inBlock;
		}
	}
	return { added, removed };
}

const isBlank = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * Text of the trailing comment on a code line, or undefined when the line has none. String literals are skipped, so a
 * "TODO" inside quotes is not a marker; `#`, `--`, `;;` need a whitespace/line-start before them and `%`/`*` only open a
 * comment at the start of the line (modulo and multiplication stay code). In a JavaScript-family file (`js`) a `#`
 * right before a name is a private member (`#validate(`), so it is code.
 */
function commentText(text: string, js: boolean): string | undefined {
	const noCloser = new Set<string>();
	let leading = true;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (ch === '"' || ch === "'" || ch === "`") {
			if (!noCloser.has(ch)) {
				let end = -1;
				for (let j = i + 1; j < text.length; j++) {
					if (text[j] === "\\") j += 1;
					else if (text[j] === ch) {
						end = j;
						break;
					}
				}
				if (end >= 0) {
					i = end;
					leading = false;
					continue;
				}
				noCloser.add(ch);
			}
		}
		const next = text[i + 1];
		if ((ch === "/" && (next === "/" || next === "*")) || text.startsWith("<!--", i)) return text.slice(i);
		const spaced = isBlank(text[i - 1]);
		if (ch === "#" && spaced && next !== "[" && next !== "!" && !(js && /[A-Za-z_$]/.test(next ?? "")))
			return text.slice(i);
		if (ch === "-" && next === "-" && spaced && isBlank(text[i + 2])) return text.slice(i);
		if (ch === ";" && next === ";" && spaced) return text.slice(i);
		if (leading && (ch === "%" || ch === "*")) return text.slice(i);
		if (!isBlank(ch)) leading = false;
	}
	return undefined;
}

/**
 * Whether the line carries an unfinished-work marker, and its code with comments cut away; `inBlock` carries an open
 * slash-star comment from the line before; `js` = a JavaScript-family file.
 */
function isUnfinishedMarker(
	text: string,
	inBlock: boolean,
	js: boolean,
): { marker: boolean; inBlock: boolean; code: string } {
	let rest = text;
	let marker = false;
	if (inBlock) {
		const close = text.indexOf("*/");
		if (close < 0) return { marker: UNFINISHED.test(text), inBlock: true, code: "" };
		marker = UNFINISHED.test(text.slice(0, close));
		rest = text.slice(close + 2);
	}
	// Closed slash-star comments in the middle of the line are cut too, so code after them is still seen.
	let code = "";
	for (;;) {
		const trailing = commentText(rest, js);
		if (trailing === undefined) return { marker, inBlock: false, code: code + rest };
		code += rest.slice(0, -trailing.length);
		const close = trailing.startsWith("/*") ? trailing.indexOf("*/", 2) : -1;
		if (close < 0) {
			marker ||= UNFINISHED.test(trailing);
			return { marker, inBlock: trailing.startsWith("/*"), code };
		}
		marker ||= UNFINISHED.test(trailing.slice(0, close));
		rest = trailing.slice(close + 2);
	}
}

/**
 * Whether a backtick string is still open after `text` (`open`: it was open before it). A line that starts inside one
 * is text, not code; quoted strings and comments on the line are skipped so their backticks open nothing.
 */
function templateOpenAfter(text: string, open: boolean): boolean {
	let inside = open;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") i += 1;
		else if (inside) inside = ch !== "`";
		else if (ch === "`") inside = true;
		else if (ch === '"' || ch === "'") {
			let end = i + 1;
			while (end < text.length && text[end] !== ch) end += text[end] === "\\" ? 2 : 1;
			i = end;
		} else if (ch === "/" && text[i + 1] === "/") return false;
		else if (ch === "/" && text[i + 1] === "*") {
			const close = text.indexOf("*/", i + 2);
			if (close < 0) return false;
			i = close + 1;
		}
	}
	return inside;
}

/** Blanks string literals so words inside quotes are not read as code. */
function withoutStrings(text: string): string {
	return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
}

/**
 * A guard line's code for telling an edit from a deletion: string literals without `${…}` and a trailing `//` comment
 * become blanks, everything else stays as written. A template literal that interpolates holds code and is kept, which
 * is why {@link withoutStrings} (it blanks those too) is not used here.
 */
function guardCode(text: string): string {
	return text
		.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (literal) =>
			literal.startsWith("`") && literal.includes("${") ? literal : '""',
		)
		.replace(/\s*\/\/.*$/, "")
		.trim();
}

function refusal(category: IntegrityRefusal["category"], file: string, text: string): IntegrityRefusal {
	const remedies: Record<IntegrityRefusal["category"], string> = {
		unfinished_work_marker: "남긴 TODO/FIXME를 실제로 끝내거나, 왜 남기는지 이슈 번호(#123)를 같은 줄에 적으세요.",
		skipped_test: "건너뛴/단독 실행 테스트를 원복하거나, 건너뛰는 이유를 이슈 번호로 같은 줄에 적으세요.",
		stub_implementation: "스텁 본문을 구현하거나, 이번 범위가 아니면 해당 코드를 되돌리세요.",
		guard_deletion_without_adversarial_regression:
			"삭제한 가드/부정 테스트를 복원하거나, 같은 동작을 증명하는 부정 케이스 테스트를 추가하세요.",
		undeclared_feature_removal:
			"지운 export/꺼 둔 기능을 되살리거나, 의도한 삭제면 완료 보고에 그 이름을 적으세요(꺼 둔 줄은 같은 줄에 이슈 번호).",
		unproven_claim_word: "보고의 '통과/검증됨' 주장에 실제 실행한 검증 명령(bun test 등)을 함께 적으세요.",
		commit_identity_mismatch:
			"작성자·커미터 이메일을 `taskAutoLand.commitEmails` 허용 목록에 맞추세요(`git commit --amend --reset-author`, 또는 rebase로 작성자 수정).",
		lane_diff_unavailable:
			"base 브랜치를 읽지 못해 레인의 변경을 가려낼 수 없습니다. base 브랜치가 저장소에 있는지 확인하고 다시 완료를 알리세요.",
	};
	return { category, excerpt: `${file}: ${text.trim().slice(0, 120)}`, remedy: remedies[category] };
}

/**
 * Pure judge of a lane's completion claim (hermes completion_integrity, word lists rewritten for this repo):
 * refuses added TODO/FIXME markers, skipped tests, stub bodies, guard deletions without an adversarial test, and
 * verification words with no command behind them. It runs no commands and proves nothing itself — git already
 * proved the commit; this only rejects claims whose own text/diff contradicts "done".
 */
export function classifyLaneCompletion(input: IntegrityInput): IntegrityRefusal[] {
	const refusals: IntegrityRefusal[] = [];
	const { added, removed } = parseDiff(input.diff);

	let blockKey = "";
	let inBlock = false;
	let inTemplate = false;
	/**
	 * Added lines inside a block comment or a multi-line backtick string: text, not code, so pasting a deleted guard
	 * there makes its deletion neither a move nor an edit (qa-x #72).
	 */
	const inText = new Set<DiffLine>();
	/** An added test line whose code (comments cut away) declares or asserts a negative case. */
	let hasAdversarialTest = false;
	/** The first added line that switches a feature off by a constant condition. */
	let featureOff: DiffLine | undefined;
	for (const line of added) {
		const key = `${line.file}\0${line.hunk}`;
		if (key !== blockKey) {
			blockKey = key;
			inBlock = false;
			inTemplate = false;
		}
		const js = JS_EXT.test(line.file);
		if (inBlock || inTemplate) inText.add(line);
		if (js) inTemplate = templateOpenAfter(line.text, inTemplate);
		const scan = isUnfinishedMarker(line.text, inBlock, js);
		inBlock = scan.inBlock;
		if (TEST_PATH.test(line.file) && NEGATIVE_TEST.test(scan.code) && TEST_DECLARATION.test(scan.code))
			hasAdversarialTest = true;
		// An issue link is a reason for a marker or a skip; a stub body has no such remedy.
		if (!LINKED_REASON.test(line.text)) {
			if (scan.marker) refusals.push(refusal("unfinished_work_marker", line.file, line.text));
			if (SKIPPED_TEST.test(line.text)) refusals.push(refusal("skipped_test", line.file, line.text));
		}
		if (STUB_THROW.test(line.text) || STUB_CALL.test(withoutStrings(line.text)))
			refusals.push(refusal("stub_implementation", line.file, line.text));
		if (
			featureOff === undefined &&
			!TEST_PATH.test(line.file) &&
			!LINKED_REASON.test(line.text) &&
			FEATURE_OFF.test(withoutStrings(scan.code))
		)
			featureOff = line;
	}

	const addedCode = new Set(added.filter((line) => !inText.has(line)).map((line) => line.text.trim()));
	const deletedGuards = removed.filter((line) => {
		const code = line.code ?? line.text;
		return GUARD_WORD.test(code) || NEGATIVE_TEST.test(code);
	});
	// A guard moved as it was (re-added as code anywhere) or edited in place (same file and hunk; a renamed file's new
	// path) only in a plain string or a trailing comment is kept, not deleted: each added line answers for one deleted
	// guard at most (qa-l #83, qa-x #73).
	const paired = new Set<DiffLine>();
	const stillGone = deletedGuards.filter((line) => {
		if (addedCode.has(line.text.trim())) return false;
		const code = guardCode(line.text);
		const edit = added.find(
			(other) =>
				!paired.has(other) &&
				!inText.has(other) &&
				other.file === (line.newFile ?? line.file) &&
				other.hunk === line.hunk &&
				guardCode(other.text) === code,
		);
		if (edit === undefined) return true;
		paired.add(edit);
		return false;
	});
	if (stillGone.length > 0 && !hasAdversarialTest) {
		refusals.push(
			refusal("guard_deletion_without_adversarial_regression", stillGone[0]?.file ?? "", stillGone[0]?.text ?? ""),
		);
	}

	const summary = input.summary.trim();
	const removedExport = removed.find((line) => {
		if (!EXPORT_EXT.test(line.file) || TEST_PATH.test(line.file)) return false;
		const name = EXPORT_DECLARATION.exec(line.text)?.[1];
		if (name === undefined) return false;
		const named = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
		return !added.some((other) => EXPORT_DECLARATION.exec(other.text)?.[1] === name) && !named.test(summary);
	});
	const switchedOff = removedExport ?? featureOff;
	if (switchedOff !== undefined)
		refusals.push(refusal("undeclared_feature_removal", switchedOff.file, switchedOff.text));

	if (summary !== "" && CLAIM_WORD.test(summary) && !COMMAND_TOKEN.test(summary)) {
		refusals.push(refusal("unproven_claim_word", "summary", summary));
	}

	return refusals.slice(0, MAX_REFUSALS);
}

/** Where a lane's diff starts: the commit it started (or was reopened) at, and the branch it lands on. */
export interface LaneDiffRange {
	baseSha?: string;
	baseBranch?: string;
}

/** The base branch or its tip could not be read: the lane's own changes cannot be told apart, so the check fails closed. */
export class LaneDiffUnavailable extends Error {}

/** The refusal an unreadable base becomes (the owner can still approve the claim from its card). */
export function laneDiffUnavailableRefusal(error: LaneDiffUnavailable): IntegrityRefusal {
	return refusal("lane_diff_unavailable", "base", error.message);
}

/** One commit of the lane's own range: its full id and the two identities git records for it. */
export interface LaneCommitIdentity {
	sha: string;
	author: string;
	committer: string;
}

/** The committer GitHub records on a commit made in its web UI: allowed whatever the list says. */
const GITHUB_COMMITTER = "noreply@github.com";

/**
 * The lane's repository work tree root and where its own commits start (`<from>` of `from..sha`): the merge-base of
 * the base branch's current tip and `sha` — a lane rebased onto a moved base does not answer for the base's commits —
 * unless `baseSha` (a reopened lane's previous claim) is newer and still in `sha`'s history. `undefined` when the
 * repository cannot be read; a base branch whose tip cannot be read throws `LaneDiffUnavailable`.
 */
async function laneRange(
	laneCwd: string,
	range: LaneDiffRange,
	sha: string,
	git: GitRunner,
): Promise<{ root: string; from: string | undefined } | undefined> {
	const top = await git(["-C", laneCwd, "rev-parse", "--show-toplevel"]);
	const root = top.stdout.trim();
	if (top.code !== 0 || root === "") return undefined;
	let from = range.baseSha;
	if (range.baseBranch !== undefined) {
		const { baseBranch } = range;
		const tip = await git(["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}^{commit}`]);
		const tipSha = tip.stdout.trim();
		if (tip.code !== 0 || tipSha === "")
			throw new LaneDiffUnavailable(`base 브랜치 ${baseBranch}의 tip을 읽지 못했습니다`);
		const base = await git(["-C", root, "merge-base", tipSha, sha]);
		const mergeBase = base.stdout.trim();
		// No common history with the claim commit: the range cannot be read, like any other unreadable range.
		if (base.code !== 0 || mergeBase === "") return { root, from: undefined };
		from = mergeBase;
		const { baseSha } = range;
		if (baseSha !== undefined && baseSha !== mergeBase) {
			const newer = await git(["-C", root, "merge-base", "--is-ancestor", mergeBase, baseSha]);
			const inHistory = await git(["-C", root, "merge-base", "--is-ancestor", baseSha, sha]);
			if (newer.code === 0 && inHistory.code === 0) from = baseSha;
		}
	}
	return { root, from };
}

/**
 * `git diff <from>..sha` of the lane's repository (see `laneRange` for `from`). A base branch that cannot be read
 * throws `LaneDiffUnavailable`; without one, `from` is `baseSha`. "" when the repository, a merge-base with `sha` or
 * the diff cannot be read (the classifier then only sees the claim).
 */
export async function collectLaneDiff(
	laneCwd: string,
	range: LaneDiffRange,
	sha: string,
	git: GitRunner = defaultGit,
): Promise<string> {
	const resolved = await laneRange(laneCwd, range, sha, git);
	if (resolved === undefined || resolved.from === undefined) return "";
	const diff = await git([
		"-C",
		resolved.root,
		"-c",
		"core.quotepath=false",
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--text",
		`${resolved.from}..${sha}`,
		"--no-color",
		"--unified=0",
	]);
	return diff.code === 0 ? diff.stdout : "";
}

/**
 * The author and committer emails of the lane's own commits (`git log <from>..sha`, the same range as its diff), for
 * `taskAutoLand.commitEmails`. A repository or range that cannot be read yields no commits; a `git log` that fails
 * throws `LaneDiffUnavailable` (the caller treats it like any other unreadable range).
 */
export async function collectLaneCommitIdentities(
	laneCwd: string,
	range: LaneDiffRange,
	sha: string,
	git: GitRunner = defaultGit,
): Promise<LaneCommitIdentity[]> {
	const resolved = await laneRange(laneCwd, range, sha, git);
	if (resolved === undefined || resolved.from === undefined) return [];
	const log = await git([
		"-C",
		resolved.root,
		"log",
		"--no-color",
		"--format=%H%x09%ae%x09%ce",
		`${resolved.from}..${sha}`,
	]);
	if (log.code !== 0) throw new LaneDiffUnavailable("레인 커밋의 작성자·커미터를 읽지 못했습니다");
	const identities: LaneCommitIdentity[] = [];
	for (const line of log.stdout.split("\n")) {
		const [commit, author, committer] = line.split("\t");
		if (commit === undefined || author === undefined || committer === undefined) continue;
		identities.push({ sha: commit.trim(), author: author.trim(), committer: committer.trim() });
	}
	return identities;
}

/**
 * One refusal per commit whose author or committer email is not in `allowed` (case-insensitive), naming the offending
 * identities. `noreply@github.com` is allowed as the committer only (GitHub's own web commits).
 */
export function commitIdentityRefusals(
	identities: readonly LaneCommitIdentity[],
	allowed: readonly string[],
): IntegrityRefusal[] {
	const allow = new Set(allowed.map((email) => email.trim().toLowerCase()));
	const refusals: IntegrityRefusal[] = [];
	for (const identity of identities) {
		const wrong: string[] = [];
		if (!allow.has(identity.author.toLowerCase())) wrong.push(`작성자 <${identity.author}>`);
		const committer = identity.committer.toLowerCase();
		if (!allow.has(committer) && committer !== GITHUB_COMMITTER) wrong.push(`커미터 <${identity.committer}>`);
		if (wrong.length === 0) continue;
		refusals.push(refusal("commit_identity_mismatch", identity.sha.slice(0, 7), wrong.join(", ")));
	}
	return refusals;
}
