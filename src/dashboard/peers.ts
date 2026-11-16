import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type OmpbotConfig } from "../config";

/** Another install on this host whose monitors the dashboard reads (config `dashboard.peerHomes`), read-only. */
export interface PeerInstall {
	name: string;
	home: string;
	/** The peer's own `workspaceDir` (procedure file root); `<home>/workspace` when its config could not be read. */
	workspaceDir: string;
	/** The peer's zone; the dashboard's when its config could not be read. */
	timezone: string;
	/** Why the peer's config.json was not used, one masked-by-caller line; absent when it was read. */
	configError?: string;
}

/**
 * Each peer's workspace and zone from `<home>/config.json` (no token files read). A peer without a readable config
 * still gets its monitors listed, with `<home>/workspace` and the dashboard's zone, and the reason in `configError`.
 */
export function resolvePeers(dashboard: OmpbotConfig["dashboard"], timezone: string): PeerInstall[] {
	return (dashboard?.peerHomes ?? []).map(({ name, home }) => {
		const fallback = { name, home, workspaceDir: join(home, "workspace"), timezone };
		if (!existsSync(join(home, "config.json"))) return { ...fallback, configError: "config.json이 없음" };
		try {
			const config = loadConfig(home, { checkTokens: false });
			return { name, home, workspaceDir: config.workspaceDir, timezone: config.timezone };
		} catch (error) {
			return {
				...fallback,
				configError: `config.json을 읽지 못함: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	});
}
