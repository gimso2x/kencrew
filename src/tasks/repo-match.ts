import { dispatchEnv, type ProcessRunner, realProcessRunner } from "../dispatch/omp";

/**
 * Whether the repository at `path` is one of `repos` (`taskAutoLand.repos`): the same git common directory (`git
 * rev-parse --git-common-dir`), so any worktree of a listed repository matches and a look-alike path does not. A path
 * git cannot read is a mismatch. [TASK] auto-merge and work-lane landing share this one comparison.
 */
export async function repoMatchesCommonDir(
	path: string,
	repos: readonly string[],
	run: ProcessRunner = realProcessRunner,
): Promise<boolean> {
	const own = await gitCommonDir(path, run);
	if (own === undefined) return false;
	for (const repo of repos) if ((await gitCommonDir(repo, run)) === own) return true;
	return false;
}

/** The absolute git common directory of the work tree at `dir`; `undefined` when git cannot read it. */
export async function gitCommonDir(dir: string, run: ProcessRunner = realProcessRunner): Promise<string | undefined> {
	const result = await run(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		timeoutMs: 10_000,
		env: dispatchEnv(process.env),
	});
	const found = result.stdout.trim();
	return result.code === 0 && found !== "" ? found : undefined;
}
