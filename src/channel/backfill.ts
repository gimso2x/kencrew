// What the platform backfills share: the scan budget's platform-neutral constants, the recovery notice, the
// dead-letter verdict and the single-flight pass runner. Each platform keeps only its own page size (`PAGE_LIMIT`).
import { errorText } from "./text";

/** How far back the very first pass reaches when a target has no watermark (upstream: 24h bounded bootstrap). */
export const BOOTSTRAP_LOOKBACK_MS = 24 * 60 * 60_000;
/** Pages one target reads per pass; the rest waits for the next pass (the watermark keeps the place). */
export const MAX_PAGES = 10;
/** Definitive per-message failures before the message is dead-lettered and skipped (upstream: 3). */
export const MAX_MESSAGE_ATTEMPTS = 3;

/** The notice a pass posts under the oldest message it recovered: the answers it brought back are being processed. */
export function recoveryNotice(recovered: number): string {
	return `⏬ 봇이 응답하지 못한 동안 도착한 메시지 ${recovered}건을 처리합니다`;
}

const TRANSIENT_STORE_ERROR = /SQLITE_(BUSY|LOCKED|FULL|IOERR)/;

/**
 * Whether an ingest failure counts toward the message's dead-letter budget. `platform`: the verdict on the platform's
 * own errors (`undefined` for any other); a busy/locked/full/io ledger is not the message's fault.
 */
export function countsTowardDeadLetter(err: unknown, platform: boolean | undefined): boolean {
	if (platform !== undefined) return platform;
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string" && TRANSIENT_STORE_ERROR.test(code)) return false;
	return !TRANSIENT_STORE_ERROR.test(errorText(err));
}

/** Single-flight passes: a trigger while a pass runs asks for one follow-up pass instead of a second one beside it. */
export abstract class SingleFlightBackfill {
	#running = false;
	#followUp = false;
	#lastRun: Promise<void> = Promise.resolve();

	protected abstract pass(): Promise<unknown>;
	/** A pass that threw; must not throw itself. */
	protected abstract failed(err: unknown): void;

	trigger(): void {
		if (this.#running) {
			this.#followUp = true;
			return;
		}
		this.#running = true;
		this.#lastRun = this.#drain();
	}

	/** Resolves when no pass runs and none is pending (tests and graceful shutdown). */
	waitForIdle(): Promise<void> {
		return this.#lastRun;
	}

	async #drain(): Promise<void> {
		try {
			do {
				this.#followUp = false;
				await this.pass();
			} while (this.#followUp);
		} catch (err) {
			this.failed(err);
		} finally {
			this.#running = false;
		}
	}
}
