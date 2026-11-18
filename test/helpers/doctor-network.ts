import type { DoctorNetwork } from "../../src/daemon/doctor";

/** The rejection `@slack/web-api` throws for a refused token: `data.error` carries Slack's code. */
function slackPlatformError(code: string): Error {
	return Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
}

const noNetwork: typeof fetch = Object.assign(
	async (input: string | URL | Request): Promise<Response> => {
		throw new Error(`test fetch: no network (${String(input)})`);
	},
	{ preconnect: fetch.preconnect },
);

/**
 * `runDoctor` network for tests: Slack answers `invalid_auth` (what the real API says to `xoxb-TEST-0`) and any
 * Discord request fails, so a doctor test never waits on a blocked or held outbound connection.
 */
export const OFFLINE_DOCTOR: DoctorNetwork = {
	slackAuthTest: async () => {
		throw slackPlatformError("invalid_auth");
	},
	fetchImpl: noNetwork,
};

/** Like `OFFLINE_DOCTOR`, but Slack accepts the token as bot `userId` of team `T0TEST0`. */
export function slackAuthOk(userId: string): DoctorNetwork {
	return { ...OFFLINE_DOCTOR, slackAuthTest: async () => ({ ok: true, user_id: userId, team_id: "T0TEST0" }) };
}
