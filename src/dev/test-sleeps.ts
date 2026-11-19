// 테스트에 새로 들어오는 고정 sleep을 걸러낸다. 스펙: doc/plans/diet-batch8-1-test-only-and-copies.md
export type SleepHit = { file: string; line: number; text: string };

const SLEEP_OK = /\/\/\s*sleep-ok:\s*\S/;
const NUM = String.raw`(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?|\.\d[\d_]*)`;
const BUN_SLEEP = new RegExp(String.raw`\bBun\.sleep(?:Sync)?\s*\(\s*(${NUM})\s*[,)]`, "g");
const SET_TIMEOUT = new RegExp(String.raw`\bsetTimeout\s*\(.*,\s*(${NUM})\s*\)`);
const nonZero = (s?: string) => ((n: number) => Number.isFinite(n) && n !== 0)(Number(s?.replaceAll("_", "")));
const hasSleep = (l: string) =>
	[...l.matchAll(BUN_SLEEP)].some((m) => nonZero(m[1])) || nonZero(SET_TIMEOUT.exec(l)?.[1]);

export function unjustifiedSleeps(diff: string): SleepHit[] {
	const hits: SleepHit[] = [];
	let [file, target, line, prev] = ["", false, 0, ""];
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ ")) {
			file = raw.startsWith("+++ b/") ? (raw.slice(6).split("\t")[0] ?? "") : "";
			target = file.startsWith("test/") && file.endsWith(".ts") && file !== "test/test-sleeps.test.ts";
			prev = "";
		} else if (raw.startsWith("@@")) {
			[line, prev] = [Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)?.[1] ?? line), ""];
		} else if (raw.startsWith("+")) {
			const text = raw.slice(1);
			if (target && !SLEEP_OK.test(text) && !SLEEP_OK.test(prev) && hasSleep(text)) hits.push({ file, line, text });
			[prev, line] = [text, line + 1];
		} else if (!raw.startsWith("-") || raw.startsWith("---")) {
			if (raw.startsWith(" ") || raw === "") line++;
			prev = "";
		}
	}
	return hits;
}

const git = (args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	return { ok: p.exitCode === 0, out: new TextDecoder().decode(p.stdout.length > 0 ? p.stdout : p.stderr).trim() };
};

if (import.meta.main) {
	const arg = process.argv.find((a) => a.startsWith("--base="))?.slice(7);
	const base = [arg, "origin/main", "main"]
		.map((r) => (r ? git(["merge-base", "HEAD", r]) : undefined))
		.find((g) => g?.ok)
		?.out.split("\n")[0];
	if (!base) console.log("[test-sleeps] 비교할 기준 없음, 건너뜀");
	else {
		const diff = git(["diff", "-U0", base, "--", "test/"]);
		if (!diff.ok) {
			console.error(`[test-sleeps] git diff 실패: ${diff.out}`);
			process.exit(1);
		}
		const hits = unjustifiedSleeps(diff.out);
		for (const h of hits) console.log(`${h.file}:${h.line}: ${h.text.trim()}`);
		if (hits.length > 0) {
			console.error(`[test-sleeps] 고정 sleep ${hits.length}건 추가됨. '// sleep-ok: <이유>' 또는 이벤트 대기 사용.`);
			process.exit(1);
		}
	}
}
