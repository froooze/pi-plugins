/**
 * Tests for extensions/opencode-session-id.ts.
 *
 * The extension wraps a ModelRuntime's one-shot completion entry points so that
 * extension-initiated calls (compaction, handoff, other one-shots) forward
 * Pi's session id, which
 * OpenCode / OpenCode Go turn into the `x-opencode-session` routing header.
 * These tests pin: injection only for the OpenCode family, caller-supplied ids
 * win, streaming entry points are untouched, the wrapper follows a session
 * change without re-wrapping, and the Zen identity spoof follows
 * `PI_OPENCODE_SPOOF_SCOPE` (`auto`: free always, paid under OAuth) while the
 * free-tier body spoof (gate tools + `toolChoice: "none"`) stays behind the
 * `PI_OPENCODE_ZEN_SPOOF` opt-in.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/opencode-session-id.test.ts
 */
import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import opencodeSessionId from "../extensions/opencode-session-id.ts";

// Pin the spoofed User-Agent so the Zen tests never spawn `opencode --version`.
process.env.PI_OPENCODE_SPOOF_VERSION = "1.20.0";

afterEach(() => {
	delete process.env.PI_OPENCODE_ZEN_SPOOF;
	delete process.env.PI_OPENCODE_SPOOF_SCOPE;
});

type Call = { method: string; model: unknown; context: unknown; options: unknown };

function makeRuntime() {
	const calls: Call[] = [];
	const record = (method: string) => (model: unknown, context: unknown, options?: unknown) => {
		calls.push({ method, model, context, options });
		return Promise.resolve("ok");
	};
	const runtime = {
		completeSimple: record("completeSimple"),
		complete: record("complete"),
		streamSimple() {
			calls.push({ method: "streamSimple", model: undefined, context: undefined, options: undefined });
			return "stream";
		},
	};
	return { runtime, calls };
}

function makePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	return {
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(event, handler);
		},
		fire(event: string, ctx: unknown) {
			handlers.get(event)!({}, ctx);
		},
	};
}

function makeCtx(runtime: unknown, sessionId: string, usingOAuth = false) {
	return {
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: { runtime, isUsingOAuth: () => usingOAuth },
	};
}

const opencodeGo = { provider: "opencode-go", id: "kimi-k2.6", baseUrl: "https://opencode.ai/zen/go" } as unknown as Model<Api>;
const opencodeZenPaid = {
	provider: "opencode",
	id: "claude-sonnet-4",
	baseUrl: "https://opencode.ai/zen",
	cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<Api>;
const opencodeZenFree = {
	provider: "opencode",
	id: "big-pickle",
	name: "Big Pickle",
	baseUrl: "https://opencode.ai/zen",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<Api>;
const anthropic = { provider: "anthropic", id: "claude", baseUrl: "https://api.anthropic.com" } as unknown as Model<Api>;

function install(runtime: unknown, sessionId = "sess-1", usingOAuth = false) {
	const pi = makePi();
	opencodeSessionId(pi as never);
	pi.fire("session_start", makeCtx(runtime, sessionId, usingOAuth));
	return pi;
}

test("injects the session id for opencode-go when the caller omitted it", () => {
	const { runtime, calls } = makeRuntime();
	install(runtime);
	return runtime.completeSimple(opencodeGo, {}, undefined).then(() => {
		assert.deepEqual(calls[0]?.options, { sessionId: "sess-1" });
	});
});

test("injects for an opencode baseUrl host even on an unknown provider id", () => {
	const { runtime, calls } = makeRuntime();
	install(runtime);
	return runtime.completeSimple(opencodeZenPaid, {}, { signal: "s" }).then(() => {
		assert.deepEqual(calls[0]?.options, { signal: "s", sessionId: "sess-1" });
	});
});

test("keeps a caller-supplied session id", () => {
	const { runtime, calls } = makeRuntime();
	install(runtime);
	return runtime.completeSimple(opencodeGo, {}, { sessionId: "caller" }).then(() => {
		assert.deepEqual(calls[0]?.options, { sessionId: "caller" });
	});
});

test("leaves non-opencode models untouched", () => {
	const { runtime, calls } = makeRuntime();
	install(runtime);
	return runtime.completeSimple(anthropic, {}, undefined).then(() => {
		assert.equal(calls[0]?.options, undefined);
	});
});

test("wraps complete() too", () => {
	const { runtime, calls } = makeRuntime();
	install(runtime);
	return runtime.complete(opencodeGo, {}, undefined).then(() => {
		assert.deepEqual(calls[0]?.options, { sessionId: "sess-1" });
	});
});

test("does not wrap streaming entry points", () => {
	const { runtime, calls } = makeRuntime();
	install(runtime);
	assert.equal(runtime.streamSimple(opencodeGo, {}, undefined), "stream");
	assert.equal(calls[0]?.method, "streamSimple");
});

test("follows a session change without wrapping twice", async () => {
	const { runtime, calls } = makeRuntime();
	const pi = install(runtime, "sess-1");
	pi.fire("session_start", makeCtx(runtime, "sess-2")); // e.g. /new or /reload

	await runtime.completeSimple(opencodeGo, {}, undefined);
	await runtime.completeSimple(opencodeGo, {}, undefined);

	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0]?.options, { sessionId: "sess-2" });
	assert.deepEqual(calls[1]?.options, { sessionId: "sess-2" });
});

