import type { DoctorNetwork } from "../../src/daemon/doctor";

const noNetwork: typeof fetch = Object.assign(
	async (input: string | URL | Request): Promise<Response> => {
		throw new Error(`test fetch: no network (${String(input)})`);
	},
	{ preconnect: fetch.preconnect },
);

/** `runDoctor` network for tests: any Discord request fails, so a doctor test never waits on an outbound connection. */
export const OFFLINE_DOCTOR: DoctorNetwork = { fetchImpl: noNetwork };
