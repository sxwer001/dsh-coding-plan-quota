/**
 * dsh-coding-plan-quota — node half.
 *
 * The browser half needs quota numbers but must never see an API key, so this
 * half resolves credentials, calls every configured coding-plan provider,
 * caches the results and re-serves them over one same-origin route:
 *
 *   GET /plugins/dsh-coding-plan-quota/usage.json
 *       → { ok, fetchedAt, defaultProvider, thresholds, windows, providers: [ … ] }
 *   GET …/usage.json?refresh=1            bypass the cache for every provider
 *   GET …/usage.json?provider=<id>        only that provider
 *   GET …/usage.json?provider=<id>&refresh=1
 *   GET …/usage.json?debug=1              include the truncated upstream body
 *   non-GET/HEAD → 405 ; cross-site caller → 403
 *
 * PROVIDER MODEL
 * Every provider normalises into one shape, so the client never needs to know
 * which vendor it is looking at:
 *
 *   { id, label:{zh,en}, kind:"windows"|"balance", status, plan,
 *     windows: { session:{percent,resetsAt,status}, weekly:{…}, monthly:{…} },
 *     balances:[ { currency, amount, display } ],
 *     keySource, apiKeyEnv, error, errorMessage, stale, fetchedAt }
 *
 * `session` is the 5-hour class of window, `weekly` the 7-day one, `monthly`
 * the 30-day one — whatever the vendor happens to call them.
 *
 * A failed upstream call still returns the last good numbers alongside
 * `status:"stale"`, so the ring keeps showing the last known percentages
 * instead of going blank on a transient error.
 *
 * No hard service dependency: a host without `webServer` (headless/testkit
 * profiles) still activates, it just never registers the route.
 */
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

/** Cordis plugin name. */
const name = "coding-plan-quota";
/** Deliberately empty so activation never blocks on a missing service. */
const inject = [];

const ROUTE_PATH = "/plugins/dsh-coding-plan-quota/usage.json";
const USER_AGENT = "dsh-coding-plan-quota/0.2 (+https://github.com/deepseek-ai/dsh)";

/** The canonical window ids, in display order. */
const WINDOW_ORDER = ["session", "weekly", "monthly"];

const DEFAULTS = {
	cacheMs: 60_000,
	timeoutMs: 12_000,
	thresholds: [50, 75, 90],
	defaultProvider: "opencode-go",
	/** Keep unconfigured providers in the payload so the card can teach the env var. */
	hideUnconfigured: false,
	insecureTls: false,
	providers: {}
};

/* ══════════════════════════════════════════════════════════════ value helpers */

function pickNumber(...values) {
	for (const value of values) {
		if (value === null || value === undefined || value === "") continue;
		const num = Number(value);
		if (Number.isFinite(num)) return num;
	}
	return null;
}

function clampPercent(value) {
	if (!Number.isFinite(value)) return null;
	return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

/**
 * Accepts a 0–100 percentage or a 0–1 fraction and returns a 0–100 integer.
 * Only use this for fields documented as fractions (utilization,
 * remainingFraction) because a literal `1` is ambiguous.
 */
function asPercent(value) {
	if (!Number.isFinite(value)) return null;
	return clampPercent(value > 0 && value <= 1 ? value * 100 : value);
}

/** Accepts ISO strings, epoch seconds/millis and "YYYY-MM-DD HH:mm:ss". */
function toIso(value) {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value).trim())) {
		const num = Number(value);
		if (!Number.isFinite(num) || num <= 0) return null;
		const date = new Date(num < 1e12 ? num * 1000 : num);
		return Number.isFinite(date.getTime()) ? date.toISOString() : null;
	}
	const text = String(value).trim();
	const parsed = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function formatMoney(amount, currency) {
	if (!Number.isFinite(amount)) return null;
	const code = String(currency || "").toUpperCase();
	const symbol =
		code === "CNY" || code === "RMB" ? "¥" : code === "USD" ? "$" : code === "EUR" ? "€" : code ? `${code} ` : "";
	// Balances are money, so two decimals; but never hide a real fraction.
	const rounded = Math.round(amount * 100) / 100;
	return `${symbol}${Math.abs(rounded) < 1e-9 ? "0.00" : rounded.toFixed(2)}`;
}

/** Resolve a dotted path (`tokens.access_token`) inside a parsed JSON document. */
function lookupPath(root, dotted) {
	let node = root;
	for (const segment of String(dotted).split(".")) {
		if (!node || typeof node !== "object") return undefined;
		node = node[segment];
	}
	return node;
}

/* ══════════════════════════════════════════════════════════ upstream failures */

/** A provider-level failure reported inside an otherwise HTTP-200 body. */
class UpstreamError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/* ═══════════════════════════════════════════════════════════════════ HTTP */

/**
 * A minimal JSON-over-HTTP client built on node:https rather than fetch, so a
 * provider can opt out of certificate verification — a local TLS-intercepting
 * proxy makes `api.github.com` fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE and
 * plain `fetch` offers no way around that.
 */
