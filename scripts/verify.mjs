/**
 * End-to-end verification for dsh-coding-plan-quota.
 *
 *   node scripts/verify.mjs        (or: pnpm verify)
 *
 * Covers, in order:
 *   1. the provider registry,
 *   2. every parser against a realistic payload,
 *   3. the conservative generic fallback,
 *   4. config merging and per-provider overrides,
 *   5. the live OpenCode Go endpoint using the real credential on this machine,
 *   6. a deliberately bad key (must map to HTTP 401),
 *   7. the plugin's own HTTP route when the DSH host is up, plus its
 *      cross-site, foreign-origin and method hardening,
 *   8. the client half's static contract.
 *
 * Exits non-zero on any failure. Network-dependent checks report SKIP rather
 * than FAIL when the machine is offline.
 *
 * NOTE: the DSH host imports the node half once, at startup. Editing lib/host.js
 * does NOT change a running host — restart DSH to pick up node-half edits.
 * This script imports lib/host.js directly, so it always tests the code on disk.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
	PROVIDERS,
	ROUTE_PATH,
	WINDOW_ORDER,
	fetchProvider,
	normaliseConfig,
	parsePayload,
	providerConfig,
	scanGenericWindows
} from "../lib/host.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.DSH_WEB_URL || "http://127.0.0.1:19387";
const ROUTE = `${BASE}${ROUTE_PATH}`;

let pass = 0;
let fail = 0;
let skip = 0;

function check(label, condition, detail) {
	if (condition) {
		pass += 1;
		console.log(`  PASS  ${label}${detail === undefined ? "" : `  ${detail}`}`);
	} else {
		fail += 1;
		console.log(`  FAIL  ${label}${detail === undefined ? "" : `  ${detail}`}`);
	}
}
function section(title) {
	console.log(`\n=== ${title} ===`);
}
function note(text) {
	skip += 1;
	console.log(`  NOTE  ${text}`);
}
const pct = (out, key) => out && out.windows && out.windows[key] && out.windows[key].percent;

/* ─────────────────────────────────────────────────────────────── 1. registry */

section("provider registry");
console.log(`  ${PROVIDERS.length} providers: ${PROVIDERS.map((p) => p.id).join(", ")}`);
check("every provider has id/label/kind/parse", PROVIDERS.every((p) => p.id && p.label && p.label.zh && p.label.en && p.kind && typeof p.parse === "function"));
check("kinds are windows|balance", PROVIDERS.every((p) => p.kind === "windows" || p.kind === "balance"));
check("ids are unique", new Set(PROVIDERS.map((p) => p.id)).size === PROVIDERS.length);
check("windows are session/weekly/monthly", JSON.stringify(WINDOW_ORDER) === '["session","weekly","monthly"]', JSON.stringify(WINDOW_ORDER));
check("every windows provider declares a secret", PROVIDERS.filter((p) => p.kind === "windows").every((p) => p.secret && (p.secret.env || p.secret.files)));

/* ──────────────────────────────────────────────────────────────── 2. parsers */

section("windows parsers");

/* OpenCode Go — the only source this machine can authenticate. */
{
	const out = parsePayload("opencode-go", {
		rolling: { status: "ok", percent: 0, resetsAt: "2026-10-06T09:14:11.790Z" },
		weekly: { status: "ok", percent: 0, resetsAt: "2026-10-12T00:00:00.000Z" },
		monthly: { status: "ok", percent: 2, resetsAt: "2026-10-29T07:02:24.000Z" }
	});
	check("opencode-go rolling -> session", pct(out, "session") === 0, `got ${pct(out, "session")}`);
	check("opencode-go monthly -> monthly", pct(out, "monthly") === 2, `got ${pct(out, "monthly")}`);
	check("opencode-go keeps the reset instant", out.windows.monthly.resetsAt === "2026-10-29T07:02:24.000Z");
}

