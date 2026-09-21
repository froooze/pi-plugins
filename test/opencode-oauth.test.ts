/**
 * Tests for extensions/shared/opencode-oauth.ts.
 *
 * Pin the device-flow wire format and credential projection shared with
 * OpenCode's own `console login`: origin-rooted verification URLs, the
 * `authorization_pending` / `slow_down` / denied classification, the
 * first-org selection, and that the access token is exposed as the provider
 * API key (Pi sends it as `Authorization: Bearer …`).
 *
 * Also pin console routing: the OAuth token must not go to `/zen`, so
 * `/api/config` is captured at login and `modifyModels` projects the catalog
 * onto the account's inference endpoint with its `x-opencode-org-id` header
 * and model whitelist (see `projectConsoleModels`).
 *
 * Run: node --experimental-strip-types --no-warnings --test test/opencode-oauth.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	OPENCODE_CONSOLE_URL,
	OPENCODE_GO_PROVIDER,
	OPENCODE_INFERENCE_BASE_URL,
	OPENCODE_OAUTH_CLIENT_ID,
	OPENCODE_ORG_HEADER,
	type OpenCodeCredential,
	apiFromProviderNpm,
	attemptFromResponse,
	createOpencodeOAuth,
	normalizeConsoleUrl,
	parseConsoleProjection,
	parseDeviceAuth,
	parseDeviceToken,
	projectConsoleModels,
	resolveVerificationUrl,
} from "../extensions/shared/opencode-oauth.ts";

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});

test("normalizeConsoleUrl strips trailing slashes, query, and hash", () => {
	assert.equal(normalizeConsoleUrl("https://opencode.ai/console/"), OPENCODE_CONSOLE_URL);
	assert.equal(normalizeConsoleUrl("https://opencode.ai/console?x=1#y"), OPENCODE_CONSOLE_URL);
	assert.equal(normalizeConsoleUrl("https://opencode.ai"), "https://opencode.ai");
});

test("resolveVerificationUrl roots relative urls and rejects non-http schemes", () => {
	assert.equal(
		resolveVerificationUrl(OPENCODE_CONSOLE_URL, "/console/device?user_code=ABCD-EFGH&client_id=opencode-cli"),
		"https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli",
	);
	assert.equal(
		resolveVerificationUrl(OPENCODE_CONSOLE_URL, "https://opencode.ai/console/device?user_code=X"),
		"https://opencode.ai/console/device?user_code=X",
	);
	assert.throws(() => resolveVerificationUrl(OPENCODE_CONSOLE_URL, "javascript:alert(1)"));
});

test("parseDeviceAuth accepts verification_uri_complete and clamps interval", () => {
	const device = parseDeviceAuth(OPENCODE_CONSOLE_URL, {
		device_code: "dev",
		user_code: "ABCD-EFGH",
		verification_uri_complete: "/console/device?user_code=ABCD-EFGH&client_id=opencode-cli",
		expires_in: 60,
		interval: 5,
	});
	assert.deepEqual(device, {
		deviceCode: "dev",
		userCode: "ABCD-EFGH",
		verificationUri: "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli",
		intervalSeconds: 5,
		expiresInSeconds: 60,
	});
});

test("parseDeviceAuth requires the mandatory fields", () => {
	assert.throws(() => parseDeviceAuth(OPENCODE_CONSOLE_URL, { user_code: "x" }));
	assert.throws(() => parseDeviceAuth(OPENCODE_CONSOLE_URL, { device_code: "d", user_code: "x", expires_in: 0 }));
});

test("parseDeviceToken reads the token triple", () => {
	assert.deepEqual(parseDeviceToken({ access_token: "a", refresh_token: "r", expires_in: 3600 }), {
		access: "a",
		refresh: "r",
		expiresInSeconds: 3600,
	});
});

test("attemptFromResponse classifies the RFC 8628 states", () => {
	assert.equal(attemptFromResponse(200, { access_token: "a", refresh_token: "r", expires_in: 1 }).status, "complete");
	assert.equal(attemptFromResponse(400, { error: "authorization_pending" }).status, "pending");
	assert.equal(attemptFromResponse(400, { error: "slow_down" }).status, "slow_down");
	const denied = attemptFromResponse(400, { error: "access_denied" });
	assert.equal(denied.status, "failed");
	assert.match(denied.message ?? "", /denied/);
	assert.equal(attemptFromResponse(500, {}).status, "failed");
});

/** Minimal `${console}/api/config` body: one managed `opencode` provider. */
const consoleConfig = {
	config: {
		provider: {
			opencode: {
				name: "Default / OpenCode",
				npm: "@ai-sdk/openai-compatible",
				api: "https://opencode.ai/inference/openai/v1",
				env: ["OPENCODE_CONSOLE_TOKEN"],
				options: { apiKey: "{env:OPENCODE_CONSOLE_TOKEN}", headers: { [OPENCODE_ORG_HEADER]: "org-b" } },
				whitelist: ["deepseek-v4.1-flash", "glm-5.3-flash"],
			},
		},
	},
};

