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

import piUpgrade, { parseOptions } from "../extensions/pi-upgrade.ts";

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

test("--help is recognized", () => {
	assert.equal(parseOptions("--help").help, true);
	assert.equal(parseOptions("-h").help, true);
});

test("unknown options are rejected", () => {
	assert.throws(() => parseOptions("--bogus"), /unknown option: --bogus/);
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
	assert.ok(values.includes("--check"));
});