function httpJson(options) {
	const {
		url,
		method = "GET",
		headers = {},
		body = null,
		timeoutMs = 12_000,
		insecureTls = false
	} = options;

	return new Promise((resolve) => {
		let parsed = null;
		try {
			parsed = new URL(url);
		} catch (error) {
			resolve({ ok: false, error: "bad-url", message: `无法解析地址 ${url}` });
			return;
		}

		const transport = parsed.protocol === "http:" ? httpRequest : httpsRequest;
		const payload =
			body === null || body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);

		const requestHeaders = { accept: "application/json, text/plain, */*", "user-agent": USER_AGENT, ...headers };
		if (payload !== null) {
			if (!requestHeaders["content-type"]) requestHeaders["content-type"] = "application/json";
			requestHeaders["content-length"] = Buffer.byteLength(payload);
		}

		const requestOptions = {
			method,
			hostname: parsed.hostname,
			port: parsed.port || undefined,
			path: `${parsed.pathname}${parsed.search}`,
			headers: requestHeaders,
			timeout: timeoutMs
		};
		if (insecureTls) requestOptions.rejectUnauthorized = false;

		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		let request = null;
		try {
			request = transport(requestOptions, (response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					const status = response.statusCode || 0;
					finish({ ok: status >= 200 && status < 300, status, text });
				});
				response.on("error", (error) => finish({ ok: false, error: "network", message: String(error?.message || error) }));
			});
		} catch (error) {
			finish({ ok: false, error: "network", message: String(error?.message || error) });
			return;
		}

		request.on("timeout", () => request.destroy(new Error(`请求超时（${timeoutMs} ms）`)));
		request.on("error", (error) => finish({ ok: false, error: "network", message: String(error?.message || error) }));
		if (payload !== null) request.write(payload);
		request.end();
	});
}

/* ═══════════════════════════════════════════════════════════════ credentials */

function dshHomeDirectory() {
	const configured = process.env.DSH_HOME;
	if (typeof configured === "string" && configured.trim()) return configured.trim();
	return join(homedir(), ".dsh");
}

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull one scalar out of a small YAML document without depending on a parser.
 * Handles double quotes, single quotes and trailing `# comment`.
 */
function extractYamlScalar(text, key) {
	const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, "m");
	const match = pattern.exec(text);
	if (!match) return null;
	let value = match[1];
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		value = value.slice(1, -1).replace(/\\"/g, '"');
	} else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
		value = value.slice(1, -1).replace(/''/g, "'");
	} else {
		const comment = value.indexOf(" #");
		if (comment >= 0) value = value.slice(0, comment);
	}
	value = value.trim();
	return value || null;
}

/** `$DSH_HOME/.credentials.yaml` holds the managed `refs:` map as flat scalars. */
async function readCredentialFile(envName) {
	const path = join(dshHomeDirectory(), ".credentials.yaml");
	try {
		const text = await readFile(path, "utf8");
		const value = extractYamlScalar(text, envName);
		if (value) return { value, source: `credentials-file:${path}` };
	} catch (error) {
		/* missing/unreadable file is not an error here */
	}
	return null;
}

