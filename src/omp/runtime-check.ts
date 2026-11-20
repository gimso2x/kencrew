import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv } from "./env";

/**
 * Why `ompExecutable` cannot host an RPC child, checked before every spawn, by the `omp_runtime` gate, `ompbot doctor`
 * and `ompbot omp trial`. The child is the executable itself (the package's `dist/cli.js` or the standalone binary), so
 * the only requirement is that it runs and names itself `omp/<x.y.z>`.
 */
export interface OmpRuntimeProblem {
	code: "omp_executable_missing";
	/** Short `key=value` detail for gates and logs. */
	detail: string;
	/** Human-readable cause with the fix. */
	message: string;
}

const VERSION_TIMEOUT_MS = 15_000;
const VERSION_LINE = /^omp\/(\d+\.\d+\.\d+\S*)/;

/**
 * Versions already read, by executable identity (realpath, mtime, size): `cli.js --version` takes about a second and
 * runs before every child, so an unchanged executable is asked once per process.
 */
const knownVersions = new Map<string, string>();

function identity(executable: string): string | OmpRuntimeProblem {
	try {
		const real = realpathSync(executable);
		const stat = statSync(real);
		return `${real}\0${stat.mtimeMs}\0${stat.size}`;
	} catch (error) {
		const reason = error instanceof Error && "code" in error ? String(error.code) : String(error);
		return problem(executable, `error=${reason}`, `${executable} cannot be read (${reason})`);
	}
}

function problem(executable: string, detail: string, cause: string): OmpRuntimeProblem {
	return {
		code: "omp_executable_missing",
		detail: `${detail} path=${executable}`,
		message: `${cause}; point ompExecutable at an omp executable (\`command -v omp\`, or the standalone binary / dist/cli.js of the package).`,
	};
}

/** The verdict on one `--version` run; a version is remembered under `key`. */
function verdict(
	executable: string,
	key: string,
	run: { exitCode: number | null; stdout: string; stderr: string },
): OmpRuntimeProblem | undefined {
	const version = VERSION_LINE.exec(run.stdout.trim())?.[1];
	if (run.exitCode === 0 && version !== undefined) {
		knownVersions.set(key, version);
		return undefined;
	}
	const shown = (run.stdout.trim() || run.stderr.trim()).split("\n")[0]?.slice(0, 200) ?? "";
	return problem(
		executable,
		`version=unrecognized exit=${run.exitCode ?? "killed"}`,
		`\`${executable} --version\` did not print omp/<version> (exit ${run.exitCode ?? "killed"}: ${shown || "no output"})`,
	);
}

function spawnFailure(executable: string, error: unknown): OmpRuntimeProblem {
	const reason = error instanceof Error && "code" in error ? String(error.code) : String(error);
	return problem(executable, `error=${reason}`, `${executable} cannot be run (${reason})`);
}

/**
 * Runs `<executable> --version` with `env` (the child's PATH decides which bun runs `cli.js`); by default the
 * environment an omp child gets, without the bot's `SLACK_`/`OMPBOT_` secrets.
 */
export async function checkOmpRuntime(
	executable: string,
	env: Record<string, string | undefined> = buildChildEnv(),
	timeoutMs = VERSION_TIMEOUT_MS,
): Promise<OmpRuntimeProblem | undefined> {
	const key = identity(executable);
	if (typeof key !== "string") return key;
	if (knownVersions.has(key)) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// Own process group: on timeout the whole group is killed, because a launcher's grandchild holding stdout open
		// would keep the read waiting past the limit.
		const child = Bun.spawn([executable, "--version"], {
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const finished = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		const result = await Promise.race([finished, timedOut]);
		if (result === "timeout") {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// ESRCH: the group is already gone
			}
			await child.exited;
			return problem(
				executable,
				"error=timeout",
				`\`${executable} --version\` did not finish within ${timeoutMs / 1000}s`,
			);
		}
		const [stdout, stderr, exitCode] = result;
		return verdict(executable, key, { exitCode, stdout, stderr });
	} catch (error) {
		return spawnFailure(executable, error);
	} finally {
		// Never fire after a normal exit: the pgid may be reused by then.
		clearTimeout(timer);
	}
}

/** `checkOmpRuntime` for synchronous callers (the gate list); shares its remembered versions. */
export function checkOmpRuntimeSync(
	executable: string,
	env: Record<string, string | undefined> = buildChildEnv(),
	timeoutMs = VERSION_TIMEOUT_MS,
): OmpRuntimeProblem | undefined {
	const key = identity(executable);
	if (typeof key !== "string") return key;
	if (knownVersions.has(key)) return undefined;
	// Output goes to a file, not a pipe: a grandchild holding a pipe open would keep the call waiting past the limit.
	const dir = mkdtempSync(join(tmpdir(), "ompbot-omp-version-"));
	const outPath = join(dir, "out");
	const errPath = join(dir, "err");
	const outFd = openSync(outPath, "w");
	const errFd = openSync(errPath, "w");
	try {
		// Own process group and SIGKILL (a launcher may ignore SIGTERM): the whole group dies with the timeout.
		const run = Bun.spawnSync([executable, "--version"], {
			env,
			stdin: "ignore",
			stdout: outFd,
			stderr: errFd,
			detached: true,
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		if (run.exitedDueToTimeout) {
			try {
				process.kill(-run.pid, "SIGKILL");
			} catch {
				// ESRCH: the group is already gone
			}
			return problem(
				executable,
				"error=timeout",
				`\`${executable} --version\` did not finish within ${timeoutMs / 1000}s`,
			);
		}
		return verdict(executable, key, {
			exitCode: run.exitCode,
			stdout: readFileSync(outPath, "utf8"),
			stderr: readFileSync(errPath, "utf8"),
		});
	} catch (error) {
		return spawnFailure(executable, error);
	} finally {
		closeSync(outFd);
		closeSync(errFd);
		rmSync(dir, { recursive: true, force: true });
	}
}
