import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * The folder omp keeps the sessions of a cwd in, under `sessionsRoot`: omp's default-session-dir naming (omp
 * `session-paths.ts`, read 2026-11-13): a cwd inside the temp root is `-tmp-<rest>`, one inside the user's home
 * `-<rest>` (path separators and `:` as `-`), any other `--<path>--`. The cwd and both roots are compared by real path.
 */
export function ompSessionDirFor(cwd: string, userHome: string, sessionsRoot: string, tempRoot = tmpdir()): string {
	const real = (path: string): string => {
		try {
			return realpathSync(resolve(path));
		} catch {
			return resolve(path);
		}
	};
	const canonical = real(cwd);
	const within = (root: string): string | undefined => {
		const rel = relative(real(root), canonical);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : undefined;
	};
	const encode = (prefix: string, rel: string): string => {
		const encoded = rel.replace(/[/\\:]/g, "-");
		return encoded === "" ? prefix : prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
	};
	const inTemp = within(tempRoot);
	const inHome = within(userHome);
	const name =
		inTemp !== undefined
			? encode("-tmp", inTemp)
			: inHome !== undefined
				? encode("-", inHome)
				: `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(sessionsRoot, name);
}