function expandHome(path) {
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * Resolution order: plugin config literal → environment → `credentials`
 * service → managed store file → the vendor CLI's own auth file. Re-run on
 * every upstream call so a rotated credential takes effect without a restart.
 */
async function resolveSecret(ctx, spec, overrides = {}) {
	if (typeof overrides.apiKey === "string" && overrides.apiKey.trim()) {
		return { value: overrides.apiKey.trim(), source: "plugin-config" };
	}

	const envName =
		(typeof overrides.apiKeyEnv === "string" && overrides.apiKeyEnv.trim()) ||
		(spec && typeof spec.env === "string" ? spec.env : "");

	if (envName) {
		const fromEnv = process.env[envName];
		if (typeof fromEnv === "string" && fromEnv.trim()) {
			return { value: fromEnv.trim(), source: `env:${envName}` };
		}

		let credentials = null;
		try {
			credentials = typeof ctx.get === "function" ? ctx.get("credentials") : null;
		} catch (error) {
			/* ignore */
		}
		if (!credentials) {
			try {
				credentials = ctx.credentials || null;
			} catch (error) {
				/* ignore */
			}
		}
		if (credentials && typeof credentials.resolve === "function") {
			// A CredentialRef is a branded string, i.e. a plain string at runtime.
			for (const ref of [envName, { name: envName }, { key: envName }, { env: envName }]) {
				try {
					const resolved = await credentials.resolve(ref);
					const value = typeof resolved === "string" ? resolved : resolved && resolved.value;
					if (typeof value === "string" && value.trim()) {
						const source = resolved && typeof resolved.source === "string" ? resolved.source : "credentials";
						return { value: value.trim(), source };
					}
				} catch (error) {
					/* try the next ref shape */
				}
			}
		}

		const fromFile = await readCredentialFile(envName);
		if (fromFile) return fromFile;
	}

	for (const file of (spec && spec.files) || []) {
		const path = expandHome(file.path);
		let doc = null;
		try {
			doc = JSON.parse(await readFile(path, "utf8"));
		} catch (error) {
			continue;
		}
		for (const dotted of file.pick || []) {
			const value = lookupPath(doc, dotted);
			if (typeof value === "string" && value.trim()) {
				return { value: value.trim(), source: `${path}#${dotted}` };
			}
		}
	}

	return null;
}

/* ═══════════════════════════════════════════════════════════ generic scanner */

const PERCENT_KEYS = new Set(
	[
		"percent",
		"percentage",
		"usedpercent",
		"used_percent",
		"usage_percentage",
		"usagepercent",
		"utilization",
		"used_rate",
		"usedrate",
		"remaining_percent",
		"remainingpercent",
		"percent_remaining",
		"current_interval_remaining_percent",
		"current_weekly_remaining_percent",
		"remaining_fraction",
		"remainingfraction"
	].map((key) => key.toLowerCase())
);

const RESET_KEYS = new Set(
	[
		"resetsat",
		"resets_at",
		"resetat",
		"reset_at",
		"resettime",
		"reset_time",
		"end_time",
		"endtime",
		"expires_at",
		"expiresat",
		"nextresettime",
		"next_reset_time",
		"weekly_end_time",
		"weeklyendtime"
	].map((key) => key.toLowerCase())
);

const INVERT_PATTERN = /remaining|remain|left|avail|fraction/;

/** Some plans publish a used/limit pair instead of a ready-made percentage. */
const LIMIT_KEYS = new Set(["limit", "max", "quota", "total", "max_value_usd", "maxvalueusd", "quota_limit"].map((key) => key.toLowerCase()));
const USED_KEYS = new Set(["used", "usage", "used_value", "used_value_usd", "usedvalueusd", "used_quota", "consumed"].map((key) => key.toLowerCase()));

/** Sibling string fields whose value often names the window ("5h", "weekly"). */
const HINT_VALUE_KEYS = ["window", "period", "interval", "model_name", "model", "name", "type", "label"];

function windowKeyFromHint(hint) {
	if (/weekly|week|7.?d(ay)?|seven|secondary/.test(hint)) return "weekly";
	if (/month|30.?d(ay)?/.test(hint)) return "monthly";
	if (/5.?h|5.?hour|hour|session|interval|primary|rolling/.test(hint)) return "session";
	return null;
}

/**
 * Last-resort parser for vendors whose exact schema is not pinned down.
 * It only accepts an object that carries BOTH a percentage-like field and a
 * reset-time-like field, and inverts the value when the field name says
 * "remaining" — a deliberately conservative rule, because a wrong percentage
 * on the ring is worse than no percentage at all.
 */
function scanGenericWindows(json) {
	const found = [];
	const visit = (node, path, depth) => {
		if (!node || typeof node !== "object" || depth > 6) return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item, path, depth + 1);
			return;
		}
		let percent = null;
		let percentKey = null;
		let reset = null;
		let limit = null;
		let used = null;
		let named = "";
		for (const key of Object.keys(node)) {
			const lower = key.toLowerCase();
			if (percent === null && PERCENT_KEYS.has(lower)) {
				const raw = pickNumber(node[key]);
				if (raw !== null) {
					percent = asPercent(raw);
					percentKey = key;
				}
			}
			if (reset === null && RESET_KEYS.has(lower)) reset = toIso(node[key]);
			if (limit === null && LIMIT_KEYS.has(lower)) limit = pickNumber(node[key]);
			if (used === null && USED_KEYS.has(lower)) used = pickNumber(node[key]);
		}
		if (!named) {
			for (const key of HINT_VALUE_KEYS) {
				const value = node[key];
				if (typeof value === "string" && value) {
					named = value;
					break;
				}
			}
		}
		// No percentage field, but a used/limit pair: derive it. Both halves are
		// required, which keeps this from firing on unrelated counters.
		let derived = false;
		if (percent === null && limit !== null && used !== null && limit > 0) {
			percent = clampPercent((used / limit) * 100);
			percentKey = "used";
			derived = true;
		}
		// A bare number is not evidence. Keep an entry only when something else
		// corroborates it: a reset instant, a window name, or a used/limit pair.
		// This is what stops the fallback from painting the ring off an unrelated
		// counter it happened to find in the payload.
		if (percent !== null && (reset !== null || named || derived)) {
			const invert = INVERT_PATTERN.test(String(percentKey).toLowerCase());
			const value = invert ? 100 - percent : percent;
			found.push({
				percent: clampPercent(value),
				resetsAt: reset,
				hint: `${path.join(".")}.${percentKey} ${named}`.toLowerCase()
			});
		}
		for (const key of Object.keys(node)) visit(node[key], path.concat(key), depth + 1);
	};
	visit(json, [], 0);

	// De-duplicate identical percentages produced by nested wrappers.
	const unique = [];
	for (const entry of found) {
		if (entry.percent === null) continue;
		if (unique.some((other) => other.percent === entry.percent && other.resetsAt === entry.resetsAt)) continue;
		unique.push(entry);
	}

	// Named windows win outright. Entries whose field names carry no window hint
	// are only fallbacks, and they are only used when NOTHING was named — an
	// invented or duplicated window paints the ring off a number the plan never
	// reported, which is far worse than leaving a window blank.
	const windows = {};
	const unnamed = [];
	for (const entry of unique) {
		const key = windowKeyFromHint(entry.hint);
		if (key && !windows[key]) windows[key] = { percent: entry.percent, resetsAt: entry.resetsAt, status: "ok" };
		else if (!key) unnamed.push(entry);
	}
	if (!Object.keys(windows).length) {
		for (const entry of unnamed) {
			const key = WINDOW_ORDER.find((candidate) => !windows[candidate]);
			if (!key) break;
			windows[key] = { percent: entry.percent, resetsAt: entry.resetsAt, status: "ok" };
		}
	}
	return windows;
}

function genericWindows(json, providerLabel) {
	const windows = scanGenericWindows(json);
	if (!Object.keys(windows).length) {
		throw new UpstreamError("unrecognised-payload", `${providerLabel} 的响应里找不到任何可识别的额度字段`);
	}
	return { windows };
}

/* ════════════════════════════════════════════════════════════════ parsers */

function parseOpencodeGo(json) {
	const raw =
		json && typeof json === "object" && json.usage && typeof json.usage === "object" ? json.usage : json;
	const map = { rolling: "session", weekly: "weekly", monthly: "monthly" };
	const windows = {};
	for (const [source, target] of Object.entries(map)) {
		const entry = raw && raw[source];
		if (!entry || typeof entry !== "object") continue;
		const percent = clampPercent(pickNumber(entry.percent, entry.percentage, entry.usedPercent));
		if (percent === null) continue;
		windows[target] = {
			percent,
			resetsAt: toIso(entry.resetsAt ?? entry.resets_at),
			status: typeof entry.status === "string" ? entry.status : "ok"
		};
	}
	if (!Object.keys(windows).length) return genericWindows(json, "OpenCode");
	return { windows };
}

/**
 * Zhipu GLM (z.ai / bigmodel) reports what is LEFT, so the used share is
 * `100 - remaining`. It also answers HTTP 200 with `success:false` when the
 * token is bad, so the body must be inspected, not just the status code.
 */