function deviceFetch(calls: string[]): typeof fetch {
	return async (input) => {
		const url = typeof input === "string" ? input : input.url;
		calls.push(url);
		if (url.endsWith("/auth/device/code")) {
			return json({
				device_code: "dev",
				user_code: "ABCD-EFGH",
				verification_uri_complete: "/console/device?user_code=ABCD-EFGH&client_id=opencode-cli",
				expires_in: 60,
				interval: 5,
			});
		}
		if (url.endsWith("/auth/device/token")) {
			return json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 });
		}
		if (url.endsWith("/api/user")) return json({ id: "user-1", email: "dev@example.com" });
		if (url.endsWith("/api/orgs")) {
			return json([
				{ id: "org-b", name: "Beta" },
				{ id: "org-a", name: "Alpha" },
			]);
		}
		if (url.endsWith("/api/config")) return json(consoleConfig);
		return new Response("not found", { status: 404 });
	};
}

test("login performs the device flow and projects the credential", async () => {
	const calls: string[] = [];
	const oauth = createOpencodeOAuth({ fetch: deviceFetch(calls) });
	const authEvents: unknown[] = [];
	const deviceEvents: unknown[] = [];
	const credential = await oauth.login({
		signal: new AbortController().signal,
		onAuth: (info) => authEvents.push(info),
		onDeviceCode: (info) => deviceEvents.push(info),
		onPrompt: async () => "",
		onSelect: async () => undefined,
	});

	assert.equal(credential.access, "access-1");
	assert.equal(credential.refresh, "refresh-1");
	assert.equal(credential.server, OPENCODE_CONSOLE_URL);
	assert.equal(credential.accountID, "user-1");
	assert.equal(credential.email, "dev@example.com");
	assert.equal(credential.orgID, "org-b", "first org as returned by the API");
	assert.equal(credential.orgName, "Beta");
	assert.ok(typeof credential.expires === "number" && credential.expires > Date.now());
	assert.equal(oauth.getApiKey(credential), "access-1");
	assert.deepEqual(credential.console, {
		apiUrl: OPENCODE_INFERENCE_BASE_URL,
		headers: { [OPENCODE_ORG_HEADER]: "org-b" },
		models: ["deepseek-v4.1-flash", "glm-5.3-flash"],
	});

	assert.equal(authEvents.length, 1);
	const auth = authEvents[0] as { url: string; instructions?: string };
	assert.match(auth.url, /user_code=ABCD-EFGH/);
	assert.match(auth.instructions ?? "", /ABCD-EFGH/);

	assert.deepEqual(deviceEvents, [
		{
			userCode: "ABCD-EFGH",
			verificationUri: "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli",
			intervalSeconds: 5,
			expiresInSeconds: 60,
		},
	]);

	assert.deepEqual(calls.slice(0, 2), [
		`${OPENCODE_CONSOLE_URL}/auth/device/code`,
		`${OPENCODE_CONSOLE_URL}/auth/device/token`,
	]);
});

