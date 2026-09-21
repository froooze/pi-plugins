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

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createOpencodeMessageId,
	createOpencodeSessionId,
	isAtLeast,
	isFreeModel,
	isFreeOpencodeModel,
	isOpencodeHost,
	isOpencodeModel,
	opencodeSessionId,
	parseSpoofScope,
	parseVersion,
	resolveOpencodeProjectId,
	shouldSpoofOpencode,
} from "../extensions/shared/opencode-zen.ts";

const SES_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const MSG_ID = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

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

test("createOpencodeMessageId emits the ascending msg_<12hex><14base62> shape", () => {
	assert.match(createOpencodeMessageId(), MSG_ID);
	assert.notEqual(createOpencodeMessageId(), createOpencodeMessageId());
});

test("resolveOpencodeProjectId returns a git id for a repo and global elsewhere", () => {
	// The test process runs inside this git checkout: a remote hash or a root
	// commit (40 hex), never empty.
	assert.match(resolveOpencodeProjectId(process.cwd()), /^([0-9a-f]{40}|global)$/);
	const outside = mkdtempSync(join(tmpdir(), "opencode-project-"));
	assert.equal(resolveOpencodeProjectId(outside), "global");
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

test("parseSpoofScope defaults to auto and accepts synonyms", () => {
	assert.equal(parseSpoofScope(undefined), "auto");
	assert.equal(parseSpoofScope(""), "auto");
	assert.equal(parseSpoofScope("garbage"), "auto");
	assert.equal(parseSpoofScope("ALL"), "all");
	assert.equal(parseSpoofScope("on"), "all");
	assert.equal(parseSpoofScope("free"), "free");
	assert.equal(parseSpoofScope("off"), "off");
	assert.equal(parseSpoofScope(" false "), "off");
});

test("shouldSpoofOpencode keeps one identity per OAuth account", () => {
	const free = model({ id: "big-pickle", cost: { input: 0, output: 0 } });
	const paid = model({ id: "claude-opus-4-5", cost: { input: 10, output: 50 } });
	const go = model({ provider: "opencode-go", id: "free", cost: { input: 0, output: 0 } });

	// auto: free always; paid only under OAuth (no cli/pi flapping per account).
	assert.equal(shouldSpoofOpencode({ scope: "auto", model: free, usingOAuth: false }), true);
	assert.equal(shouldSpoofOpencode({ scope: "auto", model: free, usingOAuth: true }), true);
	assert.equal(shouldSpoofOpencode({ scope: "auto", model: paid, usingOAuth: false }), false);
	assert.equal(shouldSpoofOpencode({ scope: "auto", model: paid, usingOAuth: true }), true);

	// Go shares the console account: spoofed once OAuth, never for free-only.
	assert.equal(shouldSpoofOpencode({ scope: "auto", model: go, usingOAuth: false }), false);
	assert.equal(shouldSpoofOpencode({ scope: "auto", model: go, usingOAuth: true }), true);
	assert.equal(shouldSpoofOpencode({ scope: "free", model: go, usingOAuth: true }), false);

	// all / free / off override the model and auth state.
	assert.equal(shouldSpoofOpencode({ scope: "all", model: paid, usingOAuth: false }), true);
	assert.equal(shouldSpoofOpencode({ scope: "all", model: free, usingOAuth: false }), true);
	assert.equal(shouldSpoofOpencode({ scope: "all", model: go, usingOAuth: false }), true);
	assert.equal(shouldSpoofOpencode({ scope: "free", model: paid, usingOAuth: true }), false);
	assert.equal(shouldSpoofOpencode({ scope: "free", model: free, usingOAuth: true }), true);
	assert.equal(shouldSpoofOpencode({ scope: "off", model: free, usingOAuth: true }), false);
	assert.equal(shouldSpoofOpencode({ scope: "off", model: go, usingOAuth: true }), false);

	// Unknown providers and models are never spoofed.
	assert.equal(shouldSpoofOpencode({ scope: "all", model: undefined, usingOAuth: false }), false);
	assert.equal(
		shouldSpoofOpencode({ scope: "all", model: model({ provider: "anthropic" }), usingOAuth: true }),
		false,
	);
});
