import { redact } from "../redact";
import type { Section } from "./snapshot";

const ERROR_CHARS = 200;

/** An outside error text as a card shows it: redacted, one line, cut. */
export function cleanError(text: string): string {
	return redact(text).replace(/\s+/g, " ").trim().slice(0, ERROR_CHARS);
}

/**
 * Cached card sections for the cards that run a command (`host-checks.ts`, `usage-limits.ts`). Cached per key at
 * module level (a `snapshotReader` is made anew for every `!brief`): a run younger than `ttlMs`, finished or still
 * running, is shared. `read` never rejects: a build that throws is a failed section.
 */
export function sectionCache<T>(ttlMs: number): {
	read(key: string, now: () => number, build: () => Promise<Section<T>>): Promise<Section<T>>;
	clear(): void;
} {
	const cache = new Map<string, { at: number; result: Promise<Section<T>> }>();
	return {
		read(key, now, build) {
			const started = now();
			const hit = cache.get(key);
			if (hit !== undefined && started - hit.at >= 0 && started - hit.at < ttlMs) return hit.result;
			const result = build().catch(
				(error: unknown): Section<T> => ({
					ok: false,
					error: cleanError(error instanceof Error ? error.message : String(error)),
				}),
			);
			cache.set(key, { at: started, result });
			return result;
		},
		clear: () => cache.clear(),
	};
}
