/**
 * The page side of the turn waterfall, shipped as source next to `renderTrace` (the project's `lib` has no DOM types,
 * like the rest of the page script). `traceController(host)` owns one `#detail-trace` section: it reads
 * `api/turn/<id>/trace`, redraws every second while the turn runs (rows patched in place so bars glide instead of
 * jumping), re-reads every 5 seconds, and answers the tree's keys and clicks.
 */
export const TRACE_CLIENT = `function traceController(host) {
	let id = null;
	let url = "";
	let notes = null;
	let title = "";
	let answer = null;
	let receivedAt = 0;
	let fold = {};
	let focus = null;
	let openSpan = null;
	let generation = 0;
	let ticks = 0;
	// 폭포 (default) or 흐름도: the choice survives a reload; storage may be blocked, then it stays 폭포.
	let mode = "waterfall";
	try {
		if (localStorage.getItem("trace-mode") === "flow") mode = "flow";
	} catch (error) {
		mode = "waterfall";
	}
	const known = new Set();
	const bar = document.createElement("div");
	bar.className = "fl-mode";
	bar.setAttribute("role", "group");
	bar.setAttribute("aria-label", "보기 방식");
	bar.hidden = true;
	bar.innerHTML = '<button type="button" class="button is-ghost is-sm" data-trace-mode="waterfall">폭포</button><button type="button" class="button is-ghost is-sm" data-trace-mode="flow">흐름도</button>';
	const view = document.createElement("div");
	host.replaceChildren(bar, view);
	function setMode(next) {
		mode = next;
		try {
			localStorage.setItem("trace-mode", next);
		} catch (error) {
			// Storage blocked: the choice lasts until the page is left.
		}
		draw();
	}
	const clock = () => (answer && answer.ok ? answer.now + (Date.now() - receivedAt) : Date.now());
	const rowEl = (spanId) => {
		for (const row of host.querySelectorAll("[data-span]")) if (row.getAttribute("data-span") === spanId) return row;
		return null;
	};
	const ROW_ATTRS = ["class", "tabindex", "aria-selected", "aria-expanded", "aria-label"];
	/** Same rows: every data-part is patched in place (a bar keeps its element, so its transform transition runs). */
	function patch(prev, next) {
		const from = next.querySelectorAll("[data-part]");
		const to = prev.querySelectorAll("[data-part]");
		if (prev.getAttribute("data-sig") !== next.getAttribute("data-sig") || from.length !== to.length) return false;
		for (let i = 0; i < from.length; i++) {
			const a = from[i];
			const b = to[i];
			const kind = a.getAttribute("data-part");
			if (kind !== b.getAttribute("data-part")) return false;
			if (kind === "bar") {
				if (b.getAttribute("style") !== a.getAttribute("style")) b.setAttribute("style", a.getAttribute("style") || "");
			} else if (kind === "text") {
				if (b.textContent !== a.textContent) b.textContent = a.textContent;
			} else {
				const names = kind === "row" ? ROW_ATTRS : ["class", "hidden"];
				for (const name of names) {
					const value = a.getAttribute(name);
					if (value === null) b.removeAttribute(name);
					else if (b.getAttribute(name) !== value) b.setAttribute(name, value);
				}
				if (kind === "html" && b.innerHTML !== a.innerHTML) b.innerHTML = a.innerHTML;
			}
		}
		return true;
	}
	/** Same cards: only a card whose data-sig changed is replaced (keeping focus when it had it). */
	function patchFlow(prev, next) {
		const from = Array.from(next.querySelectorAll("[data-flow-card]"));
		const to = Array.from(prev.querySelectorAll("[data-flow-card]"));
		if (from.length !== to.length) return false;
		for (let i = 0; i < from.length; i++) if (from[i].getAttribute("data-flow-card") !== to[i].getAttribute("data-flow-card")) return false;
		for (let i = 0; i < from.length; i++) {
			if (from[i].getAttribute("data-sig") === to[i].getAttribute("data-sig")) continue;
			const focused = document.activeElement === to[i];
			to[i].replaceWith(from[i]);
			if (focused) from[i].focus({ preventScroll: true });
		}
		return true;
	}
	function draw() {
		if (!answer) return;
		if (!answer.ok && notes && notes[answer.error]) {
			const line = document.createElement("p");
			line.className = "note";
			line.textContent = notes[answer.error];
			bar.hidden = true;
			view.replaceChildren(line);
			return;
		}
		bar.hidden = !answer.ok;
		for (const button of bar.querySelectorAll("[data-trace-mode]")) {
			button.setAttribute("aria-pressed", String(button.getAttribute("data-trace-mode") === mode));
		}
		const state = { now: clock(), fold: fold, focus: focus, open: openSpan, title: title };
		const template = document.createElement("template");
		if (answer.ok && mode === "flow") {
			template.innerHTML = renderFlow(answer, state);
			const nextFlow = template.content.firstElementChild;
			const prevFlow = view.firstElementChild;
			if (prevFlow && nextFlow && prevFlow.matches("[data-flow]") && patchFlow(prevFlow, nextFlow)) return;
			view.replaceChildren(template.content);
			return;
		}
		template.innerHTML = renderTrace(answer, state);
		const next = template.content.firstElementChild;
		const prev = view.firstElementChild;
		if (prev && next && prev.matches("[data-trace]") && patch(prev, next)) return;
		const active = document.activeElement;
		const hadFocus = !!active && host.contains(active);
		const tree = host.querySelector(".tw-tree");
		const scroll = tree ? tree.scrollTop : 0;
		view.replaceChildren(template.content);
		const again = host.querySelector(".tw-tree");
		if (again) again.scrollTop = scroll;
		if (hadFocus && focus) {
			const row = rowEl(focus);
			if (row) row.focus({ preventScroll: true });
		}
	}
	function remember(span, out) {
		out.push(span.id);
		for (const child of span.children || []) remember(child, out);
		return out;
	}
	async function load() {
		const mine = generation;
		try {
			const response = await fetch(url, { cache: "no-store" });
			if (!response.ok && response.status !== 404) throw new Error("HTTP " + response.status);
			const body = await response.json();
			if (mine !== generation) return;
			answer = body;
			receivedAt = Date.now();
			draw();
			if (!answer.ok) return;
			// A span that was not in the last answer arrived just now: one brief highlight.
			const ids = remember(answer.root, []);
			if (known.size > 0) {
				for (const spanId of ids) {
					const row = known.has(spanId) ? null : rowEl(spanId);
					if (row) row.classList.add("is-new");
				}
			}
			for (const spanId of ids) known.add(spanId);
		} catch (error) {
			if (mine !== generation || answer) return;
			const line = document.createElement("p");
			line.className = "note";
			line.textContent = "트레이스를 읽지 못했어요 (" + (error && error.message ? error.message : String(error)) + ")";
			bar.hidden = true;
			view.replaceChildren(line);
		}
	}
	function moveTo(row) {
		if (!row) return;
		focus = row.getAttribute("data-span");
		// Open details follow the focused row.
		if (openSpan !== null) openSpan = focus;
		draw();
		const target = rowEl(focus);
		if (target) {
			target.focus({ preventScroll: true });
			target.scrollIntoView({ block: "nearest" });
		}
	}
	function refocus() {
		const row = focus ? rowEl(focus) : null;
		if (row) row.focus({ preventScroll: true });
	}
	/** Details just opened below the tree: bring them into the panel's view without moving the clicked row's box. */
	function reveal() {
		const pop = host.querySelector(".tw-pop");
		if (openSpan !== null && pop && !pop.hidden) pop.scrollIntoView({ block: "nearest" });
	}
	function branches(span, out) {
		if (span !== answer.root && (span.children || []).length > 0) out.push(span.id);
		for (const child of span.children || []) branches(child, out);
		return out;
	}
	return {
		/** \`source\` = { url, notes } reads another address (a worker card's) and words its 404 codes; default: the turn's. */
		open(turnId, turnTitle, source) {
			if (turnTitle) title = turnTitle;
			host.hidden = false;
			if (turnId === id) return draw();
			id = turnId;
			url = source ? source.url : "api/turn/" + encodeURIComponent(turnId) + "/trace";
			notes = source ? source.notes : null;
			answer = null;
			fold = {};
			focus = null;
			openSpan = null;
			ticks = 0;
			known.clear();
			generation += 1;
			const wrap = document.createElement("div");
			wrap.className = "skeleton";
			wrap.setAttribute("role", "status");
			wrap.innerHTML = '<p class="note-sub">트레이스를 불러오는 중…</p><div class="skeleton-bar is-w90"></div><div class="skeleton-bar is-w70"></div><div class="skeleton-bar is-w50"></div>';
			bar.hidden = true;
			view.replaceChildren(wrap);
			load();
		},
		/** Read the open trace once more (a card's status moved: its live flag and running spans change). */
		reload() {
			if (id !== null) load();
		},
		close() {
			if (id === null) return;
			id = null;
			answer = null;
			generation += 1;
			host.hidden = true;
			bar.hidden = true;
			view.replaceChildren();
		},
		/** Every second: running bars and the "now" line move; every fifth, the trace is read again. */
		tick() {
			if (id === null || !answer || !answer.ok || !answer.live || document.visibilityState !== "visible") return;
			ticks += 1;
			draw();
			if (ticks % 5 === 0) load();
		},
		/** A key inside the waterfall; true = handled (the page's own keys stay out). */
		key(event) {
			if (!answer || !answer.ok) return false;
			if (event.key === "Escape" && openSpan !== null) {
				openSpan = null;
				draw();
				refocus();
				return true;
			}
			const row = event.target.closest("[data-span]");
			if (!row) return false;
			const rows = Array.from(host.querySelectorAll("[data-span]"));
			const at = rows.indexOf(row);
			const spanId = row.getAttribute("data-span");
			const expanded = row.getAttribute("aria-expanded");
			const level = Number(row.getAttribute("aria-level"));
			switch (event.key) {
				case "ArrowDown":
				case "j":
					moveTo(rows[at + 1]);
					return true;
				case "ArrowUp":
				case "k":
					moveTo(rows[at - 1]);
					return true;
				case "Home":
					moveTo(rows[0]);
					return true;
				case "End":
					moveTo(rows[rows.length - 1]);
					return true;
				case "ArrowRight":
					if (expanded === "false") {
						fold[spanId] = false;
						focus = spanId;
						draw();
						refocus();
					} else if (expanded === "true") moveTo(rows[at + 1]);
					return true;
				case "ArrowLeft":
					if (expanded === "true") {
						fold[spanId] = true;
						focus = spanId;
						draw();
						refocus();
					} else {
						let parent = at - 1;
						while (parent >= 0 && Number(rows[parent].getAttribute("aria-level")) !== level - 1) parent -= 1;
						if (parent >= 0) moveTo(rows[parent]);
					}
					return true;
				case "Enter":
				case " ":
					focus = spanId;
					openSpan = openSpan === spanId ? null : spanId;
					draw();
					refocus();
					reveal();
					return true;
				default:
					return false;
			}
		},
		/** A click inside the waterfall; true = handled. */
		click(target) {
			if (!answer || !answer.ok) return false;
			const modeButton = target.closest("[data-trace-mode]");
			if (modeButton) {
				setMode(modeButton.getAttribute("data-trace-mode") === "flow" ? "flow" : "waterfall");
				return true;
			}
			// A flow card hands over to the waterfall with that worker unfolded and focused.
			const worker = target.closest("[data-flow-worker]");
			if (worker) {
				const spanId = worker.getAttribute("data-flow-worker");
				fold[spanId] = false;
				focus = spanId;
				setMode("waterfall");
				refocus();
				const row = rowEl(spanId);
				if (row) row.scrollIntoView({ block: "nearest" });
				return true;
			}
			if (target.closest("[data-trace-close]")) {
				openSpan = null;
				draw();
				refocus();
				return true;
			}
			if (target.closest("[data-trace-fold-all]")) {
				const button = target.closest("[data-trace-fold-all]");
				const folding = button.textContent === "모두 접기";
				for (const spanId of branches(answer.root, [])) fold[spanId] = folding;
				draw();
				return true;
			}
			const row = target.closest("[data-span]");
			if (!row) return false;
			const spanId = row.getAttribute("data-span");
			focus = spanId;
			if (target.closest("[data-trace-toggle]")) fold[spanId] = row.getAttribute("aria-expanded") === "true";
			else openSpan = openSpan === spanId ? null : spanId;
			draw();
			refocus();
			reveal();
			return true;
		},
	};
}
`;