function parseGlm(json) {
	if (json && json.success === false) {
		throw new UpstreamError(`glm-${json.code ?? "error"}`, String(json.msg || "智谱接口返回失败"));
	}
	const data = json && json.data && typeof json.data === "object" ? json.data : json;
	const list =
		data && Array.isArray(data.model_remains) ? data.model_remains.filter((item) => item && typeof item === "object") : [];
	if (!list.length) return genericWindows(json, "智谱 GLM");

	const windows = {};
	let session = null;
	let weekly = null;
	for (const item of list) {
		const sessionRemaining = pickNumber(
			item.current_interval_remaining_percent,
			item.currentIntervalRemainingPercent
		);
		if (sessionRemaining !== null) {
			const used = clampPercent(100 - sessionRemaining);
			if (used !== null && (!session || used > session.percent)) {
				session = { percent: used, resetsAt: toIso(item.end_time ?? item.endTime), status: "ok" };
			}
		}
		const weeklyRemaining = pickNumber(
			item.current_weekly_remaining_percent,
			item.currentWeeklyRemainingPercent
		);
		if (weeklyRemaining !== null) {
			const used = clampPercent(100 - weeklyRemaining);
			if (used !== null && (!weekly || used > weekly.percent)) {
				weekly = { percent: used, resetsAt: toIso(item.weekly_end_time ?? item.weeklyEndTime), status: "ok" };
			}
		}
	}
	if (session) windows.session = session;
	if (weekly) windows.weekly = weekly;
	if (!Object.keys(windows).length) return genericWindows(json, "智谱 GLM");
	return { windows };
}

/** Anthropic's subscription usage endpoint: `five_hour` / `seven_day`. */
function parseClaudeOauth(json) {
	const map = { five_hour: "session", fiveHour: "session", seven_day: "weekly", sevenDay: "weekly" };
	const windows = {};
	for (const [source, target] of Object.entries(map)) {
		const entry = json && json[source];
		if (!entry || typeof entry !== "object" || windows[target]) continue;
		const percent = asPercent(pickNumber(entry.utilization, entry.used_percent, entry.percent, entry.usedPercent));
		if (percent === null) continue;
		windows[target] = {
			percent,
			resetsAt: toIso(entry.resets_at ?? entry.resetsAt),
			status: "ok"
		};
	}
	if (!Object.keys(windows).length) return genericWindows(json, "Claude");
	return { windows };
}

/** ChatGPT/Codex reports `primary_window` and `secondary_window`. */
function parseCodex(json) {
	const rate = (json && (json.rate_limit || json.rateLimit)) || json || {};
	const entries = [];
	for (const key of ["primary_window", "primaryWindow", "secondary_window", "secondaryWindow"]) {
		const entry = rate[key];
		if (entry && typeof entry === "object") entries.push(entry);
	}
	const collected = [];
	for (const entry of entries) {
		const percent = asPercent(pickNumber(entry.used_percent, entry.usedPercent, entry.utilization));
		if (percent === null) continue;
		const seconds = pickNumber(entry.limit_window_seconds, entry.limitWindowSeconds);
		const minutes = pickNumber(entry.window_minutes, entry.windowMinutes) ?? (seconds === null ? null : seconds / 60);
		collected.push({
			percent,
			resetsAt: toIso(entry.reset_at ?? entry.resets_at ?? entry.resetsAt ?? entry.expiresAt),
			minutes
		});
	}
	if (!collected.length) return genericWindows(json, "Codex");

	const windows = {};
	const undecided = [];
	for (const item of collected) {
		if (item.minutes === null) {
			undecided.push(item);
			continue;
		}
		const key = item.minutes <= 360 ? "session" : item.minutes <= 20_160 ? "weekly" : "monthly";
		if (!windows[key]) windows[key] = { percent: item.percent, resetsAt: item.resetsAt, status: "ok" };
	}
	// Same rule as the generic scanner: a window is only guessed when the
	// payload named none at all, so a duplicate can never be invented.
	if (!Object.keys(windows).length) {
		for (const item of undecided) {
			const key = WINDOW_ORDER.find((candidate) => !windows[candidate]);
			if (!key) break;
			windows[key] = { percent: item.percent, resetsAt: item.resetsAt, status: "ok" };
		}
	}
	const plan = json && (json.plan_type || json.planType);
	return { windows, plan: typeof plan === "string" && plan ? plan : null };
}

/** Gemini Code Assist: a list of buckets carrying `remainingFraction`. */
function parseGeminiQuota(json) {
	const buckets = json && Array.isArray(json.buckets) ? json.buckets : [];
	let worst = null;
	for (const bucket of buckets) {
		if (!bucket || typeof bucket !== "object") continue;
		const fraction = pickNumber(bucket.remainingFraction, bucket.remaining_fraction);
		if (fraction === null) continue;
		const used = clampPercent((1 - fraction) * 100);
		if (used === null) continue;
		if (!worst || used > worst.percent) worst = { percent: used, resetsAt: toIso(bucket.resetTime ?? bucket.reset_time), status: "ok" };
	}
	if (!worst) return genericWindows(json, "Gemini");
	return { windows: { session: worst } };
}

