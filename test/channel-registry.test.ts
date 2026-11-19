import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelPort, OutboundMessage, PostTarget } from "../src/channel/port";
import { ChannelRegistry } from "../src/channel/registry";
import type { ChatPlatform } from "../src/core/origin-key";
import { DiscordChannel } from "../src/discord/channel";
import { REDACTED } from "../src/redact";
import { OWNER, OWNER_DM } from "./helpers/bot-home";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const TEAMS_CONVERSATION = "t0123456789abcdef";
const DISCORD_CHANNEL = "111111111111111111";
const DISCORD_THREAD = "222222222222222222";

// Assembled at run time so no token-shaped literal sits in the source (gitleaks).
const token = ["xo", "xb-", "1234567890", "-abcdefghijKLMNOP"].join("");

function setup() {
	const transport = new FakeDiscordTransport();
	const registry = new ChannelRegistry();
	registry.register(new DiscordChannel(transport, { ownerUserId: OWNER }));
	return { transport, registry, port: registry.get("discord") };
}

describe("ChannelRegistry", () => {
	test("post, edit and an upload comment reach the adapter redacted", async () => {
		const { transport, port } = setup();
		const dm = { conversationId: OWNER_DM };
		const ref = await port.post(dm, { text: `토큰 ${token}` });
		await port.edit(ref, { text: `고침 ${token}` });
		const file = join(tmpdir(), `registry-upload-${process.pid}.txt`);
		writeFileSync(file, "x");
		try {
			await port.uploadFile(dm, { path: file, title: `제목 ${token}`, comment: `설명 ${token}` });
		} finally {
			rmSync(file, { force: true });
		}

		const seen = JSON.stringify(transport.calls);
		expect(seen).not.toContain(token);
		expect(transport.calls.map((call) => ("content" in call ? (call.content ?? "") : ""))).toEqual([
			`토큰 ${REDACTED}`,
			`고침 ${REDACTED}`,
			`설명 ${REDACTED}`,
		]);
	});

	test("an upload's title and comment are redacted before the adapter sees them", async () => {
		const uploads: Array<{ title?: string; comment?: string }> = [];
		const registry = new ChannelRegistry();
		registry.register({
			...fakePort("discord"),
			uploadFile: async (_target, file) => {
				uploads.push({ title: file.title, comment: file.comment });
				return { fileId: "F1" };
			},
		});
		await registry
			.get("discord")
			.uploadFile(
				{ conversationId: OWNER_DM },
				{ path: "/tmp/a.txt", title: `제목 ${token}`, comment: `설명 ${token}` },
			);
		expect(uploads).toEqual([{ title: `제목 ${REDACTED}`, comment: `설명 ${REDACTED}` }]);
	});

	test("card title, body and fields are redacted on post and edit, through Discord and a second platform", async () => {
		const card = (tag: string) => ({
			text: `${tag} ${token}`,
			title: `제목 ${token}`,
			body: `본문 ${token}`,
			fields: [{ label: `라벨 ${token}`, value: `값 ${token}` }],
		});
		const { transport, port } = setup();
		const ref = await port.post({ conversationId: OWNER_DM }, card("게시"));
		await port.edit(ref, card("수정"));
		const seen = JSON.stringify(transport.calls);
		expect(seen).not.toContain(token);
		expect(seen).toContain(`제목 ${REDACTED}`);
		expect(seen).toContain(`본문 ${REDACTED}`);
		expect(seen).toContain(`라벨 ${REDACTED}`);
		expect(seen).toContain(`값 ${REDACTED}`);

		const received: OutboundMessage[] = [];
		const teams: ChannelPort = {
			...fakePort("teams"),
			post: async (target, msg) => {
				received.push(msg);
				return { platform: "teams", conversationId: target.conversationId, messageId: "1" };
			},
			edit: async (_ref, msg) => {
				received.push(msg);
			},
		};
		const registry = new ChannelRegistry();
		registry.register(teams);
		const routed = registry.get("teams");
		const posted = await routed.post({ conversationId: TEAMS_CONVERSATION }, card("게시"));
		await routed.edit(posted, card("수정"));
		const expected = {
			title: `제목 ${REDACTED}`,
			body: `본문 ${REDACTED}`,
			fields: [{ label: `라벨 ${REDACTED}`, value: `값 ${REDACTED}` }],
		};
		expect(received).toEqual([
			{ text: `게시 ${REDACTED}`, ...expected },
			{ text: `수정 ${REDACTED}`, ...expected },
		]);
	});
});

