// The rule-guards extension (outside this repository) applies the same rule to a `bun test` command line, so
// test/heavy-run-check.test.ts and the extension's test carry the same table.

/** `bun test` options that take their value as the next argument (`--opt=value` carries its own). */
const BUN_TEST_VALUE_OPTIONS = new Set([
	"--timeout",
	"-t",
	"--test-name-pattern",
	"--parallel",
	"--max-concurrency",
	"--rerun-each",
	"--retry",
	"--reporter",
	"--reporter-outfile",
	"--coverage-reporter",
	"--coverage-dir",
	"--preload",
	"-r",
	"--seed",
	"--shard",
	"--path-ignore-patterns",
]);

/**
 * Whether `argv` is a whole-suite run: `bun run test`, or `bun test` with no file argument (options and their values
 * do not count; a directory argument such as `test/` still selects everything).
 */
export function isFullTestArgv(argv: readonly string[]): boolean {
	if (argv[0] !== "bun") return false;
	if (argv[1] === "run") return argv[2] === "test";
	if (argv[1] !== "test") return false;
	const rest = argv.slice(2);
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] as string;
		if (arg.startsWith("-")) {
			if (BUN_TEST_VALUE_OPTIONS.has(arg)) i++;
			continue;
		}
		if (!/^\.{0,2}\/?$|\/$/.test(arg)) return false;
	}
	return true;
}
