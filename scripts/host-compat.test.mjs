import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as plugin from "../lib/host.js";

const payload = { success: true, data: { limits: [
	{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 }
] } };

async function upstream(handler) {
	const server = createServer(handler);
	await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
	return {
		url: `http://127.0.0.1:${server.address().port}/quota`,
		close: () => new Promise(done => { server.close(done); server.closeAllConnections(); })
	};
}

test("quota requests rotate synthetic credentials and normalize HTTP/JSON failures", async () => {
	let status = 200;
	let responseBody = JSON.stringify(payload);
	const headers = [];
	const server = await upstream((req, res) => { headers.push(req.headers.authorization); res.writeHead(status); res.end(responseBody); });
	try {
		let key = "synthetic-quota-key-1";
		const ref = `DSH_QUOTA_COMPAT_${randomUUID().replaceAll("-", "")}`;
		const spec = { ...plugin.PROVIDERS.find(p => p.id === "glm"), secret: { env: ref } };
		const ctx = { get: () => ({ resolve: async () => ({ value: key, source: "test-service" }) }) };
		const settings = plugin.normaliseConfig({ providers: { glm: { endpoint: server.url } } });
		assert.equal((await plugin.fetchProvider(ctx, spec, settings)).windows.session.percent, 1);
		key = "synthetic-quota-key-2";
		assert.equal((await plugin.fetchProvider(ctx, spec, settings)).status, "ok");
		assert.deepEqual(headers, ["Bearer synthetic-quota-key-1", "Bearer synthetic-quota-key-2"]);
		for (status of [401, 403]) {
			const failure = await plugin.fetchProvider(ctx, spec, settings);
			assert.equal(failure.error, `http-${status}`);
			assert.equal(JSON.stringify(failure).includes(key), false);
		}
		status = 200;
		responseBody = "not-json";
		assert.equal((await plugin.fetchProvider(ctx, spec, settings)).error, "bad-json");
	} finally { await server.close(); }
});

test("a hanging isolated quota endpoint times out without a live vendor", async () => {
	const server = await upstream(() => {});
	try {
		const result = await plugin.httpJson({ url: server.url, timeoutMs: 20 });
		assert.equal(result.ok, false);
		assert.match(result.message, /超时/);
	} finally { await server.close(); }
});

const runtime = process.env.DSH_TEST_RUNTIME;
const sdk = runtime ? createRequire(resolve(runtime, "package.json")) : null;
const load = async name => {
	const entry = sdk.resolve(name);
	const within = relative(resolve(runtime, "node_modules"), entry);
	assert.ok(!within.startsWith("..") && !isAbsolute(within), `${name} must resolve inside the selected runtime`);
	if (name.startsWith("@deepseek-ai/dsh-")) {
		assert.ok(process.env.DSH_TEST_VERSION, "set DSH_TEST_VERSION to the exact intended host version");
		const manifest = JSON.parse(await readFile(resolve(runtime, "node_modules", name, "package.json"), "utf8"));
		assert.equal(manifest.version, process.env.DSH_TEST_VERSION, `${name} version`);
	}
	return import(pathToFileURL(entry).href);
};

