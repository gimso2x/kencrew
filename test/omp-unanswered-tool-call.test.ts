import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTINUE_PROMPT } from "../src/daemon/recovery";

/**
 * A turn the planned restart cut leaves its session with an assistant `toolCall` that has no `toolResult`. ompbot does
 * not repair the jsonl: the omp's message transform (pi-ai `providers/transform-messages.ts`) answers such a
 * call with a synthetic result before anything reaches a provider. This pins that behaviour to the omp the bot runs
 * (`OMPBOT_OMP_EXECUTABLE`, else the omp on PATH), so an omp upgrade that drops it fails here first.
 */

type Message = { role: string; toolCallId?: string; content?: Array<{ type: string; text?: string; id?: string }> };
type TransformMessages = (messages: Message[], model: Record<string, unknown>) => Message[];

/** The omp the bot runs: `OMPBOT_OMP_EXECUTABLE`, else the omp on PATH. */
const ompExecutable = process.env.OMPBOT_OMP_EXECUTABLE ?? Bun.which("omp") ?? undefined;

/**
 * `transform-messages.ts` of the omp's package: its root is the nearest ancestor of the executable's realpath that holds
 * `package.json` (a standalone ELF has none), and the file is looked up under the package's own
 * `node_modules/@oh-my-pi/pi-ai`, then at the hoisted `../pi-ai`. Returns the path, or why there is none.
 */
function locateTransform(executable: string | undefined): { path: string } | { unavailable: string } {
	if (executable === undefined) return { unavailable: "no omp executable (OMPBOT_OMP_EXECUTABLE unset, none on PATH)" };
	let real: string;
	try {
		real = realpathSync(executable);
	} catch {
		return { unavailable: `${executable} does not exist` };
	}
	let root = dirname(real);
	while (!existsSync(join(root, "package.json"))) {
		const parent = dirname(root);
		if (parent === root) return { unavailable: `${real} is not inside an npm package (standalone binary?)` };
		root = parent;
	}
	const tail = join("src", "providers", "transform-messages.ts");
	const candidates = [join(root, "node_modules", "@oh-my-pi", "pi-ai", tail), join(root, "..", "pi-ai", tail)];
	const found = candidates.find((candidate) => existsSync(candidate));
	return found === undefined ? { unavailable: `transform-messages.ts not found under ${root}` } : { path: found };
}

const located = locateTransform(ompExecutable);

async function ompTransform(transformPath: string): Promise<TransformMessages> {
	// Dynamic on purpose: the module lives in the omp install, not in this checkout's deps.
	const mod: unknown = await import(transformPath);
	if (
		typeof mod !== "object" ||
		mod === null ||
		!("transformMessages" in mod) ||
		typeof mod.transformMessages !== "function"
	) {
		throw new Error(`${transformPath} exports no transformMessages`);
	}
	const transform: TransformMessages = mod.transformMessages as TransformMessages; // the omp's pi-ai signature
	return transform;
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Session jsonl of a cut turn, then the resume prompt the next process sends into the same session. */
const sessionJsonl = [
	{
		type: "message",
		id: "e1",
		message: { role: "user", content: [{ type: "text", text: "배포해 줘" }], timestamp: 1 },
	},
	{
		type: "message",
		id: "e2",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "확인할게요." },
				{ type: "toolCall", id: "toolu_01CUT", name: "bash", arguments: { command: "git push" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			stopReason: "toolUse",
			usage,
			timestamp: 2,
		},
	},
	{
		type: "message",
		id: "e3",
		message: { role: "user", content: [{ type: "text", text: CONTINUE_PROMPT }], timestamp: 3 },
	},
]
	.map((entry) => JSON.stringify(entry))
	.join("\n");

const model = {
	id: "claude-test",
	name: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
	compat: {},
};

// A standalone binary or a missing omp has no readable transform: the reason is printed and the check is not run.
describe("omp: an unanswered tool call of a cut turn", () => {
	test("gets a synthetic tool result right after its assistant message, so every call is paired (no provider call)", async () => {
		if ("unavailable" in located) {
			console.warn(`omp unanswered-tool-call check not run: ${located.unavailable}`);
			return;
		}
		const transformMessages = await ompTransform(located.path);
		const messages = sessionJsonl.split("\n").map((line): Message => {
			const entry: unknown = JSON.parse(line);
			if (typeof entry !== "object" || entry === null || !("message" in entry))
				throw new Error(`not a message entry: ${line}`);
			const message = entry.message as Message; // written above in omp's session entry shape
			return message;
		});
		const out = transformMessages(messages, model);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		const result = out[2];
		expect(result?.toolCallId).toBe("toolu_01CUT");
		expect(result?.content?.map((c) => c.text)).toEqual(["No result provided"]);
		const calls = out.flatMap((m) => m.content?.filter((c) => c.type === "toolCall").map((c) => c.id) ?? []);
		const results = out.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
		expect(results).toEqual(calls);
	});
});
