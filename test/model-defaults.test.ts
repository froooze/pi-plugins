/**
 * Tests for the centralized model-defaults reconcile logic in
 * extensions/shared/model-defaults.ts.
 *
 * These guard the policy: local explicit choices are king, redundant mirrors of
 * the current shared value are removed, and stale mirrors of a previous shared
 * value are removed so an updated centralized default takes effect.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/model-defaults.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { reconcileModelDefaults, resolveThinking } from "../extensions/shared/model-defaults.ts";

const SHARED = {
	defaultProvider: "opencode-go",
	defaultModel: "deepseek-v4.1-flash",
	defaultThinkingLevel: "low",
};

test("reconcile: redundant local mirrors of the shared values are removed", () => {
	const settings = { ...SHARED, theme: "dark-white-footer" };
	const result = reconcileModelDefaults(settings, SHARED, {});

	assert.equal(result.changed, true);
	assert.deepEqual(result.removed.sort(), ["defaultModel", "defaultProvider", "defaultThinkingLevel"]);
	assert.equal(result.localOverride, false);
	assert.deepEqual(result.settings, { theme: "dark-white-footer" });
});

test("reconcile: explicit local overrides are kept and flagged", () => {
	const settings = { defaultProvider: "opencode", defaultModel: "other-model", tuiMode: "fullscreen" };
	const result = reconcileModelDefaults(settings, SHARED, {});

	assert.equal(result.changed, false);
	assert.equal(result.localOverride, true);
	assert.deepEqual(result.overridden, ["defaultProvider", "defaultModel"]);
	assert.deepEqual(result.settings, settings);
});

test("reconcile: a stale mirror of the previous shared value is removed", () => {
	// The user's settings still hold the value we propagated from an older sync.
	const settings = { defaultProvider: "opencode-go" };
	const previous = { defaultProvider: "opencode-go" };
	const shared = { defaultProvider: "openai-codex" };
	const result = reconcileModelDefaults(settings, shared, previous);

	assert.equal(result.changed, true);
	assert.deepEqual(result.removed, ["defaultProvider"]);
	assert.equal(result.localOverride, false);
	assert.deepEqual(result.settings, {});
});

test("reconcile: a value equal to both previous and shared is redundant", () => {
	const settings = { defaultModel: "deepseek-v4.1-flash" };
	const result = reconcileModelDefaults(settings, SHARED, { defaultModel: "deepseek-v4.1-flash" });

	assert.equal(result.changed, true);
	assert.deepEqual(result.removed, ["defaultModel"]);
});

test("reconcile: only local differences are overridden, redundant ones dropped", () => {
	const settings = { defaultProvider: "opencode-go", defaultModel: "other-model" };
	const result = reconcileModelDefaults(settings, SHARED, {});

	assert.equal(result.changed, true);
	assert.deepEqual(result.removed, ["defaultProvider"]);
	assert.deepEqual(result.overridden, ["defaultModel"]);
	assert.deepEqual(result.settings, { defaultModel: "other-model" });
});

test("reconcile: unrelated keys are never touched", () => {
	const settings = { theme: "x", compaction: { keepRecentTokens: 60000 } };
	const result = reconcileModelDefaults(settings, SHARED, {});
	assert.deepEqual(result.settings, settings);
	assert.equal(result.changed, false);
});

test("reconcile: an empty shared file manages nothing", () => {
	const settings = { defaultProvider: "opencode-go" };
	const result = reconcileModelDefaults(settings, {}, {});
	assert.deepEqual(result.settings, settings);
	assert.equal(result.changed, false);
	assert.equal(result.localOverride, false);
});

test("reconcile: does not mutate its inputs", () => {
	const settings = { ...SHARED };
	const shared = { ...SHARED };
	reconcileModelDefaults(settings, shared, {});
	assert.deepEqual(settings, SHARED);
	assert.deepEqual(shared, SHARED);
});

test("resolveThinking: shared level applies when nothing local overrides it", () => {
	assert.equal(resolveThinking({}, SHARED, "opencode-go", "deepseek-v4.1-flash", ["low", "high"]), "low");
});

test("resolveThinking: a local defaultThinkingLevel wins", () => {
	assert.equal(resolveThinking({ defaultThinkingLevel: "high" }, SHARED, "opencode-go", "deepseek-v4.1-flash", ["low", "high"]), "high");
});

test("resolveThinking: a local per-model thinking level wins", () => {
	const settings = { modelThinkingLevels: { "opencode-go/deepseek-v4.1-flash": "max" } };
	assert.equal(resolveThinking(settings, SHARED, "opencode-go", "deepseek-v4.1-flash", ["low", "max"]), "max");
});

test("resolveThinking: a local per-model level for another model falls back to shared", () => {
	const settings = { modelThinkingLevels: { "opencode-go/other": "max" } };
	assert.equal(resolveThinking(settings, SHARED, "opencode-go", "deepseek-v4.1-flash", ["low", "max"]), "low");
});

test("resolveThinking: an invalid shared level is ignored", () => {
	assert.equal(resolveThinking({}, SHARED, "opencode-go", "deepseek-v4.1-flash", ["off"]), undefined);
});
