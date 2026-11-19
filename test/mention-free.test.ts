import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordAdapter } from "../src/discord/adapter";
import { DiscordChannel } from "../src/discord/channel";
import type { DiscordMessageEvent } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { BOT, CHANNEL, GUILD, OWNER } from "./helpers/bot-home";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const OTHER_CHANNEL = "300000000000000002";
const INTRUDER = "100000000000000009";

/** Media roots made by `makeAdapter`; removed after each test so a failing assertion leaks none. */
const mediaRoots: string[] = [];

afterEach(() => {
	for (const dir of mediaRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeAdapter(channel: string): {
	transport: FakeDiscordTransport;
	recorded: string[];
	origins: string[];
	mediaRoot: string;
} {
	const transport = new FakeDiscordTransport({ botUserId: BOT });
	transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
	transport.setChannel({ id: OTHER_CHANNEL, type: 0, guildId: GUILD });
	const recorded: string[] = [];
	const origins: string[] = [];
	const knownThreads = new Set<string>();
	const mediaRoot = mkdtempSync(join(tmpdir(), "ompbot-mention-free-"));
	mediaRoots.push(mediaRoot);
	const adapter = new DiscordAdapter({
		channel: new DiscordChannel(transport, { ownerUserId: OWNER }),
		core: {
			onInbound: (message) => {
				recorded.push(message.text);
				origins.push(message.originKey);
				return { duplicate: false };
			},
			onCommand: () => "",
			onAction: () => undefined,
			knowsThread: (threadRef) => knownThreads.has(threadRef),
		},
		deliveries: { claimDue: () => [], confirm: () => undefined, fail: () => undefined, defer: () => undefined },
		ownerUserId: OWNER,
		clock: { now: () => 1_800_000_000_000 },
		log: createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact }),
		mediaRoot,
		mentionFreeChannels: [channel],
	});
	void adapter.start();
	return { transport, recorded, origins, mediaRoot };
}

let seq = 0n;

function channelMessage(content: string, overrides: Partial<DiscordMessageEvent> = {}): DiscordMessageEvent {
	seq += 1n;
	return {
		id: String(700_000_000_000_000_000n + seq),
		channel_id: CHANNEL,
		guild_id: GUILD,
		author: { id: OWNER, username: "owner" },
		content,
		type: 0,
		...overrides,
	};
}

describe("mention-free channels", () => {
	test("the owner's plain message in a mention-free channel is recorded without a mention", async () => {
		const { transport, recorded } = makeAdapter(CHANNEL);
		await transport.emitMessage(channelMessage("빌드 상태 어때"));
		expect(recorded).toEqual(["빌드 상태 어때"]);
	});

	test("another channel still requires addressing", async () => {
		const { transport, recorded } = makeAdapter(CHANNEL);
		await transport.emitMessage(channelMessage("다른 채널", { channel_id: OTHER_CHANNEL }));
		expect(recorded).toEqual([]);
	});

	test("a non-owner's message in the mention-free channel is still dropped", async () => {
		const { transport, recorded } = makeAdapter(CHANNEL);
		await transport.emitMessage(channelMessage("침투", { author: { id: INTRUDER, username: "intruder" } }));
		expect(recorded).toEqual([]);
	});

	test("attachments in the mention-free channel are downloaded like anywhere else", async () => {
		const { transport, recorded } = makeAdapter(CHANNEL);
		const url = `https://cdn.discordapp.com/attachments/${CHANNEL}/800000000000000001/log.png`;
		transport.downloads.set(url, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		await transport.emitMessage(
			channelMessage("", {
				attachments: [{ id: "800000000000000001", filename: "log.png", size: 4, url, content_type: "image/png" }],
			}),
		);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toContain("[첨부:");
	});
});

describe("thread-scoped sessions in a mention-free channel", () => {
	test("unaddressed thread replies route to the thread's own origin and continue that session", async () => {
		const { transport, recorded, origins } = makeAdapter(CHANNEL);
		const root = channelMessage("첫 질문");
		await transport.emitMessage(root);
		await transport.emitMessage(channelMessage("후속 질문", { channel_id: root.id }));
		// Both messages are audible (mention-free) and both land in the SAME thread session.
		expect(recorded).toEqual(["첫 질문", "후속 질문"]);
		expect(origins).toEqual([`discord/ch/${CHANNEL}/t/${root.id}`, `discord/ch/${CHANNEL}/t/${root.id}`]);
	});
});