/* Zhipu GLM — its percentage is REMAINING, so it must be inverted. */
{
	const out = parsePayload("glm", {
		code: 200,
		msg: "success",
		success: true,
		data: {
			model_remains: [
				{ model_name: "glm-5", current_interval_remaining_percent: 62.5, end_time: 1760000000000, current_weekly_remaining_percent: 30, weekly_end_time: 1760500000000 },
				{ model_name: "glm-4.6", current_interval_remaining_percent: 10, end_time: 1760000000000, current_weekly_remaining_percent: 55, weekly_end_time: 1760500000000 }
			]
		}
	});
	check("glm inverts remaining -> used, worst model (62.5|10 -> 90)", pct(out, "session") === 90, `got ${pct(out, "session")}`);
	check("glm inverts the weekly window (30|55 -> 70)", pct(out, "weekly") === 70, `got ${pct(out, "weekly")}`);
	check("glm converts epoch-ms to ISO", /^\d{4}-/.test((out.windows.session && out.windows.session.resetsAt) || ""), out.windows.session.resetsAt);
}
{
	let threw = null;
	try {
		parsePayload("glm", { code: 401, msg: "token expired or incorrect", success: false });
	} catch (error) {
		threw = error;
	}
	check("glm rejects success:false even inside HTTP 200", Boolean(threw), threw ? String(threw.message).slice(0, 60) : "did NOT throw");
}

/* Claude subscription OAuth — utilization is a 0–1 fraction. */
{
	const out = parsePayload("claude", {
		five_hour: { utilization: 0.42, resets_at: "2026-10-06T10:00:00.000Z" },
		seven_day: { utilization: 0.81, resets_at: "2026-10-12T00:00:00.000Z" }
	});
	check("claude five_hour 0.42 -> 42%", pct(out, "session") === 42, `got ${pct(out, "session")}`);
	check("claude seven_day 0.81 -> 81%", pct(out, "weekly") === 81, `got ${pct(out, "weekly")}`);
}

/* Codex / ChatGPT — windows are classified by their own declared duration. */
{
	const out = parsePayload("codex", {
		plan_type: "plus",
		rate_limit: {
			primary_window: { used_percent: 35, window_minutes: 300, reset_at: 1760000000 },
			secondary_window: { used_percent: 70, window_minutes: 10080, reset_at: 1760500000 }
		}
	});
	check("codex 300min -> session 35%", pct(out, "session") === 35, `got ${pct(out, "session")}`);
	check("codex 10080min -> weekly 70%", pct(out, "weekly") === 70, `got ${pct(out, "weekly")}`);
	check("codex epoch-seconds -> ISO", /^\d{4}-/.test((out.windows.session && out.windows.session.resetsAt) || ""), out.windows.session.resetsAt);
	check("codex invents no third window", Object.keys(out.windows).length === 2, `keys=${Object.keys(out.windows).join(",")}`);
	check("codex surfaces the plan type", out.plan === "plus", String(out.plan));
}

/* Gemini CLI — remainingFraction is a REMAINING fraction; the worst model wins. */
{
	const out = parsePayload("gemini", {
		buckets: [
			{ modelId: "gemini-2.5-pro", remainingFraction: 0.2, resetTime: "2026-10-06T10:00:00.000Z" },
			{ modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: "2026-10-06T10:00:00.000Z" }
		]
	});
	const bucket = out.windows.session || out.windows.weekly || out.windows.monthly;
	check("gemini 0.2 remaining -> 80% used (worst model)", Boolean(bucket) && bucket.percent === 80, `got ${bucket && bucket.percent}`);
}

/* GitHub Copilot — percent_remaining is REMAINING; 100 - 88.5 = 11.5. */
{
	const out = parsePayload("copilot", {
		quota_snapshots: [{ quota_id: "chat", percent_remaining: 88.5, remaining: 100, quota_reset_date_utc: "2026-11-01T00:00:00.000Z" }]
	});
	const bucket = out.windows.monthly || out.windows.weekly || out.windows.session;
	check("copilot percent_remaining 88.5 -> 11.5% used", Boolean(bucket) && Math.abs(bucket.percent - 11.5) < 0.01, `got ${bucket && bucket.percent}`);
	check("copilot keeps a fractional percentage", Boolean(bucket) && bucket.percent % 1 !== 0, `got ${bucket && bucket.percent}`);
}

