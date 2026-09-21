/**
 * Tests for the model-hotkeys config resolution in
 * extensions/shared/model-hotkeys.ts and the bundled model-hotkeys.json.
 *
 * The key guarantee: a machine with no local `model-hotkeys.json` still gets
 * the hotkeys that ship with the plugin (the bundled copy at the package root).
 *
 * Run: node --experimental-strip-types --no-warnings --test test/model-hotkeys.test.ts
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseModelBindings, resolveHotkeysConfigPath } from "../extensions/shared/model-hotkeys.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundledFile = join(repoRoot, "model-hotkeys.json");

test("resolve: falls back to the bundled file when no local copy exists", () => {
	const dir = mkdtempSync(join(tmpdir(), "hotkeys-"));
	try {
		const user = join(dir, "model-hotkeys.json");
		const bundled = join(dir, "bundled.json");
		writeFileSync(bundled, "{}");

		assert.equal(resolveHotkeysConfigPath(user, bundled), bundled);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolve: a local copy wins over the bundled file", () => {
	const dir = mkdtempSync(join(tmpdir(), "hotkeys-"));
	try {
		const user = join(dir, "model-hotkeys.json");
		const bundled = join(dir, "bundled.json");
		writeFileSync(user, "{}");
		writeFileSync(bundled, "{}");

		assert.equal(resolveHotkeysConfigPath(user, bundled), user);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parse: accepts valid bindings and drops unknown label types", () => {
	const bindings = parseModelBindings(
		{
			"alt+1": { provider: "opencode", model: "mimo-v2.6-flash-free", label: "MiMo" },
			"alt+2": { provider: "opencode-go", model: "glm-5.3-flash", thinking: "high", label: 42 },
		},
		"test.json",
	);

	assert.deepEqual(bindings["alt+1"], {
		provider: "opencode",
		model: "mimo-v2.6-flash-free",
		thinking: undefined,
		label: "MiMo",
	});
	assert.equal(bindings["alt+2"].thinking, "high");
	assert.equal(bindings["alt+2"].label, undefined);
});

test("parse: rejects malformed bindings", () => {
	assert.throws(() => parseModelBindings([], "test.json"), /must contain an object/);
	assert.throws(() => parseModelBindings({ "alt+1": "x" }, "test.json"), /must be an object/);
	assert.throws(() => parseModelBindings({ "alt+1": { provider: "opencode" } }, "test.json"), /provider and model/);
	assert.throws(
		() => parseModelBindings({ "alt+1": { provider: "opencode", model: "m", thinking: "ultra" } }, "test.json"),
		/invalid thinking level/,
	);
});

test("bundled config ships alt+5 bound to opencode/mimo-v2.6-flash-free", () => {
	const bindings = parseModelBindings(JSON.parse(readFileSync(bundledFile, "utf8")), bundledFile);
	assert.deepEqual(bindings["alt+5"], {
		provider: "opencode",
		model: "mimo-v2.6-flash-free",
		thinking: undefined,
		label: "MiMo v2.6 Flash",
	});
});
