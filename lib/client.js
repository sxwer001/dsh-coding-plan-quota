/**
 * dsh-coding-plan-quota — browser half.
 *
 * Renders a quota ring into `conversation.input.right` — the compact controls
 * the composer tool row renders just before its model selector, so the ring
 * sits immediately left of the model readout.
 *
 * MANY QUOTA SOURCES, ONE RING
 * The node half reports every configured coding-plan provider at once. The ring
 * shows exactly one of them at a time; the hover card doubles as the source
 * picker (its bottom section lists every provider, dimming the ones that still
 * need a credential, and clicking one switches the ring to it). Clicking the
 * ring itself still cycles the time windows — 5-hour → weekly → monthly — for
 * whichever source is current. Both choices persist in localStorage.
 *
 * Every string follows the live DSH UI language. `locale.getLocale()` returns
 * a LocaleSnapshot (`{ active, locales, revision }`) rather than a string, so
 * the language id is read off `.active` and `locale.subscribe` re-renders the
 * ring, letting a language switch flip the chip and the card with no reload.
 * Anything that is not Chinese renders English.
 *
 * No build step: `require("react")` hands back the same React instance the
 * shipped UI uses, so hooks compose with the slot renderer.
 *
 * Numbers come from the node half at
 *   /plugins/dsh-coding-plan-quota/usage.json
 * Every API key stays on the node side and is never sent to this context.
 */
