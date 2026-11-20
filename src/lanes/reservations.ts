import type { ActionButton } from "../channel/port";
import { mentionToken } from "../channel/port";
import type { LaneRow } from "./status";

/**
 * Lane start reservations (doc/plans/lane-after-queue.md): `ompbot_work_start` with `after` stores the start arguments
 * instead of starting a lane. The lane tick reads the prerequisite lanes' registry rows again; once all have landed the
 * owner gets a "시작 가능" card and starts the lane (or cancels) with a button. Nothing starts by itself.
 */

/** A reservation that has not started by then is `expired`. */
export const RESERVATION_TTL_MS = 24 * 60 * 60_000;
/** Prerequisite lanes one reservation may wait for. */
export const RESERVATION_AFTER_MAX = 3;

export type ReservationState = "waiting" | "ready" | "started" | "cancelled" | "expired";

export interface LaneReservation {
	id: number;
	originKey: string;
	/** The conversation the reservation was made in: where its cards and notices go. */
	threadRef: string;
	repo: string;
	after: string[];
	/** The `ompbot_work_start` arguments frozen at reservation time (`manager.start` input without `parentOrigin`). */
	startArgs: Record<string, unknown>;
	state: ReservationState;
	/** Signature of the last blocker notice posted, so one blocker is announced once; null when none stands. */
	notice: string | null;
	/** The lane a `started` reservation opened. */
	laneName: string | null;
	createdAt: number;
	expiresAt: number;
}

/** Why a prerequisite lane does not let the reservation go ahead; the first three hold it until the owner acts. */
export type AfterBlocker = "discarded" | "blocked" | "merged-not-pushed" | "missing";

export type AfterVerdict =
	| { ready: true }
	/** `blockers` empty: the lanes are simply not landed yet. */
	| { ready: false; blockers: Array<{ lane: string; why: AfterBlocker }> };

/** Reads each prerequisite lane's current row (`status`, `meta.land.state`): all `landed` is ready. */
export function judgeAfter(after: readonly string[], getLane: (name: string) => LaneRow | undefined): AfterVerdict {
	const blockers: Array<{ lane: string; why: AfterBlocker }> = [];
	let landed = 0;
	for (const name of after) {
		const lane = getLane(name);
		if (lane === undefined) {
			blockers.push({ lane: name, why: "missing" });
			continue;
		}
		const state = lane.status === "closed" ? lane.meta.land?.state : undefined;
		if (state === "landed") landed += 1;
		else if (state === "discarded" || state === "blocked" || state === "merged-not-pushed") {
			blockers.push({ lane: name, why: state });
		}
	}
	return landed === after.length ? { ready: true } : { ready: false, blockers };
}

const BLOCKER_TEXT: Record<AfterBlocker, string> = {
	discarded: "폐기됨",
	blocked: "머지 막힘",
	"merged-not-pushed": "머지됨 · push 안 됨",
	missing: "레인 없음",
};

export const blockerSignature = (blockers: ReadonlyArray<{ lane: string; why: AfterBlocker }>): string =>
	blockers
		.map((blocker) => `${blocker.lane}:${blocker.why}`)
		.sort()
		.join(",");

const cancelButton = (reservation: LaneReservation): ActionButton => ({
	actionId: reservationActionId(reservation.id, "cancel"),
	label: "✖ 취소",
	value: String(reservation.id),
	style: "danger",
});

/** One notice per blocker: the reservation keeps waiting, and ✖ 취소 is the owner's way out besides landing the lane. */
export const blockerMessage = (
	reservation: LaneReservation,
	blockers: ReadonlyArray<{ lane: string; why: AfterBlocker }>,
): { text: string; buttons: ActionButton[] } => ({
	text: `⚠️ 예약 #${reservation.id} \`${titleOf(reservation)}\`은 선행이 착지하지 않아 계속 기다립니다: ${blockers
		.map((blocker) => `${blocker.lane}(${BLOCKER_TEXT[blocker.why]})`)
		.join(", ")}. 선행을 마저 착지시키거나 예약을 취소하세요.`,
	buttons: [cancelButton(reservation)],
});

export const expiredNotice = (reservation: LaneReservation): string =>
	`⌛ 예약 #${reservation.id} \`${titleOf(reservation)}\`이 24시간이 지나 만료됐습니다. 필요하면 다시 예약하세요.`;

function titleOf(reservation: LaneReservation): string {
	const title = reservation.startArgs.title;
	return typeof title === "string" ? title : "?";
}

const ACTION_PREFIX = "lane-resv:";

export type ReservationAction = { id: number; kind: "start" | "cancel" };

export const reservationActionId = (id: number, kind: ReservationAction["kind"]): string =>
	`${ACTION_PREFIX}${id}:${kind}`;

/** What a click on a reservation card does; `undefined` for any other action id. */
export function parseReservationActionId(actionId: string): ReservationAction | undefined {
	const match = /^lane-resv:(\d{1,9}):(start|cancel)$/.exec(actionId);
	return match === null ? undefined : { id: Number(match[1]), kind: match[2] as ReservationAction["kind"] };
}

/** The "시작 가능" card: the owner is mentioned, ▶ 시작 and ✖ 취소 are the only way on. */
export function buildReservationReadyMessage(
	reservation: LaneReservation,
	ownerUserId: string | undefined,
): { text: string; buttons: ActionButton[] } {
	const mention = ownerUserId === undefined ? "" : `${mentionToken(ownerUserId)} `;
	return {
		text: `${mention}▶ 시작 가능 — 예약 #${reservation.id} \`${titleOf(reservation)}\`\n선행 ${reservation.after.join(", ")} 착지 완료. 시작하면 예약한 브리프·scope 그대로 레인이 뜹니다.`,
		buttons: [
			{
				actionId: reservationActionId(reservation.id, "start"),
				label: "▶ 시작",
				value: String(reservation.id),
				style: "primary",
			},
			cancelButton(reservation),
		],
	};
}