/** GitHub Copilot's `copilot_internal/user` reports what is left. */
function parseCopilot(json) {
	const snapshots = json && (json.quota_snapshots || json.quotaSnapshots);
	let worst = null;
	if (snapshots && typeof snapshots === "object") {
		for (const entry of Object.values(snapshots)) {
			if (!entry || typeof entry !== "object") continue;
			const remaining = pickNumber(entry.percent_remaining, entry.percentRemaining);
			const used =
				remaining !== null
					? clampPercent(100 - remaining)
					: asPercent(pickNumber(entry.used_percent, entry.usedPercent));
			if (used === null) continue;
			if (!worst || used > worst.percent) worst = { percent: used, resetsAt: toIso(entry.quota_reset_date_utc ?? entry.quota_reset_date), status: "ok" };
		}
	}
	if (!worst) return genericWindows(json, "GitHub Copilot");
	const plan = json && (json.copilot_plan || json.copilotPlan);
	return { windows: { monthly: worst }, plan: typeof plan === "string" && plan ? plan : null };
}

/* ───────────────────────────────────────────────────────── balance parsers */

function makeBalances(list) {
	const balances = [];
	for (const item of list) {
		if (!item) continue;
		const amount = pickNumber(item.amount);
		if (amount === null) continue;
		const currency = String(item.currency || "USD").toUpperCase();
		balances.push({ currency, amount, display: formatMoney(amount, currency) });
	}
	return balances;
}

function parseDeepseekBalance(json) {
	const infos = json && Array.isArray(json.balance_infos) ? json.balance_infos : [];
	const balances = makeBalances(
		infos.map((info) => ({
			amount: info && info.total_balance,
			currency: (info && info.currency) || "CNY"
		}))
	);
	if (!balances.length) throw new UpstreamError("deepseek-empty", "DeepSeek 响应里没有 balance_infos");
	return { balances, plan: json && json.is_available === false ? "unavailable" : null };
}

function parseOpenrouterBalance(json) {
	const data = (json && json.data) || json || {};
	const total = pickNumber(data.total_credits, data.totalCredits);
	const used = pickNumber(data.total_usage, data.totalUsage) ?? 0;
	if (total === null) throw new UpstreamError("openrouter-empty", "OpenRouter 响应里没有 total_credits");
	const balances = makeBalances([{ amount: total - used, currency: "USD" }]);
	return { balances };
}

function parseSiliconflowBalance(json) {
	const data = (json && json.data) || json || {};
	const amount = pickNumber(data.totalBalance, data.total_balance, data.balance);
	if (amount === null) throw new UpstreamError("siliconflow-empty", "硅基流动响应里没有 totalBalance");
	return { balances: makeBalances([{ amount, currency: "CNY" }]) };
}

function parseStepfunBalance(json) {
	const data = (json && json.data) || json || {};
	const usd = pickNumber(data.availableBalanceUSD, data.available_balance_usd);
	if (usd !== null) return { balances: makeBalances([{ amount: usd, currency: "USD" }]) };
	const amount = pickNumber(data.availableBalance, data.available_balance, data.balance);
	if (amount === null) throw new UpstreamError("stepfun-empty", "阶跃星辰响应里没有可用余额字段");
	return { balances: makeBalances([{ amount, currency: "CNY" }]) };
}

function parseNovitaBalance(json) {
	const amount = pickNumber(json && json.availableBalance, json && json.available_balance, json && json.balance);
	if (amount === null) throw new UpstreamError("novita-empty", "Novita 响应里没有 availableBalance");
	return { balances: makeBalances([{ amount, currency: "USD" }]) };
}

function parseMoonshotBalance(json) {
	const data = (json && json.data) || json || {};
	const amount = pickNumber(
		data.available_balance,
		data.availableBalance,
		data.cash_balance,
		data.cashBalance,
		data.balance
	);
	if (amount === null) throw new UpstreamError("moonshot-empty", "Moonshot 响应里没有可用余额字段");
	return { balances: makeBalances([{ amount, currency: "CNY" }]) };
}

/* ═════════════════════════════════════════════════════════════════ registry */

const OPENCODE_AUTH_FILE = { path: "~/.local/share/opencode/auth.json", pick: ["opencode-go", "opencode"] };

/**
 * Every supported coding plan. `endpoint` is a default the profile patch can
 * override per provider, and `region` marks a vendor that needs a mainland
 * endpoint instead of the global one.
 */
