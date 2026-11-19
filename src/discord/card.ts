// Cards on Discord are embeds: a validated ```card fence (here) and an OutboundMessage card (`DiscordChannel`) both
// become one embed, cut to Discord's embed limits instead of being refused (doc/plans/discord-channel.md §10).
import type { CardChild } from "chat";
import { type CardElement, type CardTone, chartToAscii, tableToAscii, toneColorInt } from "../channel/card";
import { cutCodePointSafe, fenceCloseRun, fenceOpenRun } from "../channel/text";

/** Embed limits (Embed Limits table): title, description, field count, field name and value, all text together. */
export const EMBED_LIMITS = {
	title: 256,
	description: 4096,
	fields: 25,
	fieldName: 256,
	fieldValue: 1024,
	total: 6000,
};

export interface DiscordEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

export interface DiscordEmbed {
	title?: string;
	description?: string;
	fields?: DiscordEmbedField[];
	image?: { url: string };
	/** The colour bar on the embed's left edge (a card's `tone`). */
	color?: number;
}

/** A field name or value Discord requires non-empty: a zero-width space stands in. */
const EMPTY = "\u200b";

/** The backtick count of the fence still open at the end of `part` (0 when none), by the line-head rule of `codeBlock`. */
function openFenceRun(part: string): number {
	let open = 0;
	for (const line of part.split("\n")) {
		if (open === 0) open = fenceOpenRun(line) ?? 0;
		else if ((fenceCloseRun(line) ?? 0) >= open) open = 0;
	}
	return open;
}

/**
 * `text` cut to `limit`; a code fence the cut leaves open is closed inside the limit with a fence as long as its own.
 * When the closing fence would leave no body (a backtick run as long as the limit), the text is cut plainly instead
 * (qa-l #61).
 */
function cutFenced(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const cut = cutCodePointSafe(text, limit);
	let open = openFenceRun(cut);
	if (open === 0) return cut;
	let room = open + 1;
	for (;;) {
		if (limit - room <= 3) return cut;
		const shorter = cutCodePointSafe(text, limit - room);
		if (shorter.trim() === "") return cut;
		open = openFenceRun(shorter);
		if (open === 0) return shorter;
		if (open + 1 <= room) return `${shorter}\n${"`".repeat(open)}`;
		room = open + 1;
	}
}

/**
 * The embed within every limit: each value cut, fields capped at 25, then the whole kept under 6000 characters.
 * `image` and `color` pass unchanged.
 */
export function fitEmbed(embed: DiscordEmbed): DiscordEmbed {
	const title =
		embed.title === undefined || embed.title === "" ? undefined : cutCodePointSafe(embed.title, EMBED_LIMITS.title);
	const description =
		embed.description === undefined || embed.description.trim() === ""
			? undefined
			: cutFenced(embed.description, EMBED_LIMITS.description);
	const fields = (embed.fields ?? []).slice(0, EMBED_LIMITS.fields).map((field) => ({
		name: cutCodePointSafe(field.name || EMPTY, EMBED_LIMITS.fieldName),
		value: cutCodePointSafe(field.value || EMPTY, EMBED_LIMITS.fieldValue),
		...(field.inline === undefined ? {} : { inline: field.inline }),
	}));
	const fieldsLength = () => fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
	const over = () => (title?.length ?? 0) + (description?.length ?? 0) + fieldsLength() - EMBED_LIMITS.total;
	// Over the total: the last fields give way (title and description alone stay under it).
	while (over() > 0 && fields.length > 0) fields.pop();
	return {
		...(title === undefined ? {} : { title }),
		...(description === undefined ? {} : { description }),
		...(fields.length === 0 ? {} : { fields }),
		...(embed.image === undefined ? {} : { image: embed.image }),
		...(embed.color === undefined ? {} : { color: embed.color }),
	};
}

/** Discord's small grey line (`-# `) on every line of `text`. */
export function subtext(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim() === "" ? line : `-# ${line}`))
		.join("\n");
}

/** `text` in a fence one backtick longer than its longest run (at least 3), so a ``` inside cannot close it. */
const codeBlock = (text: string): string => {
	const fence = "`".repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
	return `${fence}\n${text}\n${fence}`;
};

/** A link url with the characters that end its `(…)` or the line (`|`, `<`, `>`, blanks, parentheses) percent-encoded. */
function markdownUrl(url: string): string {
	return url.replace(/[|<>()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * A link label (an image alt or a Link's label): `\`, `[` and `]` are backslash-escaped so the alt cannot close the label, and a
 * zero-width space after `@everyone`/`@here`'s `@` and the `<@` of a user/role mention keeps them plain text.
 */
function markdownLabel(alt: string | undefined): string {
	if (!alt) return "image";
	return alt
		.replace(/[\\[\]]/g, "\\$&")
		.replace(/@(everyone|here)/g, `@${EMPTY}$1`)
		.replace(/<@/g, `<${EMPTY}@`);
}

/** One card child as description lines; fields and the first image go to the embed itself. */
function childLines(child: CardChild, embed: { fields: DiscordEmbedField[]; image?: { url: string } }): string[] {
	switch (child.type) {
		case "text":
			return [
				child.style === "bold"
					? `**${child.content}**`
					: child.style === "muted"
						? subtext(child.content)
						: child.content,
			];
		case "fields":
			for (const field of child.children) embed.fields.push({ name: field.label, value: field.value, inline: true });
			return [];
		case "table":
			return [codeBlock(tableToAscii(child))];
		case "chart":
			return [codeBlock(chartToAscii(child))];
		case "divider":
			return [""];
		case "image":
			if (embed.image === undefined) {
				embed.image = { url: child.url };
				return [];
			}
			return [`[${markdownLabel(child.alt)}](${markdownUrl(child.url)})`];
		case "link":
			return [`[${markdownLabel(child.label)}](${markdownUrl(child.url)})`];
		case "section":
			return child.children.flatMap((nested) => childLines(nested, embed));
		default:
			// Actions and inputs are not in CARD_COMPONENTS, so a validated card never holds them.
			return [];
	}
}

/**
 * A validated card as one embed: Text → description, Fields → fields, Table/Chart → ASCII code blocks, Image → image,
 * `tone` → the embed's colour.
 */
export function cardToEmbed(card: CardElement, tone?: CardTone): DiscordEmbed {
	const parts: { fields: DiscordEmbedField[]; image?: { url: string } } = {
		fields: [],
		...(card.imageUrl ? { image: { url: card.imageUrl } } : {}),
	};
	const lines = [
		...(card.subtitle ? [subtext(card.subtitle)] : []),
		...card.children.flatMap((child) => childLines(child, parts)),
	];
	return fitEmbed({
		...(card.title ? { title: card.title } : {}),
		description: lines.join("\n"),
		fields: parts.fields,
		...(parts.image === undefined ? {} : { image: parts.image }),
		...(tone === undefined ? {} : { color: toneColorInt(tone) }),
	});
}
