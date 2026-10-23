import assert from "node:assert/strict";
import test from "node:test";
import { parsePayload, scanGenericWindows } from "../lib/host.js";

const reset = 1792649916037;
const limits = [
	{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: reset },
	{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 3, nextResetTime: 1793175268953 },
	{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 23, remaining: 3977, percentage: 1, nextResetTime: 1793150273978 }
];
const expected = { session: 1, weekly: 3, monthly: 1 };
const percentages = (windows) => Object.fromEntries(Object.entries(windows).map(([key, value]) => [key, value.percent]));

test("GLM issue #1 keeps explicit 1% as 1%, including the generic fallback", () => {
	assert.deepEqual(percentages(scanGenericWindows({ data: { limits } })), expected);
	assert.deepEqual(percentages(parsePayload("glm", { success: true, data: { limits } }).windows), expected);
});

test("GLM identifies all windows independently of array order or missing siblings", () => {
	for (const rows of [limits, [...limits].reverse(), [limits[1], limits[0], limits[2]], ...limits.map((row) => [row])]) {
		const windows = parsePayload("glm", { success: true, data: { limits: rows } }).windows;
		for (const row of rows) {
			const key = row.unit === 3 ? "session" : row.unit === 6 ? "weekly" : "monthly";
			assert.equal(windows[key]?.percent, row.percentage);
			assert.equal(windows[key]?.resetsAt, new Date(row.nextResetTime).toISOString());
		}
		assert.equal(Object.keys(windows).length, rows.length);
	}
});

test("explicit percentage fields preserve zero, fractional percent, 1 and 100", () => {
	for (const key of ["percent", "percentage", "usedPercent", "used_percent", "usage_percentage", "usagePercent"]) {
		for (const value of [0, 0.5, 1, 3, 100, "1"]) {
			assert.equal(scanGenericWindows({ [key]: value, resets_at: reset }).session.percent, Number(value), `${key}=${value}`);
		}
	}
	for (const key of ["remaining_percent", "remainingPercent", "percent_remaining", "current_interval_remaining_percent"]) {
		assert.equal(scanGenericWindows({ [key]: 1, resets_at: reset }).session.percent, 99, key);
	}
});

test("fraction fields retain existing normalization and inversion", () => {
	for (const [key, value, expected] of [["utilization", 0.42, 42], ["utilization", 1, 100], ["used_rate", 0.5, 50], ["remainingFraction", 1, 0], ["remaining_fraction", 0.2, 80]]) {
		assert.equal(scanGenericWindows({ [key]: value, resets_at: reset }).session.percent, expected, key);
	}
});

test("provider-specific percentage paths do not treat 1% as a fraction", () => {
	assert.equal(parsePayload("codex", { rate_limit: { primary_window: { used_percent: 1, window_minutes: 300 } } }).windows.session.percent, 1);
	assert.equal(parsePayload("copilot", { quota_snapshots: [{ used_percent: 1 }] }).windows.monthly.percent, 1);
	assert.equal(parsePayload("claude", { five_hour: { percent: 1 } }).windows.session.percent, 1);
	assert.equal(parsePayload("claude", { five_hour: { utilization: 0.42 } }).windows.session.percent, 42);
	assert.equal(parsePayload("codex", { rate_limit: { primary_window: { utilization: 0.42, window_minutes: 300 } } }).windows.session.percent, 42);
});

test("legacy GLM remaining percentages still select the worst model", () => {
	const windows = parsePayload("glm", { data: { model_remains: [
		{ current_interval_remaining_percent: 62.5, current_weekly_remaining_percent: 30 },
		{ current_interval_remaining_percent: 10, current_weekly_remaining_percent: 55 }
	] } }).windows;
	assert.deepEqual(percentages(windows), { session: 90, weekly: 70 });
	assert.throws(() => parsePayload("glm", { success: false, code: 401 }));
});

test("GLM does not assign unknown or invalid limits by array position", () => {
	const unknown = { type: "TOKENS_LIMIT", unit: 99, number: 1, percentage: 50, nextResetTime: reset };
	assert.deepEqual(percentages(parsePayload("glm", { data: { limits: [unknown, limits[1], null] } }).windows), { weekly: 3 });
	for (const rows of [[unknown], [], [{ ...limits[0], percentage: "invalid" }]]) {
		assert.throws(() => parsePayload("glm", { data: { limits: rows } }), /没有可识别/);
	}
});
