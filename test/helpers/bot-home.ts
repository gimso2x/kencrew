import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelBinding } from "../../src/channel/adapter";
import type { OmpbotConfig } from "../../src/config";
import { DiscordBinding } from "../../src/discord/binding";
import { DiscordChannel } from "../../src/discord/channel";
import type {
	CreateMessageArgs,
	DiscordHandlers,
	DiscordMessageEvent,
	EditMessageArgs,
} from "../../src/discord/transport";
import { type FakeDiscordCall, FakeDiscordTransport } from "./discord-fake-transport";

/** The Discord owner of a test home (a fake snowflake). */
export const OWNER = "100000000000000001";
/** The bot user of `FakeDiscordTransport` (its default `botUserId`). */
export const BOT = "500000000000000000";
/** The owner's DM channel with the bot in the tests (a fake snowflake; DMs carry no `guild_id`). */
export const OWNER_DM = "200000000000000001";
/** A server text channel the bot is in, and its server. */
export const CHANNEL = "300000000000000001";
export const GUILD = "400000000000000001";

export interface TestHome {
	dir: string;
	/** Same shape `loadConfig` returns for this home: `channels.discord` with owner `OWNER` and a 0600 fake token. */
	config: OmpbotConfig;
	remove(): void;
}

/**
 * A 0700 bot home with a config.json (`channels.discord`, owner `OWNER`), a 0600 fake bot token file and a stub
 * `omp` that only answers `--version`. Nothing here can talk to Discord or start a real omp.
 */
export function makeHome(
	prefix = "ompbot-home-",
	real: { ompExecutable: string; model: string } | undefined = undefined,
): TestHome {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	chmodSync(dir, 0o700);
	const secrets = join(dir, "secrets");
	mkdirSync(secrets, { mode: 0o700 });
	const botTokenFile = join(secrets, "discord-bot-token");
	writeFileSync(botTokenFile, `${["TEST", "discord", "0"].join("-")}\n`, { mode: 0o600 });
	const ompExecutable = real?.ompExecutable ?? join(dir, "fake-omp");
	if (!real) writeFileSync(ompExecutable, '#!/bin/sh\necho "omp-stub 0.0.0"\n', { mode: 0o755 });
	const workspaceDir = join(dir, "workspace");
	mkdirSync(workspaceDir, { mode: 0o700 });
	const configPath = join(dir, "config.json");
	const discord = { ownerUserId: OWNER, applicationId: "600000000000000000" };
	writeFileSync(
		configPath,
		JSON.stringify({
			schemaVersion: 1,
			channels: { discord: { ...discord, botTokenFile: "secrets/discord-bot-token" } },
			ompExecutable,
			workspaceDir: "workspace",
			timezone: "Asia/Seoul",
			...(real ? { model: real.model } : {}),
		}),
		{ mode: 0o600 },
	);
	return {
		dir,
		config: {
			schemaVersion: 1,
			homeDir: dir,
			configPath,
			// Key order as `loadConfig` builds it: reload compares configs by their JSON text.
			channels: { discord: { ownerUserId: OWNER, botTokenFile, applicationId: discord.applicationId } },
			ompExecutable,
			workspaceDir,
			timezone: "Asia/Seoul",
		},
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** Whether a Discord message still carries buttons: an approval card keeps its embed after the decision. */
export function hasButtons(components: readonly unknown[] | undefined): boolean {
	return (components?.length ?? 0) > 0;
}

/** The Discord binding the daemon gets for `transport`, owner `OWNER` (the shape `runDaemon` builds). */
export function discordBinding(
	transport: FakeDiscordTransport,
	options: { peerBots?: ReadonlyArray<{ userId: string; name: string }>; startWaitMs?: number } = {},
): ChannelBinding {
	const { startWaitMs, peerBots } = options;
	return new DiscordBinding(
		new DiscordChannel(transport, { ownerUserId: OWNER, ...(peerBots === undefined ? {} : { peerBots }) }),
		startWaitMs === undefined ? {} : { startWaitMs },
	);
}

/** An owner message in the DM `OWNER_DM` (or another channel through `overrides`). */
export function ownerMessage(
	id: string,
	content: string,
	overrides: Partial<DiscordMessageEvent> = {},
): DiscordMessageEvent {
	return {
		id,
		channel_id: OWNER_DM,
		author: { id: OWNER, username: "owner" },
		content,
		type: 0,
		...overrides,
	};
}

/** FakeDiscordTransport whose `waitForPosts` resolves on the createMessage that satisfies it (bounded, no polling). */
export class WaitingDiscordTransport extends FakeDiscordTransport {
	readonly #waiters = new Set<() => void>();

	override async createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		const result = await super.createMessage(args);
		for (const waiter of [...this.#waiters]) waiter();
		return result;
	}

	override async editMessage(args: EditMessageArgs): Promise<void> {
		await super.editMessage(args);
		for (const waiter of [...this.#waiters]) waiter();
	}

	/** Resolves with the first createMessage/editMessage call that satisfies `match` (bounded, no polling). */
	waitForCall(match: (call: FakeDiscordCall) => boolean, timeoutMs = 10_000): Promise<FakeDiscordCall> {
		const { promise, resolve, reject } = Promise.withResolvers<FakeDiscordCall>();
		const check = () => {
			const found = this.calls.find(match);
			if (found === undefined) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve(found);
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`timed out waiting for a matching Discord call; saw ${this.calls.length} calls`));
		}, timeoutMs);
		this.#waiters.add(check);
		check();
		return promise;
	}

	posts(match?: (text: string) => boolean): Extract<FakeDiscordCall, { method: "createMessage" }>[] {
		return this.calls.filter(
			(call): call is Extract<FakeDiscordCall, { method: "createMessage" }> =>
				call.method === "createMessage" && (match === undefined || match(call.content ?? "")),
		);
	}

	waitForPosts(match: (text: string) => boolean, count = 1, timeoutMs = 10_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (this.posts(match).length < count) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`timed out waiting for ${count} matching Discord post(s); saw ${this.posts().length} posts`));
		}, timeoutMs);
		this.#waiters.add(check);
		check();
		return promise;
	}
}

/** A transport whose first Ready never comes until `release()`: a gateway stuck on 5xx or a Hello that does not arrive. */
export class PendingDiscordTransport extends WaitingDiscordTransport {
	readonly #gate = Promise.withResolvers<void>();

	override async start(handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
		await this.#gate.promise;
		return super.start(handlers);
	}

	/** The first Ready arrives. */
	release(): void {
		this.#gate.resolve();
	}
}
