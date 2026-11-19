import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platformOfThreadRef } from "../src/core/normalize";
import {
	type ChatOriginRef,
	type ChatPlatform,
	chatOriginKey,
	chatPlatformOf,
	GRAMMAR,
	parseChatOrigin,
	platformOfConversationId,
	REMOVED_PLATFORM_PREFIX,
} from "../src/core/origin-key";

describe("platformOfConversationId / platformOfThreadRef", () => {
	test.each([
		["123456789012345678", "discord"],
		["t0123456789abcdef", "teams"],
		["C0ESCALATE1", undefined],
		["D1", undefined],
		["", undefined],
		["-1001", undefined],
		["c1", undefined],
		["C-1", undefined],
	])("%p → %p", (id, platform) => {
		expect(platformOfConversationId(id)).toBe(platform as ChatPlatform | undefined);
	});

	test("a thread ref's conversation decides its platform; a ref without a colon has none", () => {
		expect(platformOfThreadRef("C1:1.2")).toBeUndefined();
		expect(platformOfThreadRef("111:222")).toBe("discord");
		expect(platformOfThreadRef("nocolon")).toBeUndefined();
	});

	test("a removed-platform (Slack) origin is no chat origin, whatever its conversation looks like", () => {
		expect(parseChatOrigin("slack/ch/C1")).toBeUndefined();
		expect(parseChatOrigin("slack/ch/123")).toBeUndefined();
		expect(parseChatOrigin("slack/dm/1D")).toBeUndefined();
		expect(REMOVED_PLATFORM_PREFIX).toBe("slack/");
	});

	test("the platform answer is GRAMMAR's conversation pattern itself, so parseChatOrigin and it never disagree", () => {
		for (const id of [
			"C0ESCALATE1",
			"D1",
			"U1",
			"123456789012345678",
			"t0123456789abcdef",
			"",
			"-1001",
			"c1",
			"C-1",
			"1D",
		]) {
			const platform = platformOfConversationId(id);
			expect(GRAMMAR.discord.conversation.test(id)).toBe(platform === "discord");
			expect(GRAMMAR.teams.conversation.test(id)).toBe(platform === "teams");
			if (platform !== undefined) expect(parseChatOrigin(`${platform}/dm/${id}`)?.platform).toBe(platform);
		}
	});

	test("no file in src defines its own Discord conversation-id pattern", () => {
		const root = join(import.meta.dir, "..", "src");
		const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts"));
		const owners = files.filter((file) => readFileSync(join(root, file), "utf8").includes("/^[0-9]{1,20}$/"));
		expect(owners).toEqual(["core/origin-key.ts"]);
	});
});

describe("parseChatOrigin / chatOriginKey", () => {
	const valid: Array<[string, ChatOriginRef]> = [
		["discord/dm/111", { platform: "discord", kind: "dm", conversationId: "111" }],
		["discord/ch/111", { platform: "discord", kind: "ch", conversationId: "111" }],
		[
			"teams/ch/t0123456789abcdef/t/1793316153495",
			{ platform: "teams", kind: "ch", conversationId: "t0123456789abcdef", threadId: "1793316153495" },
		],
		["discord/ch/111/t/222", { platform: "discord", kind: "ch", conversationId: "111", threadId: "222" }],
	];

	test.each(valid)("%s parses and round-trips", (key, ref) => {
		expect(parseChatOrigin(key)).toEqual(ref);
		expect(chatOriginKey(ref)).toBe(key);
		const parsed = parseChatOrigin(key);
		expect(parsed === undefined ? undefined : chatOriginKey(parsed)).toBe(key);
	});

	test.each([
		"monitor/x",
		"ompbot/work/a",
		"discord/ch/",
		"discord/xx/111",
		"discord/ch/111/t/",
		"line/dm/1",
		"telegram/dm/42",
	])("%s is not a chat origin", (key) => {
		expect(parseChatOrigin(key)).toBeUndefined();
	});

	test("conversationId is the channel of DM, channel and thread origins; non-chat origins have none", () => {
		expect(parseChatOrigin("discord/ch/111/t/100")?.conversationId).toBe("111");
		expect(parseChatOrigin("discord/ch/111")?.conversationId).toBe("111");
		expect(parseChatOrigin("discord/dm/222")?.conversationId).toBe("222");
		expect(parseChatOrigin("ompbot/work/lane")?.conversationId).toBeUndefined();
	});

	test("an id with no plausible length (4000 characters) is no conversation of any platform", () => {
		expect(parseChatOrigin(`discord/dm/${"1".repeat(4001)}`)).toBeUndefined();
		expect(parseChatOrigin(`discord/dm/${"1".repeat(21)}`)).toBeUndefined();
		expect(parseChatOrigin("discord/dm/123456789012345678")?.conversationId).toBe("123456789012345678");
	});

	test("chatPlatformOf names the namespace even of keys outside the id grammar", () => {
		expect(chatPlatformOf("discord/channel/111")).toBe("discord");
		expect(chatPlatformOf("slack/ch/C1")).toBeUndefined();
		expect(chatPlatformOf("telegram/dm/42")).toBeUndefined();
		expect(chatPlatformOf("monitor/3")).toBeUndefined();
		expect(chatPlatformOf("slack")).toBeUndefined();
	});
});