/** A second platform's port that records what reached it. */
function fakePort(platform: ChatPlatform): ChannelPort & { posts: Array<{ target: PostTarget; text: string }> } {
	const posts: Array<{ target: PostTarget; text: string }> = [];
	return {
		platform,
		posts,
		post: async (target, msg) => {
			posts.push({ target, text: msg.text });
			return { platform, conversationId: target.conversationId, messageId: String(posts.length) };
		},
		edit: async () => undefined,
		react: async () => undefined,
		uploadFile: async () => ({ fileId: "F1" }),
		permalink: async () => undefined,
		mentionUser: (userId) => `<@${userId}>`,
	};
}

describe("ChannelRegistry routing by thread ref and conversation id", () => {
	function twoPlatforms() {
		const teams = fakePort("teams");
		const discord = fakePort("discord");
		const registry = new ChannelRegistry();
		registry.register(teams);
		registry.register(discord);
		return { registry, teams, discord };
	}

	test("forThreadRef picks the platform's port and splits the target", () => {
		const { registry } = twoPlatforms();
		const teams = registry.forThreadRef(`${TEAMS_CONVERSATION}:ACT.1`);
		expect(teams?.port.platform).toBe("teams");
		expect(teams?.target).toEqual({ conversationId: TEAMS_CONVERSATION, threadId: "ACT.1" });
		const discord = registry.forThreadRef(`${DISCORD_CHANNEL}:${DISCORD_THREAD}`);
		expect(discord?.port.platform).toBe("discord");
		expect(discord?.target).toEqual({ conversationId: DISCORD_CHANNEL, threadId: DISCORD_THREAD });
		const top = registry.forThreadRef(`${DISCORD_CHANNEL}:-`);
		expect(top?.port.platform).toBe("discord");
		expect(top?.target).toEqual({ conversationId: DISCORD_CHANNEL });
		expect(top !== undefined && "threadId" in top.target).toBe(false);
	});

	test("an unregistered platform and a malformed ref resolve to nothing", () => {
		const teamsOnly = new ChannelRegistry();
		teamsOnly.register(fakePort("teams"));
		expect(teamsOnly.forThreadRef(`${DISCORD_CHANNEL}:${DISCORD_THREAD}`)).toBeUndefined();
		expect(teamsOnly.forConversation(DISCORD_CHANNEL)).toBeUndefined();
		const { registry } = twoPlatforms();
		expect(registry.forThreadRef("nocolon")).toBeUndefined();
		expect(registry.forConversation("c-1")).toBeUndefined();
	});

	test("forConversation picks the port by the id's grammar", () => {
		const { registry } = twoPlatforms();
		expect(registry.forConversation(TEAMS_CONVERSATION)).toMatchObject({
			port: { platform: "teams" },
			target: { conversationId: TEAMS_CONVERSATION },
		});
		expect(registry.forConversation("123456789012345678")?.port.platform).toBe("discord");
	});

	test("both ports get a token-shaped string redacted", async () => {
		const { registry, teams, discord } = twoPlatforms();
		const toTeams = registry.forThreadRef(`${TEAMS_CONVERSATION}:ACT.1`);
		const toDiscord = registry.forThreadRef(`${DISCORD_CHANNEL}:${DISCORD_THREAD}`);
		await toTeams?.port.post(toTeams.target, { text: `토큰 ${token}` });
		await toDiscord?.port.post(toDiscord.target, { text: `토큰 ${token}` });
		expect(teams.posts.map((p) => p.text)).toEqual([`토큰 ${REDACTED}`]);
		expect(discord.posts.map((p) => p.text)).toEqual([`토큰 ${REDACTED}`]);
	});
});

describe("qa50b K-14: button labels and values", () => {
	test("buttons' label and value are redacted on post and edit; actionId and style pass through", async () => {
		const received: OutboundMessage[] = [];
		const port: ChannelPort = {
			...fakePort("discord"),
			post: async (target, msg) => {
				received.push(msg);
				return { platform: "discord", conversationId: target.conversationId, messageId: "1" };
			},
			edit: async (_ref, msg) => {
				received.push(msg);
			},
		};
		const registry = new ChannelRegistry();
		registry.register(port);
		const routed = registry.get("discord");
		const msg = {
			text: "승인",
			buttons: [{ actionId: "approve", label: `라벨 ${token}`, value: `값 ${token}`, style: "primary" as const }],
		};
		const ref = await routed.post({ conversationId: OWNER_DM }, msg);
		await routed.edit(ref, msg);
		const button = {
			actionId: "approve",
			label: `라벨 ${REDACTED}`,
			value: `값 ${REDACTED}`,
			style: "primary" as const,
		};
		expect(received.map((m) => m.buttons)).toEqual([[button], [button]]);
	});
});