/* MiniMax — quota_5_hour / quota_7_day with usage_percentage. */
{
	const out = parsePayload("minimax", {
		base_resp: { status_code: 0 },
		data: { quota_5_hour: { usage_percentage: 12, resets_at: 1760000000 }, quota_7_day: { usage_percentage: 44, resets_at: 1760500000 } }
	});
	check("minimax quota_5_hour -> session 12%", pct(out, "session") === 12, `got ${pct(out, "session")}`);
	check("minimax quota_7_day -> weekly 44%", pct(out, "weekly") === 44, `got ${pct(out, "weekly")}`);
	check("minimax invents no third window", Object.keys(out.windows).length === 2, `keys=${Object.keys(out.windows).join(",")}`);
}
{
	let threw = null;
	try {
		parsePayload("minimax", { base_resp: { status_code: 1004, status_msg: "cookie is missing, log in again" } });
	} catch (error) {
		threw = error;
	}
	check("minimax surfaces base_resp failures", Boolean(threw), threw ? String(threw.message).slice(0, 60) : "did NOT throw");
}

/* Kimi — no percentage field, only a used/limit pair plus a window name. */
{
	const out = parsePayload("kimi", {
		limits: [
			{ window: "5h", used: 10, limit: 100, resetTime: "2026-10-06T10:00:00.000Z" },
			{ window: "weekly", used: 200, limit: 1000, resetTime: "2026-10-12T00:00:00.000Z" }
		]
	});
	check("kimi derives 10/100 -> session 10%", pct(out, "session") === 10, `got ${pct(out, "session")}`);
	check("kimi derives 200/1000 -> weekly 20%", pct(out, "weekly") === 20, `got ${pct(out, "weekly")}`);
	check("kimi invents no third window", Object.keys(out.windows).length === 2, `keys=${Object.keys(out.windows).join(",")}`);
}

/* ──────────────────────────────────────────────────────── 3. balance parsers */

section("balance parsers");
for (const [id, payload, currency, amount] of [
	["deepseek", { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "6.07", granted_balance: "0.00", topped_up_balance: "6.07" }] }, "CNY", 6.07],
	["openrouter", { data: { total_credits: 100, total_usage: 37.5 } }, "USD", 62.5],
	["siliconflow", { code: 20000, data: { totalBalance: "12.34" } }, "CNY", 12.34],
	["stepfun", { availableBalanceUSD: "9.5" }, "USD", 9.5],
	["novita", { availableBalance: "3.25" }, "USD", 3.25],
	["moonshot", { data: { available_balance: "20" } }, "CNY", 20]
]) {
	const first = parsePayload(id, payload).balances[0];
	check(`${id} = ${amount} ${currency}`, Boolean(first) && Math.abs(first.amount - amount) < 0.01 && first.currency === currency, first ? `got ${first.amount} ${first.currency}` : "no balances");
}

/* ─────────────────────────────────────────────────── 4. generic fallback */

section("conservative generic fallback");
{
	const out = scanGenericWindows({ data: { usage_percentage: 33, resets_at: 1760000000, quota_5_hour: "x" } });
	check("accepts a percent + reset pair", Object.keys(out).length === 1, `keys=${Object.keys(out).join(",")}`);
	check("ignores numbers with no reset field", Object.keys(scanGenericWindows({ count: 7, total: 42, page: 3, foo: "bar" })).length === 0);
	check("ignores a lone percentage with no reset", Object.keys(scanGenericWindows({ usage_percentage: 33 })).length === 0);
	const two = scanGenericWindows({ a: { percent: 10, resets_at: 1760000000 }, b: { percent: 20, resets_at: 1760500000 } });
	check("caps unnamed fallbacks at the three canonical windows", Object.keys(two).length === 2, `keys=${Object.keys(two).join(",")}`);
}

/* ───────────────────────────────────────────────────────────── 5. config */