const PROVIDERS = [
	{
		id: "opencode-go",
		label: { zh: "OpenCode Go", en: "OpenCode Go" },
		kind: "windows",
		endpoint: "https://opencode.ai/zen/go/v1/usage",
		secret: { env: "OPENCODE_GO_API_KEY", files: [OPENCODE_AUTH_FILE] },
		auth: "bearer",
		parse: parseOpencodeGo
	},
	{
		id: "glm",
		label: { zh: "智谱 GLM Coding Plan", en: "Zhipu GLM Coding Plan" },
		kind: "windows",
		endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
		cnEndpoint: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
		secret: { env: "ZHIPU_API_KEY" },
		auth: "bearer",
		extraHeaders: { "accept-language": "en-US,en" },
		parse: parseGlm
	},
	{
		id: "kimi",
		label: { zh: "Kimi Coding Plan", en: "Kimi Coding Plan" },
		kind: "windows",
		endpoint: "https://api.kimi.com/coding/v1/usages",
		secret: { env: "KIMI_API_KEY" },
		auth: "bearer",
		parse: (json) => genericWindows(json, "Kimi")
	},
	{
		id: "minimax",
		label: { zh: "MiniMax Coding Plan", en: "MiniMax Coding Plan" },
		kind: "windows",
		endpoint: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
		cnEndpoint: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
		// MiniMax answers "cookie is missing, log in again" to a bearer token,
		// so this one wants a browser session cookie, not an API key.
		secret: { env: "MINIMAX_COOKIE" },
		auth: "cookie",
		parse: (json) => {
			const status = json && json.base_resp && pickNumber(json.base_resp.status_code);
			if (status !== null && status !== 0) {
				throw new UpstreamError(`minimax-${status}`, String((json.base_resp && json.base_resp.status_msg) || "MiniMax 接口返回失败"));
			}
			return genericWindows(json, "MiniMax");
		}
	},
	{
		id: "ark",
		label: { zh: "火山方舟 Coding Plan", en: "Volcengine Ark Coding Plan" },
		kind: "windows",
		// No Volcengine quota URL could be confirmed anywhere, so this provider
		// ships without a default endpoint and stays unconfigured until one is
		// supplied in the profile patch.
		endpoint: "",
		secret: { env: "ARK_API_KEY" },
		auth: "bearer",
		parse: (json) => genericWindows(json, "火山方舟")
	},
	{
		id: "claude",
		label: { zh: "Claude 订阅", en: "Claude subscription" },
		kind: "windows",
		endpoint: "https://api.anthropic.com/api/oauth/usage",
		secret: {
			env: "CLAUDE_CODE_OAUTH_TOKEN",
			files: [{ path: "~/.claude/.credentials.json", pick: ["claudeAiOauth.accessToken", "accessToken"] }]
		},
		auth: "bearer",
		extraHeaders: { "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" },
		parse: parseClaudeOauth
	},
	{
		id: "codex",
		label: { zh: "Codex / ChatGPT 订阅", en: "Codex / ChatGPT subscription" },
		kind: "windows",
		endpoint: "https://chatgpt.com/backend-api/wham/usage",
		secret: {
			env: "CHATGPT_ACCESS_TOKEN",
			files: [{ path: "~/.codex/auth.json", pick: ["tokens.access_token", "access_token"] }]
		},
		auth: "bearer",
		extraHeaders: { originator: "codex-cli", "user-agent": "codex-cli" },
		// The account id rides along as its own credential, matching how the
		// Codex CLI stores it next to the access token.
		extraSecret: {
			env: "CHATGPT_ACCOUNT_ID",
			files: [{ path: "~/.codex/auth.json", pick: ["tokens.account_id", "account_id"] }],
			header: "chatgpt-account-id"
		},
		parse: parseCodex
	},
	{
		id: "gemini",
		label: { zh: "Gemini CLI", en: "Gemini CLI" },
		kind: "windows",
		endpoint: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
		secret: {
			env: "GEMINI_ACCESS_TOKEN",
			files: [{ path: "~/.gemini/oauth_creds.json", pick: ["access_token"] }]
		},
		auth: "bearer",
		extraHeaders: { "content-type": "application/json" },
		parse: parseGeminiQuota
	},
	{
		id: "copilot",
		label: { zh: "GitHub Copilot", en: "GitHub Copilot" },
		kind: "windows",
		endpoint: "https://api.github.com/copilot_internal/user",
		secret: {
			env: "COPILOT_API_TOKEN",
			files: [{ path: "~/.config/github-copilot/hosts.json", pick: ["github.com.oauth_token"] }]
		},
		auth: "bearer",
		extraHeaders: { "editor-version": "vscode/1.95.0", "editor-plugin-version": "copilot-chat/0.22.0" },
		parse: parseCopilot
	},
	{
		id: "deepseek",
		label: { zh: "DeepSeek 余额", en: "DeepSeek balance" },
		kind: "balance",
		endpoint: "https://api.deepseek.com/user/balance",
		secret: { env: "DEEPSEEK_API_KEY" },
		auth: "bearer",
		parse: parseDeepseekBalance
	},
	{
		id: "moonshot",
		label: { zh: "Moonshot 余额", en: "Moonshot balance" },
		kind: "balance",
		endpoint: "https://api.moonshot.cn/v1/users/me/balance",
		secret: { env: "MOONSHOT_API_KEY" },
		auth: "bearer",
		parse: parseMoonshotBalance
	},
	{
		id: "openrouter",
		label: { zh: "OpenRouter 余额", en: "OpenRouter balance" },
		kind: "balance",
		endpoint: "https://openrouter.ai/api/v1/credits",
		secret: { env: "OPENROUTER_API_KEY" },
		auth: "bearer",
		parse: parseOpenrouterBalance
	},
	{
		id: "siliconflow",
		label: { zh: "硅基流动余额", en: "SiliconFlow balance" },
		kind: "balance",
		endpoint: "https://api.siliconflow.cn/v1/user/info",
		secret: { env: "SILICONFLOW_API_KEY" },
		auth: "bearer",
		parse: parseSiliconflowBalance
	},
	{
		id: "stepfun",
		label: { zh: "阶跃星辰余额", en: "StepFun balance" },
		kind: "balance",
		endpoint: "https://api.stepfun.com/v1/accounts",
		secret: { env: "STEPFUN_API_KEY" },
		auth: "bearer",
		parse: parseStepfunBalance
	},
	{
		id: "novita",
		label: { zh: "Novita 余额", en: "Novita balance" },
		kind: "balance",
		endpoint: "https://api.novita.ai/v3/user/balance",
		secret: { env: "NOVITA_API_KEY" },
		auth: "bearer",
		parse: parseNovitaBalance
	}
];

const PROVIDERS_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

/** Run one provider's parser directly — the hook the test script drives. */
function parsePayload(id, json) {
	const provider = PROVIDERS_BY_ID.get(id);
	if (!provider) throw new Error(`unknown provider: ${id}`);
	return provider.parse(json) || {};
}

/** Apply per-provider overrides on top of the plugin-wide settings. */
function providerConfig(settings, id) {
	const override = (settings.providers && settings.providers[id]) || {};
	const provider = PROVIDERS_BY_ID.get(id);
	const regionEndpoint = override.region === "cn" && provider && provider.cnEndpoint;
	return {
		enabled: override.enabled !== false,
		endpoint:
			(typeof override.endpoint === "string" && override.endpoint.trim()) ||
			regionEndpoint ||
			(provider && provider.endpoint) ||
			"",
		apiKey: override.apiKey,
		apiKeyEnv: override.apiKeyEnv,
		region: override.region,
		insecureTls: override.insecureTls === undefined ? settings.insecureTls : override.insecureTls === true
	};
}

