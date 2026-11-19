import type { SpanKind, SpanStatus, TraceSpan, TurnTrace } from "./trace";

/** What the waterfall shows besides the trace: the page clock, folds, the focused row and the open details. */
export interface TraceViewState {
	/** The page clock (epoch ms); running spans grow into it. */
	now: number;
	/** Folded (true) or opened (false) by hand; without an entry a finished sub-agent starts folded. */
	fold: Record<string, boolean>;
	focus: string | null;
	/** The span whose details are open. */
	open: string | null;
	/** The turn's request line, after the root's name. */
	title: string;
}

/**
 * The turn's waterfall: a tree of rows (name, a bar on the turn's clock, duration, cost), the axis, the "now" line and
 * the details of the open span. Patchable in place: every changing piece carries `data-part`, and `data-sig` changes
 * exactly when the rows themselves do. Self-contained (shipped to the page).
 */
export function renderTrace(answer: TurnTrace, state: TraceViewState): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	if (!answer.ok) {
		const why: Record<string, string> = {
			no_database: "DB가 없어 트레이스를 읽지 못했어요",
			unknown_turn: "이 턴은 기록에 없어요",
			not_dispatched: "아직 시작하지 않은 턴이에요. 시작되면 트레이스가 나타납니다",
			no_session: "이 턴의 세션 파일을 찾지 못했어요",
		};
		return `<p class="note">${esc(why[answer.error] ?? answer.error)}</p>`;
	}
	const KIND: Record<SpanKind, string> = { agent: "턴", subagent: "하위 에이전트", llm: "모델 호출", tool: "도구" };
	const STATUS: Record<SpanStatus, [string, string]> = {
		running: ["실행 중", "is-info"],
		done: ["완료", "is-success"],
		failed: ["실패", "is-danger"],
	};
	const clock = Math.max(0, state.now - answer.startedAt);
	const endOf = (span: TraceSpan): number => Math.max(span.start, span.end ?? clock);
	const dur = (ms: number): string => {
		if (ms < 10_000) return `${(ms / 1000).toFixed(1)}초`;
		if (ms < 60_000) return `${Math.floor(ms / 1000)}초`;
		if (ms < 3_600_000)
			return `${Math.floor(ms / 60_000)}분${ms % 60_000 >= 1000 ? ` ${Math.floor((ms % 60_000) / 1000)}초` : ""}`;
		return `${Math.floor(ms / 3_600_000)}시간${ms % 3_600_000 >= 60_000 ? ` ${Math.floor((ms % 3_600_000) / 60_000)}분` : ""}`;
	};
	const money = (amount: number): string => (amount <= 0 ? "" : `$${amount.toFixed(amount >= 1 ? 2 : 3)}`);
	const count = (n: number): string =>
		n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

	// Roll-ups (agents add up their children), parents, and the slowest finished call.
	interface Sum {
		cost: number;
		tokensIn: number;
		tokensOut: number;
		llm: number;
		tool: number;
		agents: number;
	}
	const sums = new Map<string, Sum>();
	let slowest: TraceSpan | undefined;
	let far = 0;
	const walk = (span: TraceSpan): Sum => {
		const sum: Sum = {
			cost: span.cost ?? 0,
			tokensIn: span.tokensIn ?? 0,
			tokensOut: span.tokensOut ?? 0,
			llm: span.kind === "llm" && span.end !== undefined ? 1 : 0,
			tool: span.kind === "tool" ? 1 : 0,
			agents: span.kind === "subagent" ? 1 : 0,
		};
		far = Math.max(far, endOf(span));
		const ownTime = span.end === undefined ? -1 : span.end - span.start;
		if ((span.kind === "llm" || span.kind === "tool") && span.status !== "running" && ownTime > 0) {
			if (slowest === undefined || ownTime > (slowest.end ?? 0) - slowest.start) slowest = span;
		}
		for (const child of span.children ?? []) {
			const part = walk(child);
			sum.cost += part.cost;
			sum.tokensIn += part.tokensIn;
			sum.tokensOut += part.tokensOut;
			sum.llm += part.llm;
			sum.tool += part.tool;
			sum.agents += part.agents;
		}
		sums.set(span.id, sum);
		return sum;
	};
	const total = walk(answer.root);

	// The axis grows in round steps; a live run keeps a little room ahead of "now".
	const STEPS = [10, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * 1000);
	const need = answer.live ? Math.max(far, clock) * 1.06 : far;
	const range = STEPS.find((step) => step >= need) ?? Math.ceil(need / 86_400_000) * 86_400_000;
	const frac = (ms: number): string => (Math.min(1, Math.max(0, ms / range)) || 0).toFixed(4);

	const folded = (span: TraceSpan): boolean =>
		(span.children?.length ?? 0) > 0 &&
		(state.fold[span.id] ?? (span.kind === "subagent" && span.status !== "running"));
	const rows: Array<{ span: TraceSpan; level: number }> = [];
	const visit = (span: TraceSpan, level: number): void => {
		rows.push({ span, level });
		if (!folded(span)) for (const child of span.children ?? []) visit(child, level + 1);
	};
	visit(answer.root, 1);
	const focus = rows.some((row) => row.span.id === state.focus) ? state.focus : answer.root.id;
	const chevron =
		'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

	const rowHtml = ({ span, level }: { span: TraceSpan; level: number }): string => {
		const sum = sums.get(span.id);
		const own = endOf(span) - span.start;
		const cost = money(span.kind === "agent" || span.kind === "subagent" ? (sum?.cost ?? 0) : (span.cost ?? 0));
		const kids = (span.children?.length ?? 0) > 0;
		const isOpen = state.open === span.id;
		const name = span.kind === "agent" ? KIND.agent : span.name;
		const detail = span.kind === "agent" ? state.title : (span.detail ?? "");
		const label = [name, KIND[span.kind], STATUS[span.status][0], dur(own), cost]
			.filter((part) => part !== "")
			.join(", ");
		return `<div class="tw-row is-${span.kind} is-${span.status}${isOpen ? " is-open" : ""}" data-part="row" data-span="${esc(
			span.id,
		)}" style="--lv:${level - 1}" role="treeitem" aria-level="${level}"${kids ? ` aria-expanded="${!folded(span)}"` : ""} aria-selected="${isOpen}" tabindex="${
			span.id === focus ? 0 : -1
		}" aria-label="${esc(label)}"><span class="tw-name">${
			kids ? `<span class="tw-twist" data-trace-toggle>${chevron}</span>` : '<span class="tw-twist"></span>'
		}<i class="tw-sw" aria-hidden="true"></i><span class="tw-label">${esc(name)}</span>${
			detail === "" ? "" : `<span class="tw-detail">${esc(detail)}</span>`
		}${slowest !== undefined && slowest.id === span.id ? '<span class="tw-tag">가장 느림</span>' : ""}</span><span class="tw-track" aria-hidden="true"><i class="tw-bar" data-part="bar" style="--x:${frac(
			span.start,
		)};--w:${frac(own)}"></i></span><span class="tw-num" data-part="text">${esc(dur(own))}</span><span class="tw-num" data-part="text">${esc(
			cost,
		)}</span></div>`;
	};

	const ticks = [0, 0.25, 0.5, 0.75, 1];
	const axis = ticks.map((t) => `<span style="--x:${t}">${t === 0 ? "0" : esc(dur(range * t))}</span>`).join("");
	const guides = ticks
		.slice(1, -1)
		.map((t) => `<i class="tw-tick" style="--x:${t}"></i>`)
		.join("");
	const [stateWord, stateTone] = STATUS[answer.root.status];
	const summary = [
		`<b>${esc(dur(endOf(answer.root)))}</b>`,
		`모델 ${total.llm}회`,
		`도구 ${total.tool}회`,
		total.agents > 0 ? `하위 ${total.agents}` : "",
		total.tokensIn + total.tokensOut > 0 ? `토큰 ${count(total.tokensIn)} → ${count(total.tokensOut)}` : "",
		total.cost > 0 ? `<b>${esc(money(total.cost))}</b>` : "",
	]
		.filter((part) => part !== "")
		.join('<span aria-hidden="true"> · </span>');
	// Below the root: sub-agents are the only spans with children, so the button shows only when there are some.
	const branches = rows.filter((row) => row.level > 1 && (row.span.children?.length ?? 0) > 0);
	const foldable = branches.length > 0;
	const anyOpen = branches.some((row) => !folded(row.span));

	const picked = state.open === null ? undefined : rows.find((row) => row.span.id === state.open)?.span;
	let pop = "";
	if (picked !== undefined) {
		const sum = sums.get(picked.id);
		const agent = picked.kind === "agent" || picked.kind === "subagent";
		const at = new Date(answer.startedAt + picked.start);
		const clockText = [at.getHours(), at.getMinutes(), at.getSeconds()]
			.map((n) => String(n).padStart(2, "0"))
			.join(":");
		const facts: Array<[string, string]> = [
			["시작", `+${esc(dur(picked.start))} <span class="note-sub">${clockText}</span>`],
			[
				"소요",
				picked.status === "running"
					? `${esc(dur(endOf(picked) - picked.start))}째 실행 중`
					: esc(dur(endOf(picked) - picked.start)),
			],
			...(picked.kind === "agent" && state.title !== "" ? [["요청", esc(state.title)] as [string, string]] : []),
			...(picked.detail !== undefined && picked.kind !== "agent"
				? [["내용", esc(picked.detail)] as [string, string]]
				: []),
			...(picked.model !== undefined && picked.model !== picked.name
				? [["모델", esc(picked.model)] as [string, string]]
				: []),
			...(agent && sum !== undefined
				? [
						["호출", `모델 ${sum.llm}회 · 도구 ${sum.tool}회${sum.agents > 0 ? ` · 하위 ${sum.agents}` : ""}`] as [
							string,
							string,
						],
					]
				: []),
			...((sum?.tokensIn ?? 0) + (sum?.tokensOut ?? 0) > 0
				? [
						[
							agent ? "토큰 합계" : "토큰",
							`입력 ${esc(count(sum?.tokensIn ?? 0))} · 출력 ${esc(count(sum?.tokensOut ?? 0))}`,
						] as [string, string],
					]
				: []),
			...((sum?.cost ?? 0) > 0 ? [[agent ? "비용 합계" : "비용", esc(money(sum?.cost ?? 0))] as [string, string]] : []),
			...(picked.error === undefined
				? []
				: [["오류", `<span class="is-error">${esc(picked.error)}</span>`] as [string, string]]),
		];
		const [word, tone] = STATUS[picked.status];
		pop = `<div class="tw-pop-head"><i class="tw-sw" aria-hidden="true"></i><h4 id="tw-pop-title" class="tw-pop-title">${esc(
			picked.kind === "agent" ? KIND.agent : picked.name,
		)}</h4><span class="badge">${KIND[picked.kind]}</span><span class="badge ${tone}">${word}</span><button type="button" class="detail-close" data-trace-close>닫기 <kbd>Esc</kbd></button></div><dl class="facts">${facts
			.map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`)
			.join("")}</dl>`;
	}

	// djb2 of the row ids, folds and the slowest mark: equal means the rows can be patched in place.
	let hash = 5381;
	const sigText = `${rows.map((row) => `${row.span.id}:${folded(row.span) ? 1 : 0}`).join(",")}|${slowest?.id ?? ""}`;
	for (let i = 0; i < sigText.length; i++) hash = ((hash << 5) + hash + sigText.charCodeAt(i)) | 0;

	return `<div class="tw" data-trace data-sig="${(hash >>> 0).toString(36)}-${rows.length}"><div class="tw-head"><h3 class="h3">트레이스</h3><span class="tw-state ${stateTone}" role="status" aria-live="polite" data-part="html"><i class="tw-dot" aria-hidden="true"></i>${stateWord}</span>${
		foldable
			? `<button type="button" class="button is-ghost is-sm tw-fold-all" data-trace-fold-all data-part="text">${anyOpen ? "모두 접기" : "모두 펼치기"}</button>`
			: ""
	}<p class="tw-sum" data-part="html">${summary}</p></div><div class="tw-body"><div class="tw-axis" aria-hidden="true"><span>단계</span><span class="tw-axis-track" data-part="html">${axis}</span><span class="tw-num">시간</span><span class="tw-num">비용</span></div><div class="tw-tree" role="tree" aria-label="턴 트레이스: 모델 호출·도구·하위 에이전트"><div class="tw-rows"><div class="tw-guides" aria-hidden="true"><span></span><span class="tw-gtrack" data-part="html">${guides}</span></div>${
		answer.live
			? `<div class="tw-guides" aria-hidden="true"><span></span><span class="tw-gtrack"><i class="tw-now" data-part="bar" style="--x:${frac(clock)}"></i></span></div>`
			: ""
	}${rows.map(rowHtml).join("")}</div></div></div>${
		answer.truncated ? '<p class="note-sub">호출이 많아 앞부분은 생략했어요</p>' : ""
	}${(answer.root.children?.length ?? 0) === 0 ? '<p class="note-sub">아직 기록된 호출이 없어요</p>' : ""}<section class="tw-pop${
		picked === undefined ? "" : ` is-${picked.kind} is-${picked.status}`
	}" role="dialog" aria-labelledby="tw-pop-title" data-part="html"${picked === undefined ? " hidden" : ""}>${pop}</section></div>`;
}