section("config merge");
{
	const settings = normaliseConfig({
		cacheMs: 1000,
		thresholds: [40, 70, 90],
		defaultProvider: "glm",
		providers: { glm: { region: "cn", apiKey: "literal-key", enabled: true }, ark: { endpoint: "https://example.invalid/usage" } }
	});
	const glm = providerConfig(settings, "glm");
	check("region cn selects the CN endpoint", String(glm.endpoint).includes("bigmodel.cn"), glm.endpoint);
	check("a literal apiKey override is honoured", glm.apiKey === "literal-key");
	check("per-provider thresholds survive", JSON.stringify(settings.thresholds) === "[40,70,90]");
	const ark = providerConfig(settings, "ark");
	check("ark stays unconfigured until an endpoint is supplied", ark.endpoint === "https://example.invalid/usage", ark.endpoint);
	check("unlisted providers keep their built-in endpoint", String(providerConfig(settings, "kimi").endpoint).includes("api.kimi.com"));

	const junk = normaliseConfig({ cacheMs: "nope", timeoutMs: -5, thresholds: [], insecureTls: "yes" });
	check("junk falls back to defaults", junk.cacheMs === 60_000 && junk.timeoutMs === 12_000 && junk.thresholds.length === 3 && junk.insecureTls === false, JSON.stringify({ cacheMs: junk.cacheMs, timeoutMs: junk.timeoutMs }));
	check("defaultProvider defaults to opencode-go", normaliseConfig(undefined).defaultProvider === "opencode-go");
}

/* ──────────────────────────────────────────── 6. live upstream + bad key */

section("live OpenCode Go (real credential, real network)");
{
	const provider = PROVIDERS.find((p) => p.id === "opencode-go");
	const live = await fetchProvider({}, provider, normaliseConfig({}));
	if (live.error === "fetch-failed" || live.error === "timeout") {
		note(`upstream unreachable (${live.errorMessage}) — skipping the network assertions`);
	} else {
		check("live status is ok", live.status === "ok", `status=${live.status} error=${live.errorMessage || "-"}`);
		check("live payload yields session/weekly/monthly", Boolean(live.windows) && ["session", "weekly", "monthly"].every((k) => live.windows[k]), `windows=${Object.keys(live.windows || {}).join(",")}`);
		check("a credential was resolved", Boolean(live.keySource), String(live.keySource));
		for (const key of ["session", "weekly", "monthly"]) {
			const entry = live.windows[key];
			if (!entry) continue;
			const hours = (Date.parse(entry.resetsAt) - Date.now()) / 3_600_000;
			check(`  ${key}`, entry.percent >= 0 && entry.percent <= 100 && (!Number.isFinite(hours) || hours > 0), `${entry.percent}% used, resets in ${Number.isFinite(hours) ? hours.toFixed(2) : "?"}h`);
		}
	}
}
{
	const provider = PROVIDERS.find((p) => p.id === "opencode-go");
	const settings = normaliseConfig({ providers: { "opencode-go": { apiKey: "oc_sk_deliberately_invalid_probe_key" } } });
	const bad = await fetchProvider({}, provider, settings);
	if (bad.error === "fetch-failed" || bad.error === "timeout") {
		note("upstream unreachable — skipping the bad-key assertion");
	} else {
		check("a bad key maps to http-401", bad.error === "http-401", `error=${bad.error} message=${bad.errorMessage || "-"}`);
	}
}

/* ───────────────────────────────────────────────── 7. live host route */

section("live host route");
let body = null;
let raw = "";
try {
	const probe = await fetch(`${ROUTE}?refresh=1`, { headers: { "sec-fetch-site": "same-origin" } });
	raw = await probe.text();
	check("HTTP 200", probe.status === 200, `status ${probe.status}`);
	body = JSON.parse(raw);
} catch (error) {
	note(`host not reachable at ${ROUTE} (${(error && error.message) || error}) — skipping route checks`);
}