test("login sends the public opencode-cli client id", async () => {
	let deviceBody: unknown;
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input.url;
		if (url.endsWith("/auth/device/code")) {
			deviceBody = JSON.parse(String(init?.body));
			return json({
				device_code: "d",
				user_code: "u",
				verification_uri: "https://opencode.ai/console/device",
				expires_in: 60,
				interval: 5,
			});
		}
		if (url.endsWith("/auth/device/token")) {
			return json({ access_token: "a", refresh_token: "r", expires_in: 1 });
		}
		return json({}, 404);
	};
	const oauth = createOpencodeOAuth({ fetch: fetchImpl });
	await oauth.login({
		signal: new AbortController().signal,
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onSelect: async () => undefined,
	});
	assert.deepEqual(deviceBody, { client_id: OPENCODE_OAUTH_CLIENT_ID });
});

test("refreshToken rotates the stored credential", async () => {
	const fetchImpl: typeof fetch = async (input) => {
		const url = typeof input === "string" ? input : input.url;
		if (url.endsWith("/auth/device/token")) {
			return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 });
		}
		return json({}, 404);
	};
	const oauth = createOpencodeOAuth({ fetch: fetchImpl });
	const original = {
		access: "access-1",
		refresh: "refresh-1",
		expires: Date.now() - 1,
		server: OPENCODE_CONSOLE_URL,
		accountID: "user-1",
	};
	const refreshed = await oauth.refreshToken(original, new AbortController().signal);
	assert.equal(refreshed.access, "access-2");
	assert.equal(refreshed.refresh, "refresh-2");
	assert.equal(refreshed.accountID, "user-1", "metadata is preserved");
	assert.ok(refreshed.expires > Date.now());
});

// ---------------------------------------------------------------------------
// Cross-provider adoption (opencode-go shares the opencode console account)
// ---------------------------------------------------------------------------

const noopCallbacks = (events: unknown[] = []) => ({
	signal: new AbortController().signal,
	onAuth: (info: unknown) => events.push(info),
	onDeviceCode: () => {},
	onPrompt: async () => "",
	onSelect: async () => undefined,
});

test("opencode-go login adopts the sibling opencode credential without fetching", async () => {
	const calls: string[] = [];
	const fetchImpl: typeof fetch = async (input) => {
		calls.push(typeof input === "string" ? input : input.url);
		return new Response("unexpected", { status: 500 });
	};
	const sibling = {
		access: "access-1",
		refresh: "refresh-1",
		expires: Date.now() + 3_600_000,
		server: OPENCODE_CONSOLE_URL,
		accountID: "user-1",
	};
	const oauth = createOpencodeOAuth({
		provider: OPENCODE_GO_PROVIDER,
		fetch: fetchImpl,
		readSibling: () => sibling,
	});
	const credential = await oauth.login(noopCallbacks());
	assert.equal(credential.access, "access-1");
	assert.equal(credential.refresh, "refresh-1");
	assert.equal(calls.length, 0, "adoption must not hit the network");
});

test("opencode login ignores a sibling and runs the device flow", async () => {
	const calls: string[] = [];
	const oauth = createOpencodeOAuth({
		provider: "opencode",
		fetch: deviceFetch(calls),
		readSibling: () => ({
			access: "sibling",
			refresh: "sibling",
			expires: Date.now() + 3_600_000,
		}),
	});
	const credential = await oauth.login(noopCallbacks());
	assert.equal(credential.access, "access-1", "fresh device-flow token wins");
	assert.ok(calls.some((url) => url.endsWith("/auth/device/code")));
});

test("refreshToken adopts a fresher sibling instead of replaying a rotated token", async () => {
	const calls: string[] = [];
	const fetchImpl: typeof fetch = async (input) => {
		calls.push(typeof input === "string" ? input : input.url);
		return json({ access_token: "access-own", refresh_token: "refresh-own", expires_in: 3600 });
	};
	const oauth = createOpencodeOAuth({
		fetch: fetchImpl,
		readSibling: () => ({ access: "access-2", refresh: "refresh-2", expires: Date.now() + 7_200_000 }),
	});
	const original = { access: "access-1", refresh: "refresh-1", expires: Date.now() + 1_000_000 };
	const refreshed = await oauth.refreshToken(original, new AbortController().signal);
	assert.equal(refreshed.access, "access-2");
	assert.equal(refreshed.refresh, "refresh-2");
	assert.equal(calls.length, 0, "adoption must not hit the network");
});

