// Discord peer bots, core side (doc/plans/discord-peer-bots.md A2): the peer inbound carries the keys its adapter
// built and the peer thread context compares 19-digit snowflakes exactly.
import { describe, expect, test } from "bun:test";
import { peerThreadContextBlock, type ThreadMessage } from "../src/core/mailbox";
import { normalizePeerInbound, originKeyForMessage, threadRefOf } from "../src/core/normalize";
import { parseChatOrigin } from "../src/core/origin-key";

const CONV = "345678901234567890";
const SELF = "456789012345678901";
const PEER = "567890123456789012";
const OWNER = "678901234567890123";

describe("normalizePeerInbound with Discord keys", () => {
	test("keeps the adapter's keys, so a Discord thread origin reads back as Discord", () => {
		const id = "1300000000000000000";
		const out = normalizePeerInbound({
			peer: { userId: PEER, name: "떡" },
			text: "검토 부탁",
			quoted: [],
			platformMessageId: threadRefOf(CONV, id),
			originKey: originKeyForMessage(CONV, "channel", id, undefined, "", "discord"),
			threadRef: threadRefOf(CONV, id),
		});
		if (!out.accept) throw new Error("rejected");
		expect(parseChatOrigin(out.inbound.originKey)).toEqual({
			platform: "discord",
			kind: "ch",
			conversationId: CONV,
			threadId: id,
		});
		expect(out.inbound.threadRef).toBe(`${CONV}:${id}`);
		expect(out.inbound.platformMessageId).toBe(`${CONV}:${id}`);
	});
});

describe("peerThreadContextBlock with snowflakes", () => {
	test("ids one apart past 2^53 stay ordered: the peer post after this bot's last one is in, the rest out", () => {
		// 1.3e18 is a multiple of 256 (the double spacing there): X, X+1 and X+2 all read as the same Number.
		const x = 1300000000000000000n;
		const messages: ThreadMessage[] = [
			{ ts: "1299999999999990000", text: "root by owner", user: OWNER, at: 1_700_000_000_000 },
			{ ts: String(x), text: "self last post", user: SELF, botId: SELF, at: 1_700_000_001_000 },
			{ ts: String(x + 1n), text: "peer follow-up", user: PEER, botId: PEER, at: 1_700_000_002_000 },
			{ ts: String(x + 2n), text: "current request", user: PEER, botId: PEER, at: 1_700_000_003_000 },
		];
		const block = peerThreadContextBlock(
			messages,
			SELF,
			String(x + 2n),
			`${CONV}:1299999999999990000`,
			"0123456789abcdef",
		);
		expect(block).not.toBeNull();
		expect(block).toContain("root by owner");
		expect(block).toContain("peer follow-up");
		expect(block).not.toContain("self last post");
		expect(block).not.toContain("current request");
		// The time shown is the message's own `at`, not the id read as epoch seconds.
		expect(block).toContain(new Date(1_700_000_002_000).toISOString());
	});
});