window.__ModuleLoader__.load({
	id: "dsh-coding-plan-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		const PLUGIN_ID = "dsh-coding-plan-quota";
		const SLOT_KEY = "conversation.input.right";
		const ROUTE = "/plugins/dsh-coding-plan-quota/usage.json";
		const WINDOW_STORAGE_KEY = "dsh-coding-plan-quota.window";
		const PROVIDER_STORAGE_KEY = "dsh-coding-plan-quota.provider";
		const POLL_MS = 60_000;

		/** The canonical window ids the node half normalises every provider into. */
		const CANONICAL_WINDOWS = ["session", "weekly", "monthly"];
		const DEFAULT_THRESHOLDS = [50, 75, 90];

		const RING_SIZE = 22;
		const RING_STROKE = 2.5;
		const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
		const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

		/** Tokens the hover card uses; copied onto the body-level node so it resolves anywhere. */
		const TOKENS = [
			"--dsw-alias-bg-overlay",
			"--dsw-alias-bg-layer-1",
			"--dsw-alias-bg-layer-2",
			"--dsw-alias-border-l1",
			"--dsw-alias-border-l2",
			"--dsw-alias-brand-primary",
			"--dsw-alias-label-primary",
			"--dsw-alias-label-secondary",
			"--dsw-alias-state-error-primary",
			"--dsw-alias-state-idle-primary",
			"--dsw-alias-state-success-primary",
			"--dsw-alias-state-warn-primary"
		];

		const WINDOW_META = {
			session: { zh: "5 小时", en: "5-hour", short: "5h" },
			weekly: { zh: "每周", en: "Weekly", short: "1w" },
			monthly: { zh: "每月", en: "Monthly", short: "1M" }
		};

		/* ------------------------------------------------------------------ locale */

		/**
		 * The active DSH UI language, cached as a BCP 47 id (e.g. "zh", "en").
		 *
		 * `locale.getLocale()` hands back an immutable LocaleSnapshot —
		 * `{ active, locales, revision }` — NOT a string, so a naive
		 * `String(snapshot)` yields "[object Object]" and every locale test
		 * silently fails. The id lives on `.active`.
		 */
		let localeId = "en";
		const localeListeners = new Set();

		function snapshotLocale(face) {
			if (!face || typeof face.getLocale !== "function") return "";
			const snapshot = face.getLocale();
			// Older or shimmed faces may still return a bare id.
			if (typeof snapshot === "string") return snapshot;
			if (snapshot && typeof snapshot === "object" && typeof snapshot.active === "string") return snapshot.active;
			return "";
		}

		/** Last resort when no locale face answered: the browser/Electron language. */
		function hostLocale() {
			try {
				if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
			} catch (error) {
				/* ignore */
			}
			try {
				return (document.documentElement && document.documentElement.lang) || "";
			} catch (error) {
				/* ignore */
			}
			return "";
		}

		/** Refresh the cached id and wake every mounted ring; a no-op when unchanged. */
		function syncLocale(ctx) {
			let id = "";
			try {
				id = snapshotLocale(ctx && ctx.locale);
			} catch (error) {
				id = "";
			}
			if (!id) id = hostLocale();
			id = String(id || "en");
			if (id === localeId) return;
			localeId = id;
			for (const notify of Array.from(localeListeners)) {
				try {
					notify();
				} catch (error) {
					/* one stale listener must not strand the others */
				}
			}
		}

		/** The UI language is Chinese (any variant). */
		function zhNow() {
			return /^zh/i.test(localeId);
		}

		/**
		 * Re-render the calling component whenever DSH's UI language changes,
		 * and report whether that language is Chinese.
		 */
		function useLocale() {
			const [, bump] = react.useReducer((n) => n + 1, 0);
			react.useEffect(() => {
				localeListeners.add(bump);
				return () => {
					localeListeners.delete(bump);
				};
			}, []);
			return zhNow();
		}

		/* ------------------------------------------------------------------ styles */

		const CSS = `
.dsh-ogqr-btn{display:inline-flex;align-items:center;justify-content:center;width:${RING_SIZE}px;height:${RING_SIZE}px;padding:0;margin:0 1px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;vertical-align:middle;flex:0 0 auto;-webkit-appearance:none;appearance:none}
.dsh-ogqr-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-ogqr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-ogqr-svg{display:block;overflow:visible}
.dsh-ogqr-track{stroke:var(--dsw-alias-border-l1)}
.dsh-ogqr-arc{transition:stroke-dasharray .45s ease,stroke .3s linear}
.dsh-ogqr-label{font-size:7px;font-weight:600;letter-spacing:-.2px;fill:var(--dsh-ogqr-colour,var(--dsw-alias-label-primary));font-family:inherit}
.dsh-ogqr-btn[data-status="error"] .dsh-ogqr-label{fill:var(--dsw-alias-state-error-primary)}
.dsh-ogqr-btn[data-busy="1"]{opacity:.65}
@media (prefers-reduced-motion: no-preference){.dsh-ogqr-btn[data-urgent="1"] .dsh-ogqr-arc{animation:dsh-ogqr-pulse 2s ease-in-out infinite}}
@keyframes dsh-ogqr-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.dsh-ogqr-tip{position:fixed;z-index:2147483000;pointer-events:auto;box-sizing:border-box;min-width:212px;max-width:286px;max-height:min(70vh,440px);overflow-y:auto;overscroll-behavior:contain;padding:9px 11px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.5;font-family:inherit;box-shadow:0 8px 26px rgba(0,0,0,.22)}
.dsh-ogqr-tip-head{font-size:11px;font-weight:600;opacity:.95}
.dsh-ogqr-tip-plan{font-weight:400;color:var(--dsw-alias-label-secondary)}
.dsh-ogqr-tip-main{display:flex;align-items:baseline;gap:6px;margin-top:3px}
.dsh-ogqr-tip-pct{font-size:20px;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums}
.dsh-ogqr-tip-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-ogqr-tip-line{display:flex;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-secondary)}
.dsh-ogqr-tip-line>span:last-child{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-ogqr-tip-err{margin-top:3px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dsh-ogqr-tip-hint{margin-top:3px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dsh-ogqr-tip-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;padding:0 3px;border-radius:3px;background:var(--dsw-alias-bg-layer-1)}
.dsh-ogqr-sect{margin-top:7px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-ogqr-sect-title{font-size:10px;opacity:.75;margin-bottom:3px;color:var(--dsw-alias-label-secondary)}
.dsh-ogqr-bar{display:flex;align-items:center;gap:6px;padding:1px 4px;border-radius:5px;cursor:pointer}
.dsh-ogqr-bar:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-ogqr-bar-name{flex:0 0 46px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-ogqr-bar.is-active .dsh-ogqr-bar-name{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-ogqr-bar-track{flex:1 1 auto;height:4px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}
.dsh-ogqr-bar-track>i{display:block;height:100%;border-radius:999px;transition:width .45s ease}
.dsh-ogqr-bar-pct{flex:0 0 34px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dsh-ogqr-bar.is-active .dsh-ogqr-bar-pct{color:var(--dsw-alias-label-primary)}
.dsh-ogqr-src{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:5px;cursor:pointer}
.dsh-ogqr-src:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-ogqr-src.is-active{background:var(--dsw-alias-bg-layer-1)}
.dsh-ogqr-src.is-active .dsh-ogqr-src-name{font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-ogqr-src[data-status="unconfigured"]{opacity:.55}
.dsh-ogqr-src[data-status="disabled"]{display:none}
.dsh-ogqr-src-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dsh-ogqr-src-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dsh-ogqr-src-val{flex:0 0 auto;max-width:118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
/* Collapsed source entry: one row until the user asks for the picker. */
.dsh-ogqr-entry{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:5px;cursor:pointer}
.dsh-ogqr-entry:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-ogqr-entry-name{flex:1 1 auto;color:var(--dsw-alias-label-secondary)}
.dsh-ogqr-entry-val{flex:0 0 auto;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-ogqr-chev{flex:0 0 auto;opacity:.5;font-size:12px;line-height:1}
.dsh-ogqr-picker-head{display:flex;align-items:center;gap:6px}
.dsh-ogqr-back{flex:0 0 auto;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:1;-webkit-appearance:none;appearance:none}
.dsh-ogqr-back:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-ogqr-picker-title{flex:1 1 auto;font-size:11px;font-weight:600}
.dsh-ogqr-toggle{display:block;width:100%;margin-top:4px;padding:2px 4px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;text-align:left;cursor:pointer;-webkit-appearance:none;appearance:none}
.dsh-ogqr-toggle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-ogqr-tip-foot{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:10px;opacity:.85;font-variant-numeric:tabular-nums}
`;

		function injectStyles() {
			if (document.getElementById("dsh-ogqr-style")) return;
			const el = document.createElement("style");
			el.id = "dsh-ogqr-style";
			// Must be marked before the style revision changes, otherwise
			// `@deepseek-ai/dsh-client-modules` claims and later removes it.
			el.setAttribute("data-plugin", PLUGIN_ID);
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		/* ----------------------------------------------------------------- helpers */

		function esc(value) {
			return String(value).replace(/[&<>"']/g, (ch) => {
				switch (ch) {
					case "&": return "&amp;";
					case "<": return "&lt;";
					case ">": return "&gt;";
					case '"': return "&quot;";
					default: return "&#39;";
				}
			});
		}

		function describe(key) {
			const meta = WINDOW_META[key];
			if (meta) return meta;
			return { zh: String(key), en: String(key), short: String(key).slice(0, 2) };
		}

		function labelFor(key) {
			const meta = describe(key);
			return zhNow() ? meta.zh : meta.en;
		}

		/** Provider labels arrive already localised from the node half. */
		function providerLabel(provider) {
			if (!provider) return "—";
			const label = provider.label;
			if (label && typeof label === "object") {
				const value = zhNow() ? label.zh || label.en : label.en || label.zh;
				if (value) return String(value);
			}
			if (typeof label === "string" && label) return label;
			return String(provider.id || "—");
		}

		function readStored(key, fallback) {
			try {
				const stored = window.localStorage.getItem(key);
				if (stored) return stored;
			} catch (error) {
				/* storage may be unavailable */
			}
			return fallback;
		}

		function writeStored(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch (error) {
				/* ignore */
			}
		}

		function toPercent(entry) {
			if (!entry) return null;
			const value = Number(entry.percent);
			if (!Number.isFinite(value)) return null;
			return Math.max(0, Math.min(100, Math.round(value)));
		}

		/** green → blue → orange → red, all through theme tokens. */
		function colourFor(percent, thresholds) {
			if (percent === null) return "var(--dsw-alias-state-idle-primary)";
			const [blue, orange, red] = thresholds;
			if (percent >= red) return "var(--dsw-alias-state-error-primary)";
			if (percent >= orange) return "var(--dsw-alias-state-warn-primary)";
			if (percent >= blue) return "var(--dsw-alias-brand-primary)";
			return "var(--dsw-alias-state-success-primary)";
		}

		/** The worst window of a provider, which is what the source list summarises. */
		function worstPercent(provider) {
			if (!provider || !provider.windows || typeof provider.windows !== "object") return null;
			let worst = null;
			for (const entry of Object.values(provider.windows)) {
				const value = toPercent(entry);
				if (value === null) continue;
				if (worst === null || value > worst) worst = value;
			}
			return worst;
		}

		function currencyGlyph(currency) {
			const code = String(currency || "").toUpperCase();
			if (code === "CNY" || code === "RMB") return "¥";
			if (code === "USD") return "$";
			if (code === "EUR") return "€";
			if (code === "JPY") return "¥";
			return code ? code.slice(0, 1) : "•";
		}

		/** Balance providers have no windows; the card shows their money instead. */
		function balanceText(provider) {
			if (!provider || !Array.isArray(provider.balances) || !provider.balances.length) return null;
			const first = provider.balances[0];
			if (first && typeof first.display === "string" && first.display) return first.display;
			if (first && Number.isFinite(Number(first.amount))) return `${currencyGlyph(first.currency)}${Number(first.amount)}`;
			return null;
		}

		function pad2(value) {
			return String(value).padStart(2, "0");
		}

		function formatClock(timestamp) {
			if (!timestamp) return "—";
			const date = new Date(timestamp);
			return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
		}

		function formatRemaining(ms) {
			if (!Number.isFinite(ms)) return "—";
			if (ms <= 0) return zhNow() ? "即将重置" : "any moment";
			const total = Math.floor(ms / 1000);
			const days = Math.floor(total / 86400);
			const hours = Math.floor((total % 86400) / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			if (days > 0) return zhNow() ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`;
			if (hours > 0) return zhNow() ? `${hours} 小时 ${minutes} 分` : `${hours}h ${minutes}m`;
			if (minutes > 0) return zhNow() ? `${minutes} 分 ${seconds} 秒` : `${minutes}m ${seconds}s`;
			return zhNow() ? `${seconds} 秒` : `${seconds}s`;
		}

		/** Providers are grouped so the readable ones float to the top of the picker. */
		const STATUS_RANK = { ok: 0, stale: 1, error: 2, unconfigured: 3, disabled: 4 };

		/**
		 * Back-compatibility shim. A node half older than the provider registry
		 * answers with a bare `usage` object (rolling/weekly/monthly) instead of a
		 * `providers` list. A live client bundle always reloads from disk on a page
		 * refresh, but the node half is only re-imported when the host restarts, so
		 * the two halves can legitimately disagree for a while. Reshape the old
		 * payload so the ring keeps rendering the OpenCode Go quota meanwhile.
		 */
		const LEGACY_WINDOW_MAP = { rolling: "session", weekly: "weekly", monthly: "monthly" };

		function legacyProviders(data) {
			if (!data || !data.usage || typeof data.usage !== "object") return [];
			const windows = {};
			for (const from of Object.keys(LEGACY_WINDOW_MAP)) {
				const entry = data.usage[from];
				if (entry && typeof entry === "object") windows[LEGACY_WINDOW_MAP[from]] = entry;
			}
			if (!Object.keys(windows).length) return [];
			return [
				{
					id: "opencode-go",
					label: { zh: "OpenCode Go", en: "OpenCode Go" },
					kind: "windows",
					status: data.stale ? "stale" : "ok",
					windows,
					keySource: data.keySource,
					fetchedAt: data.fetchedAt,
					cacheAgeMs: data.cacheAgeMs
				}
			];
		}

		function sortProviders(list) {
			return list
				.map((provider, index) => ({ provider, index }))
				.sort((a, b) => {
					const rankA = STATUS_RANK[a.provider.status] ?? 5;
					const rankB = STATUS_RANK[b.provider.status] ?? 5;
					if (rankA !== rankB) return rankA - rankB;
					return a.index - b.index;
				})
				.map((entry) => entry.provider);
		}

		function buildCard(options) {
			const parts = [];
			const plan = options.plan ? ` <span class="dsh-ogqr-tip-plan">· ${esc(options.plan)}</span>` : "";
			parts.push(`<div class="dsh-ogqr-tip-head">${esc(options.title)}${plan}</div>`);
			if (options.notice) parts.push(`<div class="dsh-ogqr-tip-err">${esc(options.notice)}</div>`);
			if (options.hint) parts.push(`<div class="dsh-ogqr-tip-hint">${options.hint}</div>`);

			if (options.balance) {
				parts.push(
					`<div class="dsh-ogqr-tip-main">` +
						`<span class="dsh-ogqr-tip-pct">${esc(options.balance)}</span>` +
						`<span class="dsh-ogqr-tip-sub">${esc(options.balanceLabel)}</span>` +
						`</div>`
				);
			} else if (options.percent !== null) {
				parts.push(
					`<div class="dsh-ogqr-tip-main">` +
						`<span class="dsh-ogqr-tip-pct" style="color:${options.colour}">${esc(options.percent)}%</span>` +
						`<span class="dsh-ogqr-tip-sub">${esc(options.windowLabel)}</span>` +
						`</div>`
				);
				parts.push(
					`<div class="dsh-ogqr-tip-line"><span>${esc(options.resetLabel)}</span>` +
						`<span>${esc(options.remaining)}</span></div>`
				);
			}

			if (options.bars) {
				parts.push(`<div class="dsh-ogqr-sect">${options.bars}</div>`);
			}
			if (options.entry) {
				parts.push(`<div class="dsh-ogqr-sect">${options.entry}</div>`);
			}
			parts.push(`<div class="dsh-ogqr-tip-foot">${esc(options.foot)}</div>`);
			return parts.join("");
		}

		/**
		 * The second page of the card. The full source list is deliberately kept
		 * out of the default view: on a machine with a dozen plans it buried the
		 * numbers it exists to show, so the list only appears once asked for.
		 */
		function buildPicker(options) {
			return (
				`<div class="dsh-ogqr-picker-head">` +
				`<button type="button" class="dsh-ogqr-back" data-close-picker="1" aria-label="${esc(options.backLabel)}">\u2039</button>` +
				`<span class="dsh-ogqr-picker-title">${esc(options.title)}</span>` +
				`</div>` +
				options.rows +
				options.toggle +
				`<div class="dsh-ogqr-tip-foot">${esc(options.foot)}</div>`
			);
		}

		/* --------------------------------------------------------------- the ring */

		function QuotaRing() {
			// Re-renders when DSH's UI language changes; every string below follows it.
			const zh = useLocale();
			const [snapshot, setSnapshot] = react.useState({ status: "loading", data: null, error: null });
			const [windowKey, setWindowKey] = react.useState(() => readStored(WINDOW_STORAGE_KEY, CANONICAL_WINDOWS[0]));
			const [providerId, setProviderId] = react.useState(() => readStored(PROVIDER_STORAGE_KEY, ""));
			const [hovered, setHovered] = react.useState(false);
			// Which page of the card is showing, and whether the unconfigured
			// sources are expanded. Both reset whenever the card closes.
			const [picker, setPicker] = react.useState(false);
			const [showUnconfigured, setShowUnconfigured] = react.useState(false);
			const buttonRef = react.useRef(null);
			const tipRef = react.useRef(null);
			const aliveRef = react.useRef(true);
			const hideTimer = react.useRef(null);
			const [, forceTick] = react.useReducer((n) => n + 1, 0);

			/**
			 * The card is a body-level node whose innerHTML is rebuilt every
			 * render, so its click listener must not close over stale state.
			 * Everything it needs is read through this ref at click time.
			 */
			const actions = react.useRef({});

			const load = react.useCallback(async (query) => {
				try {
					const response = await fetch(`${ROUTE}${query || ""}`, {
						cache: "no-store",
						credentials: "same-origin"
					});
					const body = await response.json().catch(() => null);
					if (!aliveRef.current) return;
					if (!body) {
						setSnapshot({ status: "error", data: null, error: `HTTP ${response.status}` });
						return;
					}
					if (body.provider && body.providers && body.providers.length) {
						// A single-provider refresh merges into what we already hold.
						setSnapshot((previous) => {
							const previousData = previous.data;
							if (!previousData || !Array.isArray(previousData.providers)) {
								return { status: "ready", data: body, error: null };
							}
							const merged = previousData.providers.map(
								(entry) => body.providers.find((fresh) => fresh.id === entry.id) || entry
							);
							for (const fresh of body.providers) {
								if (!merged.some((entry) => entry.id === fresh.id)) merged.push(fresh);
							}
							return { status: "ready", data: { ...previousData, providers: merged }, error: null };
						});
						return;
					}
					setSnapshot({ status: body.ok === false ? "error" : "ready", data: body, error: null });
				} catch (error) {
					if (!aliveRef.current) return;
					setSnapshot({ status: "error", data: null, error: String((error && error.message) || error) });
				}
			}, []);

			react.useEffect(() => {
				aliveRef.current = true;
				load("");
				const poll = setInterval(() => load(""), POLL_MS);
				const onVisibility = () => {
					if (document.visibilityState === "visible") load("");
				};
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					aliveRef.current = false;
					clearInterval(poll);
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, [load]);

			// The countdown only needs to tick while the card is on screen.
			react.useEffect(() => {
				if (!hovered) return undefined;
				const tick = setInterval(forceTick, 1000);
				return () => clearInterval(tick);
			}, [hovered]);

			// Moving the pointer from the ring onto the card must not close it,
			// so closing is deferred and the card cancels the pending hide.
			const scheduleHide = react.useCallback(() => {
				if (hideTimer.current) clearTimeout(hideTimer.current);
				hideTimer.current = setTimeout(() => {
					hideTimer.current = null;
					setHovered(false);
				}, 140);
			}, []);

			const cancelHide = react.useCallback(() => {
				if (hideTimer.current) {
					clearTimeout(hideTimer.current);
					hideTimer.current = null;
				}
			}, []);

			react.useEffect(() => () => cancelHide(), [cancelHide]);

			// Reopening the card always starts on the main page.
			react.useEffect(() => {
				if (hovered) return;
				setPicker(false);
				setShowUnconfigured(false);
			}, [hovered]);

			// The card lives on <body> so no composer overflow can clip it.
			react.useEffect(() => {
				if (!hovered) return undefined;
				const el = document.createElement("div");
				el.className = "dsh-ogqr-tip";
				el.setAttribute("data-plugin", PLUGIN_ID);
				el.setAttribute("role", "tooltip");
				document.body.appendChild(el);
				tipRef.current = el;

				const activate = (node) => {
					if (node.closest("[data-open-picker]")) {
						if (actions.current.openPicker) actions.current.openPicker();
						return;
					}
					if (node.closest("[data-close-picker]")) {
						if (actions.current.closePicker) actions.current.closePicker();
						return;
					}
					if (node.closest("[data-toggle-unconfigured]")) {
						if (actions.current.toggleUnconfigured) actions.current.toggleUnconfigured();
						return;
					}
					const windowNode = node.closest("[data-window]");
					if (windowNode) {
						const key = windowNode.getAttribute("data-window");
						if (key && actions.current.chooseWindow) actions.current.chooseWindow(key);
						return;
					}
					const providerNode = node.closest("[data-provider]");
					if (providerNode) {
						const id = providerNode.getAttribute("data-provider");
						if (id && actions.current.chooseProvider) actions.current.chooseProvider(id);
					}
				};

				const onClick = (event) => {
					const target = event.target;
					if (!target || typeof target.closest !== "function") return;
					activate(target);
				};

				// Rows carry tabindex="0"; a real <button> already turns
				// Enter/Space into a click, so skip it to avoid firing twice.
				const onKeyDown = (event) => {
					if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
					const target = event.target;
					if (!target || typeof target.closest !== "function") return;
					if (target.tagName === "BUTTON") return;
					if (!target.closest("[data-open-picker],[data-window],[data-provider]")) return;
					event.preventDefault();
					activate(target);
				};

				el.addEventListener("click", onClick);
				el.addEventListener("keydown", onKeyDown);
				el.addEventListener("mouseenter", cancelHide);
				el.addEventListener("mouseleave", scheduleHide);
				return () => {
					el.removeEventListener("click", onClick);
					el.removeEventListener("keydown", onKeyDown);
					el.removeEventListener("mouseenter", cancelHide);
					el.removeEventListener("mouseleave", scheduleHide);
					if (tipRef.current === el) tipRef.current = null;
					el.remove();
				};
			}, [hovered, cancelHide, scheduleHide]);

			const data = snapshot.data;
			const thresholds =
				data && Array.isArray(data.thresholds) && data.thresholds.length === 3
					? data.thresholds
					: DEFAULT_THRESHOLDS;
			const providers = sortProviders(
				data && Array.isArray(data.providers) ? data.providers.slice() : legacyProviders(data)
			);

			// The stored choice wins; otherwise the node half's default; otherwise
			// the first provider that actually produced numbers.
			const resolvedProvider =
				providers.find((entry) => entry.id === providerId) ||
				providers.find((entry) => entry.id === (data && data.defaultProvider)) ||
				providers.find((entry) => entry.status === "ok" || entry.status === "stale") ||
				providers[0] ||
				null;

			const isBalance = Boolean(resolvedProvider && resolvedProvider.kind === "balance");
			const providerWindows = resolvedProvider && resolvedProvider.windows && typeof resolvedProvider.windows === "object"
				? CANONICAL_WINDOWS.filter((key) => key in resolvedProvider.windows)
				: [];
			const windowKeys = providerWindows.length ? providerWindows : CANONICAL_WINDOWS;
			const activeKey = windowKeys.includes(windowKey) ? windowKey : windowKeys[0];
			const active = resolvedProvider && resolvedProvider.windows ? resolvedProvider.windows[activeKey] : null;

			const percent = isBalance ? null : toPercent(active);
			const status = resolvedProvider ? resolvedProvider.status : snapshot.status === "error" ? "error" : "loading";
			const colour =
				status === "error"
					? "var(--dsw-alias-state-error-primary)"
					: isBalance || status === "unconfigured"
						? "var(--dsw-alias-state-idle-primary)"
						: colourFor(percent, thresholds);
			const descriptor = isBalance
				? { zh: "余额", en: "Balance", short: currencyGlyph(resolvedProvider && resolvedProvider.balances && resolvedProvider.balances[0] && resolvedProvider.balances[0].currency) }
				: describe(activeKey);
			const urgent = !isBalance && percent !== null && percent >= thresholds[2];

			const resetsAt = active && active.resetsAt ? Date.parse(active.resetsAt) : NaN;
			const remaining = Number.isFinite(resetsAt) ? formatRemaining(resetsAt - Date.now()) : "—";

			const joiner = zh ? "：" : ": ";
			let notice = "";
			let hint = "";
			if (snapshot.status === "loading" && !resolvedProvider) {
				notice = zh ? "正在载入…" : "Loading…";
			} else if (status === "unconfigured") {
				notice = zh ? "尚未配置凭据" : "No credential configured";
				const env = (resolvedProvider && resolvedProvider.apiKeyEnv) || "";
				if (env) {
					hint = zh
						? `设置环境变量或凭据 <code>${esc(env)}</code> 后即可显示`
						: `Set the environment variable or credential <code>${esc(env)}</code> to enable it`;
				}
			} else if (status === "error") {
				notice = `${zh ? "额度不可用" : "Quota unavailable"}${joiner}${(resolvedProvider && resolvedProvider.errorMessage) || snapshot.error || ""}`;
			} else if (status === "stale") {
				notice = `${zh ? "数据可能过期" : "Stale data"}${joiner}${(resolvedProvider && resolvedProvider.errorMessage) || ""}`;
			}

			const bars = isBalance
				? ""
				: windowKeys
						.map((key) => {
							const value = toPercent(resolvedProvider && resolvedProvider.windows ? resolvedProvider.windows[key] : null);
							const meta = describe(key);
							return (
								`<div class="dsh-ogqr-bar${key === activeKey ? " is-active" : ""}" data-window="${esc(key)}" role="button" tabindex="0">` +
								`<span class="dsh-ogqr-bar-name">${esc(zh ? meta.zh : meta.en)}</span>` +
								`<span class="dsh-ogqr-bar-track"><i style="width:${value === null ? 0 : value}%;background:${colourFor(value, thresholds)}"></i></span>` +
								`<span class="dsh-ogqr-bar-pct">${value === null ? "—" : `${value}%`}</span>` +
								`</div>`
							);
						})
						.join("");

			const sourceRow = (provider) => {
				const value = provider.kind === "balance" ? balanceText(provider) : worstPercent(provider);
				const valueText =
					provider.status === "unconfigured"
						? provider.apiKeyEnv || (zh ? "未配置" : "not set")
						: provider.kind === "balance"
							? value || "—"
							: value === null
								? "—"
								: `${value}%`;
				const dotColour =
					provider.status === "error"
						? "var(--dsw-alias-state-error-primary)"
						: provider.status === "unconfigured" || provider.status === "disabled"
							? "var(--dsw-alias-state-idle-primary)"
							: provider.kind === "balance"
								? "var(--dsw-alias-brand-primary)"
								: colourFor(value, thresholds);
				return (
					`<div class="dsh-ogqr-src${provider.id === (resolvedProvider && resolvedProvider.id) ? " is-active" : ""}" ` +
					`data-provider="${esc(provider.id)}" data-status="${esc(provider.status || "ok")}" role="button" tabindex="0">` +
					`<span class="dsh-ogqr-src-dot" style="background:${dotColour}"></span>` +
					`<span class="dsh-ogqr-src-name">${esc(providerLabel(provider))}</span>` +
					`<span class="dsh-ogqr-src-val">${esc(valueText)}</span>` +
					`</div>`
				);
			};

			// Only sources that can actually answer are shown up front. A dozen
			// "set ZHIPU_API_KEY" rows is noise, not information.
			const unconfigured = providers.filter((provider) => provider.status === "unconfigured");
			const usable = providers.filter((provider) => provider.status !== "unconfigured");
			const listed = showUnconfigured || !usable.length ? providers : usable;
			const pickerRows = listed.map(sourceRow).join("");
			const pickerToggle = unconfigured.length
				? `<button type="button" class="dsh-ogqr-toggle" data-toggle-unconfigured="1">${esc(
						showUnconfigured
							? zh
								? `收起未配置的 ${unconfigured.length} 个来源`
								: `Hide ${unconfigured.length} unconfigured`
							: zh
								? `显示未配置的 ${unconfigured.length} 个来源`
								: `Show ${unconfigured.length} unconfigured`
					)}</button>`
				: "";

			const sourceEntry =
				`<div class="dsh-ogqr-entry" data-open-picker="1" role="button" tabindex="0">` +
				`<span class="dsh-ogqr-entry-name">${esc(zh ? "额度来源" : "Source")}</span>` +
				`<span class="dsh-ogqr-entry-val">${esc(
					resolvedProvider ? providerLabel(resolvedProvider) : zh ? "无可用来源" : "none"
				)}</span>` +
				`<span class="dsh-ogqr-chev">\u203a</span>` +
				`</div>`;

			const windowLabel = isBalance
				? zh ? "账户余额" : "Account balance"
				: zh
					? `${descriptor.zh}窗口`
					: `${descriptor.en} window`;

			const footText = providers.length
				? `${zh ? "更新于" : "Updated"} ${formatClock(data && data.fetchedAt)} · ${
						zh ? "点击切换窗口" : "click to switch window"
					}`
				: zh
					? "暂无可用来源"
					: "No sources available";

			const hoverCard = picker
				? buildPicker({
						title: zh ? "额度来源" : "Sources",
						backLabel: zh ? "返回" : "Back",
						rows: pickerRows,
						toggle: pickerToggle,
						foot: zh
							? "点击即可切换，圆环会记住你的选择"
							: "Pick one; the ring remembers it"
					})
				: buildCard({
						title: zh ? "Coding Plan 额度" : "Coding Plan Quota",
						plan: resolvedProvider && resolvedProvider.plan ? String(resolvedProvider.plan) : "",
						notice,
						hint,
						percent,
						colour,
						balance: isBalance ? balanceText(resolvedProvider) : null,
						balanceLabel: windowLabel,
						windowLabel,
						resetLabel: zh ? "重置倒计时" : "Resets in",
						remaining,
						bars,
						entry: sourceEntry,
						foot: footText
					});

			// Available to the card's delegated click listener.
			actions.current = {
				openPicker: () => setPicker(true),
				closePicker: () => setPicker(false),
				toggleUnconfigured: () => setShowUnconfigured((value) => !value),
				chooseWindow: (key) => {
					if (!windowKeys.includes(key)) return;
					setWindowKey(key);
					writeStored(WINDOW_STORAGE_KEY, key);
				},
				chooseProvider: (id) => {
					const provider = providers.find((item) => item.id === id);
					if (!provider) return;
					setProviderId(id);
					writeStored(PROVIDER_STORAGE_KEY, id);
					// Back to the numbers the user just chose.
					setPicker(false);
					// A source that has never answered is fetched right away rather
					// than waiting out the poll interval.
					if (provider.status === "unconfigured") return;
					if (!provider.windows && !provider.balances) load(`?provider=${encodeURIComponent(id)}&refresh=1`);
				}
			};

			// Runs after the card-lifecycle effect above, on every render.
			react.useEffect(() => {
				const tip = tipRef.current;
				const button = buttonRef.current;
				if (!tip || !button) return;
				const rect = button.getBoundingClientRect();
				const below = rect.top < 190;
				// The ring sits near the window's right edge, so the card is
				// clamped into the viewport instead of trusting the button centre.
				const half = (tip.offsetWidth || 240) / 2;
				const margin = half + 8;
				const centre = Math.min(
					Math.max(margin, window.innerWidth - margin),
					Math.max(margin, rect.left + rect.width / 2)
				);
				tip.style.left = `${Math.round(centre)}px`;
				tip.style.top = `${Math.round(below ? rect.bottom + 8 : rect.top - 8)}px`;
				tip.style.transform = below ? "translate(-50%, 0)" : "translate(-50%, -100%)";
				const computed = window.getComputedStyle(button);
				for (const token of TOKENS) {
					const value = computed.getPropertyValue(token);
					if (value && value.trim()) tip.style.setProperty(token, value.trim());
				}
				tip.innerHTML = hoverCard;
			});

			const cycle = () => {
				if (isBalance || windowKeys.length < 2) {
					load("?refresh=1");
					return;
				}
				const index = windowKeys.indexOf(activeKey);
				const next = windowKeys[(index + 1) % windowKeys.length];
				setWindowKey(next);
				writeStored(WINDOW_STORAGE_KEY, next);
			};

			const fraction = isBalance || percent === null ? 1 : percent / 100;
			const dash = fraction * RING_CIRCUMFERENCE;
			const ringColour = isBalance && percent === null ? "var(--dsw-alias-state-idle-primary)" : colour;
			const ariaLabel =
				`${resolvedProvider ? providerLabel(resolvedProvider) : ""} · ${zh ? descriptor.zh : descriptor.en} · ` +
				`${
					isBalance
						? balanceText(resolvedProvider) || "—"
						: `${percent === null ? "—" : `${percent}%`} · ${zh ? "点击切换窗口" : "click to switch window"}`
				}`;

			const ring = h(
				"svg",
				{
					className: "dsh-ogqr-svg",
					width: RING_SIZE,
					height: RING_SIZE,
					viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`,
					"aria-hidden": "true",
					focusable: "false"
				},
				h("circle", {
					className: "dsh-ogqr-track",
					cx: RING_SIZE / 2,
					cy: RING_SIZE / 2,
					r: RING_RADIUS,
					fill: "none",
					strokeWidth: RING_STROKE
				}),
				h("circle", {
					className: "dsh-ogqr-arc",
					cx: RING_SIZE / 2,
					cy: RING_SIZE / 2,
					r: RING_RADIUS,
					fill: "none",
					stroke: ringColour,
					strokeWidth: RING_STROKE,
					strokeLinecap: "round",
					strokeDasharray: `${dash} ${Math.max(0, RING_CIRCUMFERENCE - dash)}`,
					transform: `rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`,
					// An unknown percentage is shown as a dimmed partial arc so it
					// cannot be mistaken for a real 100%.
					opacity: isBalance || percent === null ? 0.45 : 1
				}),
				h(
					"text",
					{
						className: "dsh-ogqr-label",
						x: RING_SIZE / 2,
						y: RING_SIZE / 2,
						textAnchor: "middle",
						dominantBaseline: "central"
					},
					descriptor.short
				)
			);

			return h(
				"button",
				{
					ref: buttonRef,
					type: "button",
					className: "dsh-ogqr-btn",
					"data-plugin": PLUGIN_ID,
					"data-status": status,
					"data-urgent": urgent ? "1" : "0",
					"data-busy": snapshot.status === "loading" ? "1" : "0",
					"aria-label": ariaLabel,
					title: "",
					// Drives the label fill so the urgency colour is legible at 0% too.
					style: { "--dsh-ogqr-colour": ringColour },
					onMouseEnter: () => {
						cancelHide();
						setHovered(true);
					},
					onMouseLeave: scheduleHide,
					onFocus: () => {
						cancelHide();
						setHovered(true);
					},
					onBlur: scheduleHide,
					onClick: cycle
				},
				ring
			);
		}

		/**
		 * A ring that throws must never take the shipped composer row down with
		 * it, so the slot gets an error boundary rather than the raw component.
		 */
		class RingBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}

			static getDerivedStateFromError() {
				return { failed: true };
			}

			componentDidCatch(error) {
				console.warn(`[${PLUGIN_ID}] quota ring render failed:`, error);
			}

			render() {
				return this.state.failed ? null : this.props.children;
			}
		}

		function QuotaRingEntry() {
			return h(RingBoundary, null, h(QuotaRing));
		}

		/* --------------------------------------------------------------- plugin */

		/** @param {import('cordis').Context} ctx */
		function apply(ctx) {
			syncLocale(ctx);
			injectStyles();

			// `locale` is a declared hard dependency, so ctx.locale is present; the
			// guard only protects against a partially initialised face.
			let stopLocale = null;
			try {
				const face = ctx && ctx.locale;
				if (face && typeof face.subscribe === "function") stopLocale = face.subscribe(() => syncLocale(ctx));
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] locale subscription failed:`, error);
				stopLocale = null;
			}

			const dispose = ctx.slots.inject(SLOT_KEY, () => {
				try {
					return ctx.slots.register({ name: SLOT_KEY, id: PLUGIN_ID, order: 0 }, QuotaRingEntry);
				} catch (error) {
					console.warn(`[${PLUGIN_ID}] slot registration failed:`, error);
					return () => {};
				}
			});

			ctx.effect(() => dispose, `${PLUGIN_ID}: quota ring slot`);
			if (stopLocale) ctx.effect(() => stopLocale, `${PLUGIN_ID}: locale subscription`);
		}

		const inject = ["slots", "locale"];

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "coding-plan-quota";
		return module.exports;
	}
});