/**
 * What a flow card says it is doing now, in one line (cut at 70 characters). The first match wins: a worker with no
 * recorded steps (agy, remote, no session) says so whatever its status; a running one names its newest tool (else its
 * newest span), or waits; a finished one adds its last step; a failed one its error. Delegated workers (spans with
 * `worker`) and what is under them are not looked at, so the turn's own card never shows a worker's tool.
 * Self-contained (shipped to the page).
 */
export function flowDoing(span: TraceSpan): string {
	const cut = (text: string): string => (text.length > 70 ? `${text.slice(0, 69)}…` : text);
	const own: TraceSpan[] = [];
	const collect = (list: TraceSpan[] | undefined): void => {
		for (const child of list ?? []) {
			if (child.worker !== undefined) continue;
			own.push(child);
			collect(child.children);
		}
	};
	collect(span.children);
	const newest = (spans: TraceSpan[]): TraceSpan | undefined => {
		let found: TraceSpan | undefined;
		for (const item of spans) if (found === undefined || item.start >= found.start) found = item;
		return found;
	};
	const say = (item: TraceSpan | undefined): string => (item === undefined ? "" : (item.detail ?? item.name));
	if (own.length === 0 && (span.detail ?? "").endsWith("단계 기록 없음")) return "단계 기록 없음";
	if (span.status === "running") {
		const last = newest(own.filter((item) => item.kind === "tool")) ?? newest(own);
		return last === undefined ? "기다리는 중" : cut(say(last));
	}
	const last = say(newest(own));
	if (span.status === "failed") {
		const why = span.error ?? last;
		return cut(why === "" ? "실패" : `실패 · ${why}`);
	}
	return cut(last === "" ? "끝남" : `끝남 · ${last}`);
}

