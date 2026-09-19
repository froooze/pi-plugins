/**
 * Tests for extensions/shared/opencode-zen.ts.
 *
 * These pin the identity primitives both OpenCode spoof extensions depend on:
 * the well-formed `ses_…` id shape (the free-tier gate rejects anything else),
 * the pi→zen session-id memo, and free-model detection (the `-free` name
 * heuristic plus the zero-cost catch-all).
 *
 * Run: node --experimental-strip-types --no-warnings --test test/opencode-zen.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createOpencodeSessionId,
	isAtLeast,
	isFreeModel,
	isFreeOpencodeModel,
	isOpencodeHost,
	isOpencodeModel,
	opencodeSessionId,
	parseVersion,
} from "../extensions/shared/opencode-zen.ts";

const SES_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function model(overrides: Record<string, unknown>): Model<Api> {
	return { provider: "opencode", id: "m", name: "M", baseUrl: "https://opencode.ai/zen", ...overrides } as unknown as Model<Api>;
}

test("createOpencodeSessionId emits the ses_<12hex><14base62> shape", () => {
	assert.match(createOpencodeSessionId(), SES_ID);
});

test("createOpencodeSessionId is unique per call", () => {
	assert.notEqual(createOpencodeSessionId(), createOpencodeSessionId());
});

test("opencodeSessionId memoizes per Pi session id", () => {
	const a = opencodeSessionId("sess-a");
	assert.match(a, SES_ID);
	assert.equal(opencodeSessionId("sess-a"), a);
	assert.notEqual(opencodeSessionId("sess-b"), a);
});

test("opencodeSessionId still returns a shaped id without a Pi session id", () => {
	assert.match(opencodeSessionId(undefined), SES_ID);
});

test("isFreeModel prefers the -free marker, then zero cost", () => {
	assert.equal(isFreeModel(model({ id: "grok-free" })), true);
	assert.equal(isFreeModel(model({ name: "Something Free" })), true);
	assert.equal(isFreeModel(model({ cost: { input: 0, output: 0 } })), true);
	assert.equal(isFreeModel(model({ cost: { input: 1, output: 0 } })), false);
	assert.equal(isFreeModel(model({})), false);
});

test("isFreeOpencodeModel is Zen-only and requires free", () => {
	assert.equal(isFreeOpencodeModel(model({ id: "big-pickle", cost: { input: 0, output: 0 } })), true);
	assert.equal(isFreeOpencodeModel(model({ cost: { input: 3, output: 15 } })), false);
	assert.equal(
		isFreeOpencodeModel(model({ provider: "opencode-go", id: "big-pickle", cost: { input: 0, output: 0 } })),
		false,
	);
	assert.equal(isFreeOpencodeModel(undefined), false);
});

test("isOpencodeModel covers both provider ids and the host", () => {
	assert.equal(isOpencodeModel(model({ provider: "opencode" })), true);
	assert.equal(isOpencodeModel(model({ provider: "opencode-go" })), true);
	assert.equal(isOpencodeModel(model({ provider: "custom", baseUrl: "https://opencode.ai/zen" })), true);
	assert.equal(isOpencodeModel(model({ provider: "anthropic", baseUrl: "https://api.anthropic.com" })), false);
	assert.equal(isOpencodeModel(undefined), false);
});

test("isOpencodeHost rejects malformed urls", () => {
	assert.equal(isOpencodeHost("https://opencode.ai/zen"), true);
	assert.equal(isOpencodeHost("not a url"), false);
});

test("parseVersion + isAtLeast gate the User-Agent override", () => {
	assert.deepEqual(parseVersion("opencode 1.18.31"), [1, 18, 31]);
	assert.equal(parseVersion("nope"), undefined);
	assert.equal(isAtLeast([1, 17, 0], [1, 17, 0]), true);
	assert.equal(isAtLeast([1, 18, 0], [1, 17, 0]), true);
	assert.equal(isAtLeast([1, 16, 99], [1, 17, 0]), false);
});
