/**
 * Tests for extensions/exit.ts — `/exit` as an alias for Pi's built-in `/quit`.
 *
 * The guarantee: `/exit` registers a command named `exit` whose handler calls
 * `ctx.shutdown()` (the same hook `/quit` uses), so no core fork change is
 * needed.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/exit.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { EXIT_COMMAND, handleExit, registerExit } from "../extensions/exit.ts";

interface CapturedCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function fakePi(): { pi: ExtensionAPI; registered: CapturedCommand[] } {
	const registered: CapturedCommand[] = [];
	const pi = {
		registerCommand: (name: string, options: Omit<CapturedCommand, "name">) => {
			registered.push({ name, ...options });
		},
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

test("registers a command named 'exit' with a description", () => {
	const { pi, registered } = fakePi();
	registerExit(pi);

	assert.equal(registered.length, 1);
	assert.equal(registered[0]!.name, EXIT_COMMAND);
	assert.equal(EXIT_COMMAND, "exit");
	assert.match(registered[0]!.description ?? "", /quit/i);
});

test("the registered handler calls ctx.shutdown() exactly once", async () => {
	const { pi, registered } = fakePi();
	registerExit(pi);

	let calls = 0;
	const ctx = { shutdown: () => calls++ } as unknown as ExtensionCommandContext;
	await registered[0]!.handler("", ctx);

	assert.equal(calls, 1);
});

test("handleExit ignores arguments and shuts down", async () => {
	let calls = 0;
	const ctx = { shutdown: () => calls++ } as unknown as ExtensionCommandContext;

	await handleExit(ctx);

	assert.equal(calls, 1);
});