/* ═══════════════════════════════════════════════════════════════ fetching */

function authHeaders(provider, secret) {
	const value = secret.value;
	if (provider.auth === "cookie") return { cookie: value };
	if (provider.auth === "x-api-key") return { "x-api-key": value };
	return { authorization: `Bearer ${value}` };
}

/** One provider, end to end: credential → request → parse → normalised snapshot. */
async function fetchProvider(ctx, provider, settings) {
	const config = providerConfig(settings, provider.id);
	const base = {
		id: provider.id,
		label: provider.label,
		kind: provider.kind,
		apiKeyEnv: (provider.secret && provider.secret.env) || null
	};

	if (!config.enabled) return { ...base, status: "disabled" };
	if (!config.endpoint) {
		return {
			...base,
			status: "unconfigured",
			error: "no-endpoint",
			errorMessage: "此来源没有默认接口地址，请在 profile patch 里填 endpoint"
		};
	}

	// A provider with a literal key in the config still needs no env var.
	const overrides = { apiKeyEnv: config.apiKeyEnv, apiKey: config.apiKey };
	const secret = await resolveSecret(ctx, provider.secret, overrides);
	if (!secret) return { ...base, status: "unconfigured" };

	const headers = { ...(provider.extraHeaders || {}), ...authHeaders(provider, secret) };
	if (provider.extraSecret) {
		// Deliberately no overrides: the extra credential is a different env var
		// and must never inherit the primary key's literal or env-name override.
		const extra = await resolveSecret(ctx, provider.extraSecret, {});
		if (!extra) {
			return {
				...base,
				status: "unconfigured",
				apiKeyEnv: provider.extraSecret.env,
				error: "missing-extra",
				errorMessage: `${provider.label.en} 还需要 ${provider.extraSecret.env}`
			};
		}
		headers[provider.extraSecret.header] = extra.value;
	}

	const request =
		typeof provider.buildRequest === "function"
			? await provider.buildRequest({ config, secret, headers })
			: { url: config.endpoint, method: "GET", headers };

	const response = await httpJson({
		url: request.url,
		method: request.method || "GET",
		headers: request.headers || headers,
		body: request.body ?? null,
		timeoutMs: settings.timeoutMs,
		insecureTls: config.insecureTls
	});

	const keySource = secret.source;
	if (response.error) {
		return { ...base, status: "error", error: response.error, errorMessage: response.message, keySource };
	}
	if (!response.ok) {
		const body = String(response.text || "").replace(/\s+/g, " ").slice(0, 200);
		return {
			...base,
			status: "error",
			error: `http-${response.status}`,
			errorMessage: `${provider.label.en} 返回 HTTP ${response.status}${body ? `：${body}` : ""}`,
			keySource
		};
	}

	let json = null;
	try {
		json = JSON.parse(response.text);
	} catch (error) {
		return { ...base, status: "error", error: "bad-json", errorMessage: "上游返回的不是 JSON", keySource };
	}

	try {
		const parsed = provider.parse(json) || {};
		const windows = parsed.windows || null;
		const balances = Array.isArray(parsed.balances) ? parsed.balances : null;
		if ((!windows || !Object.keys(windows).length) && (!balances || !balances.length)) {
			return {
				...base,
				status: "error",
				error: "empty-payload",
				errorMessage: "上游未返回任何可识别的额度",
				keySource
			};
		}
		return {
			...base,
			status: "ok",
			plan: parsed.plan || null,
			windows,
			balances,
			keySource,
			fetchedAt: Date.now()
		};
	} catch (error) {
		const isUpstream = error instanceof UpstreamError;
		return {
			...base,
			status: "error",
			error: isUpstream ? error.code : "parse-failed",
			errorMessage: String((error && error.message) || error),
			keySource
		};
	}
}

/** Per-provider cache with in-flight de-duplication and a last-good fallback. */
function createRegistry(ctx, settings) {
	const entries = new Map();

	function entryFor(id) {
		let entry = entries.get(id);
		if (!entry) {
			entry = { at: 0, payload: null, lastGood: null, inflight: null };
			entries.set(id, entry);
		}
		return entry;
	}

	async function loadOne(id, force) {
		const provider = PROVIDERS_BY_ID.get(id);
		if (!provider) return null;
		const entry = entryFor(id);
		const now = Date.now();

		if (!force && entry.payload && now - entry.at < settings.cacheMs) {
			return { ...entry.payload, stale: false, cacheAgeMs: now - entry.at };
		}
		if (entry.inflight) return entry.inflight;

		entry.inflight = (async () => {
			const result = await fetchProvider(ctx, provider, settings);
			entry.at = Date.now();
			if (result.status === "ok") {
				entry.payload = result;
				entry.lastGood = result;
				return { ...result, stale: false, cacheAgeMs: 0 };
			}
			if (result.status === "unconfigured" || result.status === "disabled") {
				entry.payload = result;
				return { ...result, stale: false, cacheAgeMs: 0 };
			}
			// Keep serving the last good numbers, flagged as stale.
			const fallback = entry.lastGood;
			entry.payload = result;
			return {
				...result,
				stale: Boolean(fallback),
				...(fallback
					? {
							windows: fallback.windows,
							balances: fallback.balances,
							plan: fallback.plan,
							fetchedAt: fallback.fetchedAt,
							keySource: result.keySource || fallback.keySource
						}
					: {}),
				cacheAgeMs: 0
			};
		})();

		try {
			return await entry.inflight;
		} finally {
			entry.inflight = null;
		}
	}

	/** @param {{ provider?: string|null, force?: boolean }} request */
	async function load(request) {
		const requested = request.provider && PROVIDERS_BY_ID.has(request.provider) ? [request.provider] : null;
		const ids = requested || PROVIDERS.map((provider) => provider.id);
		const results = await Promise.all(ids.map((id) => loadOne(id, Boolean(request.force))));
		const providers = results.filter(Boolean);
		return providers;
	}

	return { load, loadOne };
}