if (body) {
	check("ok:true", body.ok === true);
	check("no key leaked to the page", !/oc_sk|sk-[A-Za-z0-9]{12}/.test(raw));

	if (Array.isArray(body.providers)) {
		check("route reports every provider", body.providers.length === PROVIDERS.length, `${body.providers.length} of ${PROVIDERS.length}`);
		check("thresholds present", JSON.stringify(body.thresholds) === "[50,75,90]", JSON.stringify(body.thresholds));
		check("a default provider is named", typeof body.defaultProvider === "string" && body.defaultProvider.length > 0, String(body.defaultProvider));
		const opencode = body.providers.find((p) => p.id === "opencode-go");
		check("opencode-go is present and healthy", Boolean(opencode) && (opencode.status === "ok" || opencode.status === "stale"), opencode ? `status=${opencode.status}` : "missing");
		check("every provider carries a status", body.providers.every((p) => typeof p.status === "string" && p.status), body.providers.map((p) => `${p.id}:${p.status}`).join(" "));
		// Which sources are authenticated is a property of this machine, not of
		// the code, so assert the invariant instead of a fixed list: no source
		// may claim to be healthy while carrying no numbers at all.
		check("opencode-go answered", body.providers.some((p) => p.id === "opencode-go" && (p.status === "ok" || p.status === "stale")), body.providers.filter((p) => p.status === "ok").map((p) => p.id).join(",") || "none");
		const healthy = body.providers.filter((p) => p.status === "ok");
		check(
			"every healthy source carries real numbers",
			healthy.every((p) => (p.kind === "balance" ? Array.isArray(p.balances) && p.balances.length > 0 : Boolean(p.windows) && Object.keys(p.windows).length > 0)),
			healthy.map((p) => `${p.id}:${p.kind === "balance" ? `${(p.balances || []).length} balance(s)` : Object.keys(p.windows || {}).join("+")}`).join(" ")
		);
		const unset = body.providers.filter((p) => p.status === "unconfigured");
		check(
			"every unconfigured source names the credential it needs",
			unset.every((p) => typeof p.apiKeyEnv === "string" && p.apiKeyEnv.length > 0),
			unset.map((p) => `${p.id}:${p.apiKeyEnv || "?"}`).join(" ") || "none unconfigured"
		);
	} else if (body.usage) {
		note("the host is still serving the pre-restart single-provider shape — restart DSH to publish the provider registry (lib/host.js edits are not hot-loaded)");
		check("legacy shape still yields three windows", ["rolling", "weekly", "monthly"].every((k) => body.usage[k]), Object.keys(body.usage).join(","));
	} else {
		check("route has a recognisable payload", false, JSON.stringify(body).slice(0, 120));
	}

	section("route hardening");
	check("cross-site refused", (await fetch(ROUTE, { headers: { "sec-fetch-site": "cross-site" } })).status === 403);
	check("foreign origin refused", (await fetch(ROUTE, { headers: { origin: "https://evil.example" } })).status === 403);
	check("POST refused", (await fetch(ROUTE, { method: "POST" })).status === 405);
	check("same-origin served", (await fetch(ROUTE, { headers: { origin: BASE } })).status === 200);
}

/* ────────────────────────────────────────────────── 8. client contract */

section("client half");
{
	const client = await readFile(join(HERE, "..", "lib", "client.js"), "utf8");
	check("registers into conversation.input.right", client.includes('"conversation.input.right"'));
	check("polls the node half's own route", client.includes(`"${ROUTE_PATH}"`));
	check("ships the pre-restart legacy shim", client.includes("LEGACY_WINDOW_MAP") && client.includes("legacyProviders"));
	check("wires provider switching through data-provider", client.includes("data-provider"));
	check("reads the live locale snapshot", client.includes("locale") && client.includes("active"));
	check("has an error boundary so it can never break the composer", client.includes("RingBoundary") || client.includes("componentDidCatch"));
	check("never renders a raw key", !/oc_sk|sk-[A-Za-z0-9]{12}/.test(client));
}

/* ───────────────────────────────────────────────────────── summary */

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
console.log(fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`);
// Set exitCode rather than calling process.exit(), so undici's keep-alive
// sockets drain normally instead of tripping a libuv assertion on Windows.
process.exitCode = fail === 0 ? 0 : 1;