test("refreshToken refreshes when the sibling is not fresher", async () => {
	const fetchImpl: typeof fetch = async () =>
		json({ access_token: "access-own", refresh_token: "refresh-own", expires_in: 3600 });
	const oauth = createOpencodeOAuth({
		fetch: fetchImpl,
		readSibling: () => ({ access: "access-2", refresh: "refresh-2", expires: Date.now() + 1_000_000 }),
	});
	const original = { access: "access-1", refresh: "refresh-1", expires: Date.now() + 2_000_000 };
	const refreshed = await oauth.refreshToken(original, new AbortController().signal);
	assert.equal(refreshed.access, "access-own");
});

// ---------------------------------------------------------------------------
// Console routing (OAuth token -> inference endpoint + org header)
// ---------------------------------------------------------------------------

const model = (id: string, overrides: Record<string, unknown> = {}) =>
	({
		provider: "opencode",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://opencode.ai/zen/v1",
		contextWindow: 1000,
		maxTokens: 100,
		...overrides,
	}) as unknown as Model<Api>;

test("parseConsoleProjection reads api, org header, and whitelist", () => {
	assert.deepEqual(parseConsoleProjection(consoleConfig), {
		apiUrl: OPENCODE_INFERENCE_BASE_URL,
		headers: { [OPENCODE_ORG_HEADER]: "org-b" },
		models: ["deepseek-v4.1-flash", "glm-5.3-flash"],
	});
	assert.equal(parseConsoleProjection({}), undefined);
	assert.equal(parseConsoleProjection({ config: { provider: { opencode: { name: "x" } } } }), undefined);
});

test("apiFromProviderNpm maps OpenCode SDK packages to Pi APIs", () => {
	assert.equal(apiFromProviderNpm("@ai-sdk/openai"), "openai-responses");
	assert.equal(apiFromProviderNpm("@ai-sdk/azure"), "openai-responses");
	assert.equal(apiFromProviderNpm("@ai-sdk/openai-compatible"), "openai-completions");
	assert.equal(apiFromProviderNpm("@ai-sdk/anthropic"), "anthropic-messages");
	assert.equal(apiFromProviderNpm("@ai-sdk/google"), "google-generative-ai");
	assert.equal(apiFromProviderNpm("@openrouter/ai-sdk-provider"), undefined);
	assert.equal(apiFromProviderNpm(undefined), undefined);
});

test("parseConsoleProjection captures per-model provider routing", () => {
	const projection = parseConsoleProjection({
		config: {
			provider: {
				opencode: {
					api: OPENCODE_INFERENCE_BASE_URL,
					npm: "@ai-sdk/openai-compatible",
					options: { headers: { [OPENCODE_ORG_HEADER]: "org-b" } },
					whitelist: ["mimo-v2.5-free", "muse-spark-1.3-contributor-free", "claude-fable-5"],
					models: {
						"mimo-v2.5-free": { name: "MiMo" },
						"muse-spark-1.3-contributor-free": { provider: { npm: "@ai-sdk/openai" } },
						"claude-fable-5": {
							provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" },
						},
					},
				},
			},
		},
	});
	assert.deepEqual(projection?.modelRoutes, {
		"muse-spark-1.3-contributor-free": { api: "openai-responses" },
		"claude-fable-5": {
			api: "anthropic-messages",
			apiUrl: "https://opencode.ai/inference/anthropic/v1",
		},
	});
	assert.equal(projection?.api, undefined, "openai-compatible is the implicit default");
});

