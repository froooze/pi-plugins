/**
 * Tests for the centralized plugin settings-defaults engine in
 * extensions/shared/settings-defaults.ts, plus the invariant that the
 * repo-versioned settings-defaults.json agrees with the code constants it
 * duplicates for every target.
 *
 * Policy under test:
 *   - backfill writes only when the leaf is absent (explicit local value wins);
 *   - enforce writes whenever the leaf differs;
 *   - env mirrors a backfilled boolean only when the var is unset/empty;
 *   - a malformed intermediate never gets clobbered;
 *   - the input object is never mutated.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/settings-defaults.test.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	COMPACT_BACKSTOP_TOKENS,
	KEEP_RECENT_TOKENS,
	RETAINED_TOOL_OUTPUT_MAX_TOKENS,
} from "../extensions/shared/compaction.ts";
import {
	type EnvLike,
	applySettingsDefaults,
	normalizeConfig,
	normalizeDefaults,
} from "../extensions/shared/settings-defaults.ts";

function fakeEnv(initial: Record<string, string> = {}): EnvLike & { store: Record<string, string> } {
	const store = { ...initial };
	return {
		store,
		get: (name) => store[name],
		set: (name, value) => {
			store[name] = value;
		},
	};
}

test("backfill writes an absent leaf and preserves siblings", () => {
	const result = applySettingsDefaults({ theme: "dark" }, { backfill: { "retry.maxRetries": 6 } });

	assert.equal(result.changed, true);
	assert.deepEqual(result.backfilled, ["retry.maxRetries"]);
	assert.deepEqual(result.settings, { theme: "dark", retry: { maxRetries: 6 } });
});

test("backfill keeps an existing leaf and its siblings", () => {
	const settings = { retry: { maxRetries: 3, enabled: true } };
	const result = applySettingsDefaults(settings, { backfill: { "retry.maxRetries": 6 } });

	assert.equal(result.changed, false);
	assert.deepEqual(result.backfilled, []);
	assert.deepEqual(result.settings.retry, { maxRetries: 3, enabled: true });
});

test("enforce overwrites a differing leaf", () => {
	const result = applySettingsDefaults(
		{ compaction: { keepRecentTokens: 1000, reserveTokens: 5 } },
		{ enforce: { "compaction.keepRecentTokens": 60000 } },
	);

	assert.equal(result.changed, true);
	assert.deepEqual(result.enforced, ["compaction.keepRecentTokens"]);
	assert.deepEqual(result.settings.compaction, { keepRecentTokens: 60000, reserveTokens: 5 });
});

test("enforce leaves an equal leaf alone (order-independent)", () => {
	const settings = { retry: { provider: { maxRetries: 0 }, maxRetries: 6 } };
	const result = applySettingsDefaults(settings, {
		enforce: { "retry.provider": { maxRetries: 0 } },
	});

	assert.equal(result.changed, false);
	assert.deepEqual(result.enforced, []);
});

test("deep paths create every missing intermediate object", () => {
	const result = applySettingsDefaults({}, { backfill: { "a.b.c.d": 1 } });

	assert.deepEqual(result.settings, { a: { b: { c: { d: 1 } } } });
});

test("a malformed intermediate is skipped, not clobbered", () => {
	const settings = { retry: "auto" };
	const result = applySettingsDefaults(settings, { backfill: { "retry.maxRetries": 6 } });

	assert.equal(result.changed, false);
	assert.deepEqual(result.skipped, [{ path: "retry.maxRetries", reason: "conflict" }]);
	assert.deepEqual(result.settings, { retry: "auto" });
});

test("an invalid dotted path is skipped", () => {
	const result = applySettingsDefaults({}, { backfill: { "a..b": 1, "": 2 } });

	assert.equal(result.changed, false);
	assert.deepEqual(result.skipped, [
		{ path: "a..b", reason: "invalid-path" },
		{ path: "", reason: "invalid-path" },
	]);
});

test("the input settings object is never mutated", () => {
	const settings = { retry: { enabled: true } };
	const snapshot = JSON.parse(JSON.stringify(settings));
	applySettingsDefaults(settings, { backfill: { "retry.maxRetries": 6 }, enforce: { theme: "x" } });
	assert.deepEqual(settings, snapshot);
});

test("env mirror fires only for a backfilled boolean and records the var", () => {
	const env = fakeEnv();
	const target = {
		backfill: { enableHomeDirScanning: false },
		env: { enableHomeDirScanning: "FFF_ENABLE_HOME_SCAN" },
	};
	const result = applySettingsDefaults({}, target, { env });

	assert.deepEqual(result.backfilled, ["enableHomeDirScanning"]);
	assert.deepEqual(result.mirrored, ["FFF_ENABLE_HOME_SCAN"]);
	assert.equal(env.store.FFF_ENABLE_HOME_SCAN, "0");
});

test("env mirror is skipped when the key is present in the file", () => {
	const env = fakeEnv();
	const target = {
		backfill: { enableHomeDirScanning: false },
		env: { enableHomeDirScanning: "FFF_ENABLE_HOME_SCAN" },
	};
	const result = applySettingsDefaults({ enableHomeDirScanning: true }, target, { env });

	assert.equal(result.changed, false);
	assert.deepEqual(result.mirrored, []);
	assert.equal(env.store.FFF_ENABLE_HOME_SCAN, undefined);
});

test("env mirror never overwrites an explicitly set env var", () => {
	const env = fakeEnv({ FFF_ENABLE_HOME_SCAN: "1" });
	const target = {
		backfill: { enableHomeDirScanning: false },
		env: { enableHomeDirScanning: "FFF_ENABLE_HOME_SCAN" },
	};
	const result = applySettingsDefaults({}, target, { env });

	assert.equal(result.changed, true);
	assert.deepEqual(result.mirrored, []);
	assert.equal(env.store.FFF_ENABLE_HOME_SCAN, "1");
});

test("normalizeDefaults keeps valid env entries and drops malformed sections", () => {
	assert.deepEqual(normalizeDefaults(null), { backfill: {}, enforce: {}, env: {} });
	assert.deepEqual(normalizeDefaults({ backfill: "nope", enforce: [], env: { a: 1, b: "X" } }), {
		backfill: {},
		enforce: {},
		env: { b: "X" },
	});
});

test("normalizeConfig parses each target and ignores non-object targets", () => {
	const config = normalizeConfig({ targets: { a: { backfill: { x: 1 } }, b: "nope" } });
	assert.deepEqual(Object.keys(config.targets), ["a"]);
	assert.deepEqual(config.targets.a.backfill, { x: 1 });
});

test("settings-defaults.json agrees with the code constants for every target", () => {
	const raw = JSON.parse(readFileSync(new URL("../settings-defaults.json", import.meta.url), "utf8"));
	const { targets } = normalizeConfig(raw);

	// Pi settings.json
	assert.equal(targets.settings?.backfill?.["retry.maxRetries"], 6);
	assert.equal(targets.settings?.enforce?.["compaction.keepRecentTokens"], KEEP_RECENT_TOKENS);
	assert.equal(targets.settings?.enforce?.tuiMode, "fullscreen");
	assert.equal(targets.settings?.enforce?.theme, "dark-white-footer");

	// pi-blackhole
	assert.equal(targets["pi-blackhole"]?.backfill?.compaction, "auto");
	assert.equal(targets["pi-blackhole"]?.backfill?.compactionEngine, "blackhole");
	assert.equal(targets["pi-blackhole"]?.enforce?.compactAfterTokens, COMPACT_BACKSTOP_TOKENS);
	assert.equal(
		targets["pi-blackhole"]?.enforce?.retainedToolOutputMaxTokens,
		RETAINED_TOOL_OUTPUT_MAX_TOKENS,
	);
	assert.equal(targets["pi-blackhole"]?.enforce?.memory, false);
	assert.equal(targets["pi-blackhole"]?.enforce?.tailBehavior, "pi-default");

	// pi-fff
	assert.equal(targets["pi-fff"]?.backfill?.enableFsRootScanning, false);
	assert.equal(targets["pi-fff"]?.backfill?.enableHomeDirScanning, false);
	assert.equal(targets["pi-fff"]?.env?.enableFsRootScanning, "FFF_ENABLE_ROOT_SCAN");
	assert.equal(targets["pi-fff"]?.env?.enableHomeDirScanning, "FFF_ENABLE_HOME_SCAN");
});
