/**
 * Tests for /pi-upgrade's option handling and command registration.
 *
 * Focus is the extension-update half added to the command: the new
 * `--no-extensions` opt-out must parse, be offered as a completion, and not
 * disturb the existing flags. The pi checkout sync itself is integration
 * territory (git + npm) and is not exercised here.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/pi-upgrade.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import piUpgrade, { npmInvocation, parseOptions } from "../extensions/pi-upgrade.ts";

test("parses the existing flags", () => {
	assert.deepEqual(parseOptions("--check --offline --force"), {
		check: true,
		offline: true,
		force: true,
	});
});

test("--no-extensions disables the extension half", () => {
	assert.equal(parseOptions("--no-extensions").extensions, false);
});

test("--extensions re-enables it after --no-extensions (last wins)", () => {
	assert.equal(parseOptions("--no-extensions --extensions").extensions, true);
});

test("no flag leaves extensions unset (default-on)", () => {
	assert.equal(parseOptions("").extensions, undefined);
});

test("--no-pins disables the bundled-fork bump", () => {
	assert.equal(parseOptions("--no-pins").pins, false);
});

test("no flag leaves pins unset (default-on)", () => {
	assert.equal(parseOptions("").pins, undefined);
});

test("--no-models disables the model-catalog refresh", () => {
	assert.equal(parseOptions("--no-models").models, false);
});

test("no flag leaves models unset (default-on)", () => {
	assert.equal(parseOptions("").models, undefined);
});

test("--help is recognized", () => {
	assert.equal(parseOptions("--help").help, true);
	assert.equal(parseOptions("-h").help, true);
});

test("unknown options are rejected", () => {
	assert.throws(() => parseOptions("--bogus"), /unknown option: --bogus/);
});

test("npmInvocation falls back to plain npm for unset/empty/blank config", () => {
	assert.deepEqual(npmInvocation(undefined), { command: "npm", args: [] });
	assert.deepEqual(npmInvocation([]), { command: "npm", args: [] });
	assert.deepEqual(npmInvocation(["  "]), { command: "npm", args: [] });
});

test("npmInvocation splits a configured runner (settings npmCommand)", () => {
	assert.deepEqual(npmInvocation(["mise", "exec", "node@20", "--", "npm"]), {
		command: "mise",
		args: ["exec", "node@20", "--", "npm"],
	});
	assert.deepEqual(npmInvocation(["npm"]), { command: "npm", args: [] });
});

test("registers /pi-upgrade with the extension-aware description and completions", () => {
	let captured: { description?: string; getArgumentCompletions?: (prefix: string) => unknown } | undefined;
	const fakePi = {
		registerCommand: (_name: string, config: typeof captured) => {
			captured = config;
		},
	};

	piUpgrade(fakePi as never);

	assert.ok(captured);
	assert.match(captured?.description ?? "", /extension/i);

	const completions = captured?.getArgumentCompletions?.("--") as Array<{ value: string }> | null;
	const values = (completions ?? []).map((entry) => entry.value);
	assert.ok(values.includes("--no-extensions"));
	assert.ok(values.includes("--no-pins"));
	assert.ok(values.includes("--no-models"));
	assert.ok(values.includes("--check"));
});