/**
 * The turn as a flow: request → the bot (the turn's root) → one card per delegated worker, the owner's approvals as a
 * branch beside the bot. Cards carry `data-flow-card` and a `data-sig` of their own markup so the page replaces only
 * the cards that changed; worker cards are `[data-flow-worker]` buttons. Shares no selector with the waterfall.
 * Self-contained apart from `flowDoing` (both shipped to the page).
 */
export function renderFlow(answer: TurnTrace, state: TraceViewState): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	if (!answer.ok) return `<p class="note">${esc(answer.error)}</p>`;
	const STATUS: Record<SpanStatus, [string, string]> = {
		running: ["실행 중", "is-info"],
		done: ["완료", "is-success"],
		failed: ["실패", "is-danger"],
	};
	const money = (amount: number): string => (amount <= 0 ? "" : `$${amount.toFixed(amount >= 1 ? 2 : 3)}`);
	const clockText = (ms: number): string => {
		const at = new Date(ms);
		return [at.getHours(), at.getMinutes()].map((n) => String(n).padStart(2, "0")).join(":");
	};
	const costOf = (span: TraceSpan): number =>
		(span.cost ?? 0) + (span.children ?? []).reduce((sum, child) => sum + costOf(child), 0);
	const cut = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
	const sigOf = (text: string): string => {
		let hash = 5381;
		for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
		return (hash >>> 0).toString(36);
	};
	const card = (tag: string, attrs: string, key: string, classes: string, inner: string): string =>
		`<${tag} class="fl-card ${classes}" data-flow-card="${esc(key)}" data-sig="${sigOf(inner)}"${attrs}>${inner}</${tag}>`;
	const chip = (status: SpanStatus): string => `<span class="badge ${STATUS[status][1]}">${STATUS[status][0]}</span>`;

	const root = answer.root;
	const workers = (root.children ?? []).filter((span) => span.worker !== undefined);
	const approvals = answer.approvals ?? [];
	const counts = {
		running: workers.filter((span) => span.status === "running").length,
		done: workers.filter((span) => span.status === "done").length,
		failed: workers.filter((span) => span.status === "failed").length,
		pending: approvals.filter((item) => item.status === "pending").length,
	};
	const chips = (
		[
			["진행 중", counts.running, "is-info"],
			["끝남", counts.done, "is-success"],
			["실패", counts.failed, "is-danger"],
			["승인 대기", counts.pending, "is-warning"],
		] as Array<[string, number, string]>
	)
		.map(([label, n, tone]) => `<span class="badge fl-count ${n > 0 ? tone : "is-zero"}">${label} <b>${n}</b></span>`)
		.join("");

	const requestCard = card(
		"div",
		"",
		"request",
		"is-request",
		`<span class="fl-kicker">요청</span><span class="fl-title">${esc(cut(state.title === "" ? "(제목 없음)" : state.title, 120))}</span><span class="fl-meta">${esc(
			clockText(answer.startedAt),
		)} 시작 ${chip(root.status)}</span>`,
	);
	const rootCost = money(costOf(root));
	const rootCard = card(
		"div",
		"",
		"root",
		`is-root is-${root.status}`,
		`<span class="fl-kicker">송박</span><span class="fl-title">${esc(root.model ?? "모델 미상")}</span><span class="fl-meta">${chip(
			root.status,
		)}${rootCost === "" ? "" : `<span class="fl-cost">${esc(rootCost)}</span>`}</span><span class="fl-doing">${esc(flowDoing(root))}</span>`,
	);

	const approvalRow = (item: (typeof approvals)[number]): string => {
		const wait = Math.max(0, Math.floor((state.now - item.createdAt) / 60_000));
		const at = item.decidedAt === null ? "" : clockText(item.decidedAt);
		const text: Record<string, string> = {
			pending: `${item.summary} · 대기 ${wait}분`,
			approved: `승인됨 · ${at}`,
			denied: `거부됨 · ${at}`,
			replied: `답장됨 · ${at}`,
			expired: "시간 초과",
		};
		return `<li class="fl-appr is-${item.status}" data-approval="${esc(item.id)}">${esc(cut(text[item.status] ?? item.status, 90))}</li>`;
	};
	const approvalCard =
		approvals.length === 0
			? ""
			: card(
					"div",
					"",
					"approvals",
					`is-approvals${counts.pending > 0 ? " is-pending" : ""}`,
					`<span class="fl-kicker">오너 승인</span><ul class="fl-apprs">${approvals.map(approvalRow).join("")}</ul>`,
				);

	const workerCard = (span: TraceSpan): string => {
		const info = span.worker;
		const confidence = info?.tierConfidence ?? null;
		const percent = confidence === null ? 0 : Math.round(confidence * 100);
		const cost = money(costOf(span));
		const reason = info?.tierReason ?? "";
		return card(
			"button",
			` type="button" data-flow-worker="${esc(span.id)}" aria-label="${esc(`${span.name} 워커, 폭포에서 보기`)}"`,
			span.id,
			`is-worker is-${span.status}`,
			`<span class="fl-kicker">${esc(span.name)}</span><span class="fl-title">${esc(span.model ?? "모델 미상")}</span><span class="fl-meta"><span class="badge">${esc(
				info?.tier ?? "등급 없음",
			)}</span>${chip(span.status)}${cost === "" ? "" : `<span class="fl-cost">${esc(cost)}</span>`}</span>${
				confidence === null
					? '<span class="fl-confline is-none">판정 없음</span>'
					: `<span class="fl-confline"><span class="fl-bar" role="img" aria-label="확신 ${percent}%"><i style="--w:${confidence.toFixed(
							2,
						)}"></i></span>확신 ${percent}%</span>`
			}<span class="fl-doing">${esc(flowDoing(span))}</span>${
				reason === "" ? "" : `<span class="fl-reason">${esc(cut(reason, 70))}</span>`
			}`,
		);
	};

	return `<div class="fl" data-flow><div class="fl-chips" data-flow-card="chips" data-sig="${sigOf(chips)}">${chips}</div><div class="fl-main${
		approvalCard === "" ? "" : " has-approvals"
	}">${requestCard}<span class="fl-link" aria-hidden="true"></span>${rootCard}${
		approvalCard === "" ? "" : `<span class="fl-link is-side" aria-hidden="true"></span>${approvalCard}`
	}</div>${
		workers.length === 0
			? '<p class="note-sub fl-empty">이 턴은 맡긴 워커가 없어요</p>'
			: `<div class="fl-workers" role="list">${workers.map(workerCard).join("")}</div>`
	}</div>`;
}