test("native Cordis/webServer/credentials preserve quota routes across restart and disposal", { skip: !runtime && "set DSH_TEST_RUNTIME to an isolated official runtime" }, async () => {
	const [{ Context }, { WebServer }, { CredentialProvider }] = await Promise.all([
		load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-host-webserver"), load("@deepseek-ai/dsh-credentials")
	]);
	const ctx = new Context();
	let secret = "synthetic-native-credential";
	const ref = `DSH_QUOTA_COMPAT_${randomUUID().replaceAll("-", "")}`;
	class TestCredentials extends CredentialProvider {
		async resolve(value) { assert.equal(value, ref); return { value: secret, source: "test-service" }; }
	}
	new TestCredentials(ctx);
	let requests = 0;
	let failing = false;
	let pending = false;
	let pendingResponse;
	let started;
	const server = await upstream((req, res) => {
		requests++;
		assert.equal(req.headers.authorization, `Bearer ${secret}`);
		if (pending) { pendingResponse = res; started(); return; }
		res.writeHead(failing ? 503 : 200);
		res.end(JSON.stringify(payload));
	});
	try {
		const carrier = ctx.plugin(WebServer, { host: "127.0.0.1", port: 0, compression: "none" });
		await carrier.inertia;
		assert.equal(carrier.state, 2);
		const providers = Object.fromEntries(plugin.PROVIDERS.map(p => [p.id, { enabled: false }]));
		providers.glm = { enabled: true, endpoint: server.url, apiKeyEnv: ref };
		const config = { providers, defaultProvider: "glm", timeoutMs: 500 };
		const quota = ctx.plugin(plugin, config);
		await quota.inertia;
		assert.equal(quota.state, 2);
		const base = `http://127.0.0.1:${ctx.webServer.port}`;
		const route = `${base}${plugin.ROUTE_PATH}?provider=glm`;
		const get = async suffix => {
			const res = await fetch(route + (suffix || ""), { headers: { origin: base } });
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.equal(text.includes("synthetic-native-credential"), false);
			return JSON.parse(text);
		};
		assert.equal((await get()).providers[0].windows.session.percent, 1);
		assert.equal((await get()).providers[0].status, "ok");
		assert.equal(requests, 1, "cached reads do not call the upstream again");
		secret = "synthetic-native-credential-rotated";
		await get("&refresh=1");
		failing = true;
		const stale = (await get("&refresh=1")).providers[0];
		assert.equal(stale.status, "error");
		assert.equal(stale.stale, true);
		assert.equal(stale.windows.session.percent, 1);
		assert.equal(stale.error, "http-503");
		assert.equal((await fetch(route, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
		assert.equal((await fetch(route, { headers: { origin: "https://foreign.invalid" } })).status, 403);
		assert.equal((await fetch(route, { method: "POST" })).status, 405);
		await quota.restart();
		assert.equal(quota.state, 2);
		failing = false;
		assert.equal((await get()).providers[0].status, "ok");
		pending = true;
		const requestStarted = new Promise(done => { started = done; });
		const inFlight = get("&refresh=1");
		await requestStarted;
		await quota.dispose();
		assert.equal((await fetch(route)).status, 404);
		pendingResponse.end(JSON.stringify(payload));
		assert.equal((await inFlight).providers[0].status, "ok");
		pending = false;
		const replacement = ctx.plugin(plugin, config);
		await replacement.inertia;
		assert.equal(replacement.state, 2);
		assert.equal((await get()).providers[0].status, "ok");
	} finally { await ctx.fiber.dispose(); await server.close(); }
});

test("native lifecycle handles a late webServer and cancels registration on early unload", { skip: !runtime && "set DSH_TEST_RUNTIME to an isolated official runtime" }, async () => {
	const [{ Context }, { WebServer }] = await Promise.all([load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-host-webserver")]);
	for (const unloadFirst of [false, true]) {
		const ctx = new Context();
		try {
			const providers = Object.fromEntries(plugin.PROVIDERS.map(p => [p.id, { enabled: false }]));
			const quota = ctx.plugin(plugin, { providers });
			await quota.inertia;
			if (unloadFirst) await quota.dispose();
			const carrier = ctx.plugin(WebServer, { host: "127.0.0.1", port: 0, compression: "none" });
			await carrier.inertia;
			assert.equal(carrier.state, 2);
			await new Promise(done => setTimeout(done, 550));
			const route = `http://127.0.0.1:${ctx.webServer.port}${plugin.ROUTE_PATH}`;
			const response = await fetch(route);
			assert.equal(response.status, unloadFirst ? 404 : 200);
			if (!unloadFirst) {
				assert.ok((await response.json()).providers.every(p => p.status === "disabled"));
				await quota.dispose();
				assert.equal((await fetch(route)).status, 404);
			}
		} finally { await ctx.fiber.dispose(); }
	}
});