test("projectConsoleModels routes openai() models to the Responses API", () => {
	const credential: OpenCodeCredential = {
		access: "a",
		refresh: "r",
		expires: Date.now() + 1000,
		console: {
			apiUrl: OPENCODE_INFERENCE_BASE_URL,
			headers: { [OPENCODE_ORG_HEADER]: "org-1" },
			models: ["mimo-v2.5-free", "muse-spark-1.3-contributor-free"],
			modelRoutes: { "muse-spark-1.3-contributor-free": { api: "openai-responses" } },
		},
	};
	const projected = projectConsoleModels(
		[model("mimo-v2.5-free"), model("muse-spark-1.3-contributor-free")],
		credential,
	);
	const [mimo, muse] = projected;
	assert.equal(mimo!.api, "openai-completions");
	assert.equal(mimo!.baseUrl, OPENCODE_INFERENCE_BASE_URL);
	assert.equal(muse!.api, "openai-responses");
	assert.equal(muse!.baseUrl, OPENCODE_INFERENCE_BASE_URL);
	assert.equal(muse!.headers?.[OPENCODE_ORG_HEADER], "org-1");
});

test("projectConsoleModels uses a per-model apiUrl override", () => {
	const credential: OpenCodeCredential = {
		access: "a",
		refresh: "r",
		expires: Date.now() + 1000,
		console: {
			apiUrl: OPENCODE_INFERENCE_BASE_URL,
			headers: {},
			models: ["claude-fable-5"],
			modelRoutes: {
				"claude-fable-5": { api: "anthropic-messages", apiUrl: "https://opencode.ai/inference/anthropic/v1" },
			},
		},
	};
	const projected = projectConsoleModels([model("claude-fable-5")], credential);
	assert.equal(projected[0]!.api, "anthropic-messages");
	assert.equal(projected[0]!.baseUrl, "https://opencode.ai/inference/anthropic/v1");
});

test("parseConsoleProjection falls back to the first provider with an api", () => {
	assert.deepEqual(parseConsoleProjection({ config: { provider: { custom: { api: "https://x/inference" } } } }), {
		apiUrl: "https://x/inference",
		headers: {},
		models: [],
	});
});

test("projectConsoleModels rewrites api, baseUrl, headers and filters the whitelist", () => {
	const credential: OpenCodeCredential = {
		access: "a",
		refresh: "r",
		expires: Date.now() + 1000,
		console: {
			apiUrl: OPENCODE_INFERENCE_BASE_URL,
			headers: { [OPENCODE_ORG_HEADER]: "org-1" },
			models: ["keep"],
		},
	};
	const projected = projectConsoleModels([model("keep"), model("drop")], credential);
	assert.equal(projected.length, 1);
	assert.equal(projected[0]!.id, "keep");
	assert.equal(projected[0]!.api, "openai-completions");
	assert.equal(projected[0]!.baseUrl, OPENCODE_INFERENCE_BASE_URL);
	assert.equal(projected[0]!.headers?.[OPENCODE_ORG_HEADER], "org-1");
});

test("projectConsoleModels derives the org header and keeps all models without a whitelist", () => {
	const credential: OpenCodeCredential = { access: "a", refresh: "r", expires: Date.now() + 1000, orgID: "org-9" };
	const projected = projectConsoleModels([model("a"), model("b")], credential);
	assert.equal(projected.length, 2);
	assert.equal(projected[0]!.baseUrl, OPENCODE_INFERENCE_BASE_URL);
	assert.equal(projected[0]!.headers?.[OPENCODE_ORG_HEADER], "org-9");
});

test("modifyModels projects the catalog through the OAuth config", () => {
	const oauth = createOpencodeOAuth();
	const credential: OpenCodeCredential = { access: "a", refresh: "r", expires: Date.now() + 1000, orgID: "org-7" };
	const projected = oauth.modifyModels!([model("a")], credential);
	assert.equal(projected[0]!.baseUrl, OPENCODE_INFERENCE_BASE_URL);
	assert.equal(projected[0]!.headers?.[OPENCODE_ORG_HEADER], "org-7");
});