/* ══════════════════════════════════════════════════════════════════ config */

/** @param {unknown} config */
function normaliseConfig(config) {
	const source = config && typeof config === "object" ? config : {};
	const merged = { ...DEFAULTS, providers: {} };

	if (source.providers && typeof source.providers === "object" && !Array.isArray(source.providers)) {
		for (const [id, value] of Object.entries(source.providers)) {
			if (value && typeof value === "object") merged.providers[id] = { ...value };
		}
	}

	for (const key of ["cacheMs", "timeoutMs"]) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) merged[key] = value;
	}
	if (Array.isArray(source.thresholds) && source.thresholds.length === 3 && source.thresholds.every((n) => Number.isFinite(n))) {
		merged.thresholds = source.thresholds.map((n) => Math.max(0, Math.min(100, Math.round(n))));
	}
	if (typeof source.defaultProvider === "string" && source.defaultProvider.trim()) {
		merged.defaultProvider = source.defaultProvider.trim();
	}
	if (typeof source.hideUnconfigured === "boolean") merged.hideUnconfigured = source.hideUnconfigured;
	if (typeof source.insecureTls === "boolean") merged.insecureTls = source.insecureTls;

	return merged;
}

/* ══════════════════════════════════════════════════════════════════ route */

/** Refuse cross-site callers; a page on another origin must not read the quota route. */
function isTrustedRequest(req) {
	const site = req.headers["sec-fetch-site"];
	if (typeof site === "string" && site && site !== "same-origin" && site !== "same-site" && site !== "none") {
		return false;
	}
	const origin = req.headers.origin;
	if (typeof origin === "string" && origin) {
		try {
			if (new URL(origin).host !== req.headers.host) return false;
		} catch (error) {
			return false;
		}
	}
	return true;
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}

function createHandler(registry, settings) {
	return async function handler(req, res) {
		try {
			if (!isTrustedRequest(req)) {
				sendJson(res, 403, { ok: false, error: "forbidden", errorMessage: "跨站请求被拒绝" });
				return;
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
				res.end();
				return;
			}

			let params = null;
			try {
				params = new URL(req.url, "http://localhost").searchParams;
			} catch (error) {
				params = new URLSearchParams();
			}
			const providerId = params.get("provider");
			const force = params.get("refresh") === "1";
			const debug = params.get("debug") === "1";

			let providers = await registry.load({ provider: providerId, force });
			if (settings.hideUnconfigured) {
				providers = providers.filter((entry) => entry.status !== "unconfigured");
			}

			const anyOk = providers.some((entry) => entry.status === "ok" || entry.status === "stale");
			const payload = {
				ok: anyOk,
				fetchedAt: Date.now(),
				defaultProvider: settings.defaultProvider,
				thresholds: settings.thresholds,
				windows: WINDOW_ORDER,
				providers
			};
			if (debug) {
				payload.debug = {
					cacheMs: settings.cacheMs,
					timeoutMs: settings.timeoutMs,
					hideUnconfigured: settings.hideUnconfigured,
					insecureTls: settings.insecureTls,
					endpoints: Object.fromEntries(
						providers.map((entry) => [entry.id, providerConfig(settings, entry.id).endpoint || null])
					)
				};
			}
			sendJson(res, 200, payload);
		} catch (error) {
			try {
				sendJson(res, 500, { ok: false, error: "internal", errorMessage: String((error && error.message) || error) });
			} catch (nested) {
				/* response already gone */
			}
		}
	};
}

/**
 * @param {import('cordis').Context} ctx
 * @param {unknown} [config]
 */
function apply(ctx, config) {
	const settings = normaliseConfig(config);
	const registry = createRegistry(ctx, settings);
	const handler = createHandler(registry, settings);

	ctx.effect(() => {
		let routeDisposer = null;
		let attempts = 0;
		let timer = null;

		const registerNow = () => {
			let webServer = null;
			try {
				webServer = typeof ctx.get === "function" ? ctx.get("webServer") : null;
			} catch (error) {
				/* ignore */
			}
			if (!webServer) {
				try {
					webServer = ctx.webServer || null;
				} catch (error) {
					/* ignore */
				}
			}
			if (!webServer || typeof webServer.register !== "function") return false;
			routeDisposer = webServer.register({ kind: "exact", path: ROUTE_PATH, handler });
			return true;
		};

		const disposeRoute = () => {
			if (!routeDisposer) return;
			const disposer = routeDisposer;
			routeDisposer = null;
			try {
				disposer();
			} catch (error) {
				/* ignore */
			}
		};

		if (!registerNow()) {
			// webServer can land after plugin activation; poll briefly, then give up quietly.
			timer = setInterval(() => {
				attempts += 1;
				if (registerNow() || attempts >= 20) {
					clearInterval(timer);
					timer = null;
				}
			}, 500);
		}

		// Always hand the route disposer back: a duplicate exact route throws
		// "duplicate exact route" and kills activation on plugin reload.
		return () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
			disposeRoute();
		};
	}, "coding-plan-quota: usage.json route");
}

export {
	apply,
	inject,
	name,
	PROVIDERS,
	ROUTE_PATH,
	WINDOW_ORDER,
	dshHomeDirectory,
	httpJson,
	normaliseConfig,
	parsePayload,
	providerConfig,
	fetchProvider,
	resolveSecret,
	scanGenericWindows
};