// ---------------------------------------------------------------------------
// Opt-in Zen spoof
// ---------------------------------------------------------------------------

test("free Zen one-shots get the identity by default but no body spoof", async () => {
	const { runtime, calls } = makeRuntime();
	install(runtime);
	await runtime.completeSimple(opencodeZenFree, {}, { signal: "s" });

	const options = calls[0]?.options as Record<string, unknown>;
	const headers = options.headers as Record<string, string>;
	assert.equal(options.signal, "s");
	assert.equal(headers["x-opencode-client"], "cli");
	assert.match(headers["x-opencode-session"]!, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	assert.match(headers["x-opencode-request"]!, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	assert.match(headers["x-opencode-project"]!, /^([0-9a-f]{40}|global)$/);
	assert.equal(options.toolChoice, undefined);
	assert.deepEqual(calls[0]?.context, {});
});

test("paid Zen and Go one-shots get the shared identity under OAuth", async () => {
	const { runtime, calls } = makeRuntime();
	install(runtime, "sess-1", true);
	await runtime.completeSimple(opencodeZenPaid, { messages: [], tools: [{ name: "read" }] }, undefined);
	await runtime.completeSimple(opencodeGo, { messages: [], tools: [] }, undefined);

	for (const call of calls) {
		const options = call.options as Record<string, unknown>;
		const headers = options.headers as Record<string, string>;
		assert.equal(headers["x-opencode-client"], "cli");
		assert.match(headers["x-opencode-request"]!, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		assert.match(headers["x-opencode-project"]!, /^([0-9a-f]{40}|global)$/);
		assert.equal(options.toolChoice, undefined, "no body gate for paid providers");
	}
});

test("Zen spoof injects identity + gate tools + toolChoice none when enabled", async () => {
	process.env.PI_OPENCODE_ZEN_SPOOF = "1";
	const { runtime, calls } = makeRuntime();
	install(runtime);
	await runtime.completeSimple(opencodeZenFree, { systemPrompt: "s", messages: [], tools: [] }, { signal: "s" });

	const options = calls[0]?.options as Record<string, unknown>;
	const headers = options.headers as Record<string, string>;
	assert.equal(headers["User-Agent"], "opencode/1.20.0");
	assert.equal(headers["x-opencode-client"], "cli");
	assert.match(headers["x-opencode-session"]!, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	assert.equal(options.sessionId, headers["x-opencode-session"]);
	assert.equal(options.toolChoice, "none");

	const tools = (calls[0]?.context as { tools: Array<{ name: string }> }).tools;
	assert.deepEqual(
		tools.map((t) => t.name),
		["bash", "glob", "grep", "read"],
	);
});

test("Zen spoof leaves paid Zen and opencode-go alone without OAuth", async () => {
	process.env.PI_OPENCODE_ZEN_SPOOF = "1";
	const { runtime, calls } = makeRuntime();
	install(runtime);
	await runtime.completeSimple(opencodeZenPaid, { messages: [], tools: [] }, undefined);
	await runtime.completeSimple(opencodeGo, { messages: [], tools: [] }, undefined);

	assert.deepEqual(calls[0]?.options, { sessionId: "sess-1" });
	assert.deepEqual(calls[1]?.options, { sessionId: "sess-1" });
	assert.equal((calls[0]?.context as { tools: unknown[] }).tools.length, 0);
});

test("Zen spoof does not override caller tools or an explicit toolChoice", async () => {
	process.env.PI_OPENCODE_ZEN_SPOOF = "1";
	const { runtime, calls } = makeRuntime();
	install(runtime);
	const context = { messages: [], tools: [{ name: "read", description: "r", parameters: {} }] };
	await runtime.completeSimple(opencodeZenFree, context, { toolChoice: "auto" });

	const options = calls[0]?.options as Record<string, unknown>;
	assert.equal((calls[0]?.context as { tools: unknown[] }).tools.length, 1);
	assert.equal(options.toolChoice, "auto");
	assert.equal((options.headers as Record<string, string>)["x-opencode-client"], "cli");
});
