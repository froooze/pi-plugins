/**
 * shared/opencode-oauth — OpenCode Console OAuth (RFC 8628 device flow).
 *
 * OpenCode's own client authenticates with the console account, not just a
 * static Zen API key. `opencode console login` runs a device authorization
 * against `https://opencode.ai/console` with the public `opencode-cli` client
 * id and stores the resulting OAuth access token; model requests then go to
 * the account's console inference endpoint (see "Routing" below), not `/zen`.
 * This module gives Pi the same login method so `/login opencode` offers OAuth
 * alongside the built-in API-key option. Pi's type selector labels them "Sign
 * in with an account" (OAuth, listed first) and "Sign in with an API key"; the
 * `name` below is used as the ambient-auth description.
 *
 * Flow (mirrors `packages/opencode/src/account/account.ts` and
 * `packages/core/src/plugin/provider/opencode.ts` in the OpenCode source):
 *
 *   1. POST {console}/auth/device/code   { client_id: "opencode-cli" }
 *      -> device_code, user_code, verification_uri_complete, interval, expires_in
 *   2. show/open verification_uri_complete and poll
 *   3. POST {console}/auth/device/token
 *      { grant_type: "urn:ietf:params:oauth:grant-type:device_code",
 *        device_code, client_id }
 *      -> access_token, refresh_token, token_type, expires_in
 *   4. GET {console}/api/user and {console}/api/orgs with the access token,
 *      keep the first org (matching `Account.poll`'s `remoteOrgs[0]`).
 *   5. GET {console}/api/config with the access token and `x-org-id: <orgID>`
 *      to capture where this account's models are served.
 *
 * Routing (why the endpoint in step 5 matters)
 * -------------------------------------------
 * A console OAuth access token (`st_…`) is **not** a Zen API key. OpenCode's
 * console proxy (`packages/console/app/src/lib/inference-proxy.ts`) accepts
 * `/zen` and `/zen/go` only for `oc_sk_…`/`sk-…` keys; an OAuth token sent
 * there is rejected with `401 {"type":"AuthError","message":"Invalid API key."}`.
 * OpenCode instead requests `${console}/api/config`, sets `OPENCODE_CONSOLE_TOKEN`
 * to the access token, and merges the remote provider config. Each provider
 * entry (`opencode`, `opencode-go`) carries its own `api` inference base
 * (`https://opencode.ai/inference/openai/v1` and `.../inference/go/openai/v1`)
 * and `options.headers` with `x-opencode-org-id`. Every model request is a
 * Bearer call to that provider's inference endpoint with the org header
 * (`packages/opencode/src/config/config.ts`).
 *
 * Pi's built-in `opencode`/`opencode-go` catalogs point at `/zen` and `/zen/go`,
 * so this module projects their models onto the account's console endpoint via
 * the legacy `oauth.modifyModels` hook: `api` -> `openai-completions`,
 * `baseUrl` -> the remote `provider.api`, and the remote headers (org id)
 * merged in. Each provider entry's model whitelist, when returned, filters that
 * provider's catalog.
 *
 * The access token is handed to Pi as the provider API key; openai-completions
 * sends it as `Authorization: Bearer …`. Tokens are rotated with the refresh
 * token via `refreshToken`.
 *
 * `opencode` (Zen) and `opencode-go` are the same console account, so this
 * module also registers for Go: its `login` adopts the Zen credential instead
 * of asking for a second consent, and both `refreshToken` implementations
 * adopt the sibling's credential when it is fresher, so a rotate-on-refresh
 * server cannot leave one provider replaying an invalidated refresh token.
 */
import type { Api, Model, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

/** Console origin used by `opencode console login` (`defaultConsoleUrl`). */
export const OPENCODE_CONSOLE_URL = "https://opencode.ai/console";

/** Fallback console inference base, used when `/api/config` gave none. */
export const OPENCODE_INFERENCE_BASE_URL = "https://opencode.ai/inference/openai/v1";

/** Fallback console inference base for `opencode-go`, used when `/api/config` gave none. */
export const OPENCODE_GO_INFERENCE_BASE_URL = "https://opencode.ai/inference/go/openai/v1";

/** Console workspace header the inference endpoint requires. */
export const OPENCODE_ORG_HEADER = "x-opencode-org-id";

/** Public device-flow client id hard-coded in the OpenCode CLI. */
export const OPENCODE_OAUTH_CLIENT_ID = "opencode-cli";

/** Label shown for the OAuth method in Pi's `/login` selector. */
export const OPENCODE_OAUTH_NAME = "OpenCode Console account";

/** Device-code grant type from RFC 8628 section 3.4. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MINIMUM_POLL_INTERVAL_MS = 1000;
const SLOW_DOWN_INCREMENT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15_000;

export type FetchLike = typeof fetch;

export interface OpenCodeDeviceAuth {
	deviceCode: string;
	userCode: string;
	/** Absolute verification URL, already resolved against the console origin. */
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds: number;
}

export interface OpenCodeToken {
	access: string;
	refresh: string;
	expiresInSeconds: number;
}

/** Per-model routing captured from `provider.<id>.models.<model>.provider`. */
export interface OpenCodeConsoleModelRoute {
	/** Pi API for the remote `provider.npm` (see {@link apiFromProviderNpm}). */
	api?: Api;
	/** Remote `provider.api` when the model overrides the provider endpoint. */
	apiUrl?: string;
}

/**
 * Model metadata captured from `provider.<id>.models.<model>`, normalized to the
 * fields Pi's catalog needs. Pi's built-in `opencode`/`opencode-go` catalogs lag
 * the console (a model can be entitled before it reaches the `pi.dev` catalog),
 * so these definitions let {@link projectConsoleModels} synthesize a
 * whitelist-only entry instead of dropping it.
 */
export interface OpenCodeConsoleModelDefinition {
	/** Display name (`models.<id>.name`); falls back to the id when absent. */
	name?: string;
	reasoning: boolean;
	/** `modalities.input` filtered to what Pi accepts; always includes `text`. */
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/**
 * Console inference routing captured from `${console}/api/config` at login.
 * OpenCode stores the access token in `OPENCODE_CONSOLE_TOKEN` and merges the
 * remote provider config, so the model endpoint, its headers, and the account's
 * model whitelist are all account-specific.
 */
export interface OpenCodeConsoleProjection {
	/**
	 * Console provider id this projection was read from (`opencode` or
	 * `opencode-go`). The two share one console account but expose different
	 * inference endpoints and whitelists, so a projection whose `provider`
	 * does not match the provider it is applied to is ignored and refreshed.
	 */
	provider?: string;
	/** Remote `provider.<id>.api` (e.g. `https://opencode.ai/inference/openai/v1`). */
	apiUrl: string;
	/** Remote `provider.<id>.options.headers` (carries `x-opencode-org-id`). */
	headers: Record<string, string>;
	/** Remote `provider.<id>.whitelist`; empty means "do not filter". */
	models: string[];
	/** Pi API for the provider's top-level `npm`; omitted for chat completions. */
	api?: Api;
	/** Per-model `provider.npm`/`provider.api` overrides, keyed by model id. */
	modelRoutes?: Record<string, OpenCodeConsoleModelRoute>;
	/**
	 * Normalized metadata for whitelisted models, keyed by model id, used to
	 * synthesize catalog entries for whitelist-only ids. Absent on projections
	 * captured before definitions were retained; {@link consoleProjectionStale}
	 * treats those as stale so they migrate on the next refresh.
	 */
	definitions?: Record<string, OpenCodeConsoleModelDefinition>;
	/**
	 * Unix ms of the last successful `/api/config` refresh. Entitlements move
	 * server-side, so the projection is re-read from `${console}/api/config`
	 * once this is older than {@link CONSOLE_PROJECTION_TTL_MS}; see
	 * {@link consoleProjectionStale}.
	 */
	checkedAt?: number;
}

/**
 * How long a stored console projection is trusted before a startup refetch.
 * The account's model whitelist and per-model routing change server-side, so a
 * projection that is never re-read would keep filtering out newly entitled
 * models (e.g. a free-tier swap) until the next re-login.
 */
export const CONSOLE_PROJECTION_TTL_MS = 24 * 60 * 60 * 1000;

/** Fallback context window for a synthesized model whose console `limit` is absent. */
const SYNTHETIC_FALLBACK_CONTEXT_WINDOW = 128_000;
/** Fallback max output for a synthesized model whose console `limit` is absent. */
const SYNTHETIC_FALLBACK_MAX_TOKENS = 32_768;

export interface OpenCodeCredential {
	access: string;
	refresh: string;
	expires: number;
	/** Set for console OAuth credentials; see {@link OpenCodeConsoleProjection}. */
	console?: OpenCodeConsoleProjection;
	[key: string]: unknown;
}

export interface OpenCodeOAuthOptions {
	/** Console origin; defaults to {@link OPENCODE_CONSOLE_URL}. */
	server?: string;
	/** Injected for tests. Defaults to the global `fetch`. */
	fetch?: FetchLike;
	/** Provider id this config is registered for. Defaults to `opencode`. */
	provider?: string;
	/**
	 * Read the sibling provider's stored OAuth credential. Used by
	 * `opencode-go` to adopt the account already logged in for `opencode`
	 * (no second consent) and by both to reconcile a rotated refresh token.
	 */
	readSibling?: () => OpenCodeCredential | undefined;
}

/** Console-auth account credential; `opencode-go` shares the `opencode` one. */
export const OPENCODE_GO_PROVIDER = "opencode-go";

/** Don't adopt a sibling token that is about to expire; refresh instead. */
const ADOPT_MIN_VALIDITY_MS = 60_000;

function readSiblingCredential(
	read: (() => OpenCodeCredential | undefined) | undefined,
): OpenCodeCredential | undefined {
	try {
		const sibling = read?.();
		if (
			sibling &&
			typeof sibling.access === "string" &&
			typeof sibling.refresh === "string" &&
			typeof sibling.expires === "number"
		) {
			return sibling;
		}
	} catch {
		// Corrupt/unreadable sibling: fall back to a fresh login/refresh.
	}
	return undefined;
}

/** Strip a trailing slash and any query/hash, matching OpenCode's `normalizeServerUrl`. */
export function normalizeConsoleUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`Invalid OpenCode console URL: ${input}`);
	}
	url.search = "";
	url.hash = "";
	const pathname = url.pathname.replace(/\/+$/, "");
	return pathname.length === 0 ? url.origin : `${url.origin}${pathname}`;
}

/**
 * Resolve `verification_uri_complete` (which OpenCode returns as an
 * origin-rooted path such as `/console/device?user_code=…`) against the
 * console origin. Rejects non-HTTP(S) URLs so a hostile server cannot make Pi
 * open an arbitrary scheme.
 */
export function resolveVerificationUrl(server: string, raw: string): string {
	let url: URL;
	try {
		url = new URL(raw, `${normalizeConsoleUrl(server)}/`);
	} catch {
		throw new Error("Invalid device verification URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Invalid device verification URL");
	}
	return url.href;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid OpenCode device response: missing ${key}`);
	}
	return value;
}

function positiveNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid OpenCode device response: missing ${key}`);
	}
	return value;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid OpenCode device response: expected an object");
	}
	return value as Record<string, unknown>;
}

/** Parse a `/auth/device/code` response. */
export function parseDeviceAuth(server: string, raw: unknown): OpenCodeDeviceAuth {
	const record = asRecord(raw);
	const rawVerification =
		typeof record.verification_uri_complete === "string" && record.verification_uri_complete.length > 0
			? record.verification_uri_complete
			: requiredString(record, "verification_uri");
	const interval = record.interval;
	return {
		deviceCode: requiredString(record, "device_code"),
		userCode: requiredString(record, "user_code"),
		verificationUri: resolveVerificationUrl(server, rawVerification),
		intervalSeconds: typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined,
		expiresInSeconds: positiveNumber(record, "expires_in"),
	};
}

/** Parse a successful `/auth/device/token` response. */
export function parseDeviceToken(raw: unknown): OpenCodeToken {
	const record = asRecord(raw);
	return {
		access: requiredString(record, "access_token"),
		refresh: requiredString(record, "refresh_token"),
		expiresInSeconds: positiveNumber(record, "expires_in"),
	};
}

interface PollAttempt {
	status: "complete" | "pending" | "slow_down" | "failed";
	token?: OpenCodeToken;
	intervalSeconds?: number;
	message?: string;
}

function classifyTokenError(error: string, description: string | undefined): PollAttempt {
	switch (error) {
		case "authorization_pending":
			return { status: "pending" };
		case "slow_down":
			return { status: "slow_down" };
		case "access_denied":
			return { status: "failed", message: "OpenCode device authorization was denied" };
		case "expired_token":
			return { status: "failed", message: "OpenCode device code expired" };
		default:
			return {
				status: "failed",
				message: `OpenCode device authorization failed: ${error}${description ? `: ${description}` : ""}`,
			};
	}
}

async function fetchJson(
	fetchImpl: FetchLike,
	url: string,
	init: RequestInit,
	signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	const response = await fetchImpl(url, { ...init, signal: requestSignal });
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	return { status: response.status, body };
}

async function requestDeviceCode(
	server: string,
	fetchImpl: FetchLike,
	signal: AbortSignal,
): Promise<OpenCodeDeviceAuth> {
	const { status, body } = await fetchJson(
		fetchImpl,
		`${server}/auth/device/code`,
		{
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: OPENCODE_OAUTH_CLIENT_ID }),
		},
		signal,
	);
	if (status < 200 || status >= 300) {
		throw new Error(`OpenCode device authorization failed (HTTP ${status})`);
	}
	return parseDeviceAuth(server, body);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Login cancelled"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function pollForToken(
	server: string,
	device: OpenCodeDeviceAuth,
	fetchImpl: FetchLike,
	signal: AbortSignal,
): Promise<OpenCodeToken> {
	const deadline = Date.now() + device.expiresInSeconds * 1000;
	let intervalMs = Math.max(
		MINIMUM_POLL_INTERVAL_MS,
		Math.floor((device.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000),
	);

	while (Date.now() < deadline) {
		if (signal.aborted) throw new Error("Login cancelled");
		const { status, body } = await fetchJson(
			fetchImpl,
			`${server}/auth/device/token`,
			{
				method: "POST",
				headers: { Accept: "application/json", "Content-Type": "application/json" },
				body: JSON.stringify({
					grant_type: DEVICE_CODE_GRANT_TYPE,
					device_code: device.deviceCode,
					client_id: OPENCODE_OAUTH_CLIENT_ID,
				}),
			},
			signal,
		);

		const attempt = attemptFromResponse(status, body);
		if (attempt.status === "complete" && attempt.token) return attempt.token;
		if (attempt.status === "failed") throw new Error(attempt.message ?? "OpenCode device authorization failed");
		if (attempt.status === "slow_down") {
			intervalMs =
				typeof attempt.intervalSeconds === "number" && attempt.intervalSeconds > 0
					? Math.max(MINIMUM_POLL_INTERVAL_MS, Math.floor(attempt.intervalSeconds * 1000))
					: intervalMs + SLOW_DOWN_INCREMENT_MS;
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await abortableSleep(Math.min(intervalMs, remaining), signal);
	}
	throw new Error("OpenCode device code expired");
}

/** Exposed for tests: interpret one device-token poll response. */
export function attemptFromResponse(status: number, raw: unknown): PollAttempt {
	const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
	// Classify the OAuth error body first: it is authoritative when present,
	// even if a server (unusually) returns it with a 2xx status.
	const error = typeof record?.error === "string" ? record.error : undefined;
	if (error) {
		const description =
			typeof record?.error_description === "string" ? record.error_description : undefined;
		return classifyTokenError(error, description);
	}
	if (status >= 200 && status < 300 && record) {
		try {
			return { status: "complete", token: parseDeviceToken(record) };
		} catch (parseError) {
			return {
				status: "failed",
				message: parseError instanceof Error ? parseError.message : String(parseError),
			};
		}
	}
	return { status: "failed", message: `OpenCode device token request failed (HTTP ${status})` };
}

async function fetchUserOrgs(
	server: string,
	access: string,
	fetchImpl: FetchLike,
	signal: AbortSignal,
): Promise<{ accountID?: string; email?: string; orgID?: string; orgName?: string }> {
	const headers = { Accept: "application/json", Authorization: `Bearer ${access}` };
	const [user, orgs] = await Promise.all([
		fetchJson(fetchImpl, `${server}/api/user`, { headers }, signal).catch(() => undefined),
		fetchJson(fetchImpl, `${server}/api/orgs`, { headers }, signal).catch(() => undefined),
	]);
	const userRecord =
		user?.body && typeof user.body === "object" && !Array.isArray(user.body)
			? (user.body as Record<string, unknown>)
			: undefined;
	const orgList = Array.isArray(orgs?.body) ? (orgs?.body as unknown[]) : [];
	// Upstream picks the first org exactly as the API returns it
	// (`Account.poll`: `remoteOrgs[0]`), no sorting.
	const org = orgList
		.map((entry) => {
			const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
			return {
				id: typeof record.id === "string" ? record.id : "",
				name: typeof record.name === "string" ? record.name : "",
			};
		})
		.find((candidate) => candidate.id.length > 0);
	return {
		accountID: typeof userRecord?.id === "string" ? userRecord.id : undefined,
		email: typeof userRecord?.email === "string" ? userRecord.email : undefined,
		orgID: org?.id,
		orgName: org?.name,
	};
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(recordOrUndefined(value) ?? {})) {
		if (typeof entry === "string") out[key] = entry;
	}
	return out;
}

/**
 * Map an OpenCode provider `npm` package to the Pi API that speaks the same
 * wire protocol. OpenCode routes each model through the SDK named by its
 * `provider.npm` (see `packages/opencode/src/session/llm/native-request.ts`):
 * `@ai-sdk/openai` uses the Responses API, `@ai-sdk/openai-compatible` uses
 * chat completions, `@ai-sdk/anthropic` uses Messages, and `@ai-sdk/google`
 * uses generateContent. Unknown packages return `undefined` so callers keep
 * their default.
 */
export function apiFromProviderNpm(npm: string | undefined): Api | undefined {
	switch (npm) {
		case "@ai-sdk/openai":
		case "@ai-sdk/azure":
			return "openai-responses";
		case "@ai-sdk/openai-compatible":
			return "openai-completions";
		case "@ai-sdk/anthropic":
			return "anthropic-messages";
		case "@ai-sdk/google":
			return "google-generative-ai";
		default:
			return undefined;
	}
}

/** Read per-model `provider.npm`/`provider.api` overrides from an `entry.models` map. */
function parseModelRoutes(value: unknown): Record<string, OpenCodeConsoleModelRoute> {
	const models = recordOrUndefined(value);
	if (!models) return {};
	const routes: Record<string, OpenCodeConsoleModelRoute> = {};
	for (const [id, model] of Object.entries(models)) {
		const provider = recordOrUndefined(recordOrUndefined(model)?.provider);
		if (!provider) continue;
		const api = apiFromProviderNpm(typeof provider.npm === "string" ? provider.npm : undefined);
		const apiUrl = typeof provider.api === "string" && provider.api.length > 0 ? provider.api : undefined;
		if (!api && !apiUrl) continue;
		routes[id] = { ...(api ? { api } : {}), ...(apiUrl ? { apiUrl } : {}) };
	}
	return routes;
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Normalize a `provider.<id>.models.<model>` entry to the fields Pi's catalog
 * needs. Missing fields fall back to conservative defaults so a whitelist-only
 * model still lists (the console entry always carries `limit` and `cost` today).
 */
function parseModelDefinition(value: unknown): OpenCodeConsoleModelDefinition {
	const model = recordOrUndefined(value) ?? {};
	const modalities = recordOrUndefined(model.modalities);
	const rawInput = Array.isArray(modalities?.input) ? modalities.input : [];
	const input: ("text" | "image")[] = [];
	if (rawInput.includes("text")) input.push("text");
	if (rawInput.includes("image")) input.push("image");
	if (input.length === 0) input.push("text");
	const cost = recordOrUndefined(model.cost);
	const limit = recordOrUndefined(model.limit);
	const contextWindow = Math.max(finiteNumber(limit?.context, SYNTHETIC_FALLBACK_CONTEXT_WINDOW), 1);
	const maxTokens = Math.max(finiteNumber(limit?.output, Math.min(contextWindow, SYNTHETIC_FALLBACK_MAX_TOKENS)), 1);
	return {
		...(typeof model.name === "string" && model.name.length > 0 ? { name: model.name } : {}),
		reasoning: model.reasoning === true,
		input,
		cost: {
			input: finiteNumber(cost?.input, 0),
			output: finiteNumber(cost?.output, 0),
			cacheRead: finiteNumber(cost?.cache_read, 0),
			cacheWrite: finiteNumber(cost?.cache_write, 0),
		},
		contextWindow,
		maxTokens,
	};
}

/**
 * Read normalized definitions for the whitelisted ids from an `entry.models`
 * map. Only entitled ids are retained (the remote map lists every model the
 * console knows); the rest would bloat auth.json for no benefit.
 */
function parseModelDefinitions(
	value: unknown,
	whitelist: readonly string[],
): Record<string, OpenCodeConsoleModelDefinition> {
	const models = recordOrUndefined(value);
	if (!models) return {};
	const definitions: Record<string, OpenCodeConsoleModelDefinition> = {};
	for (const id of whitelist) {
		const model = recordOrUndefined(models[id]);
		if (model) definitions[id] = parseModelDefinition(model);
	}
	return definitions;
}

/**
 * Parse `${console}/api/config` into the account's inference projection.
 *
 * The account config lists one entry per provider (`opencode`, `opencode-go`),
 * each with its own `api` inference base, `options.headers` carrying
 * `x-opencode-org-id`, and `whitelist` listing the models the account may call.
 * Per-model `provider`
 * blocks decide the wire API (Responses vs chat completions, see
 * {@link apiFromProviderNpm}), and the remaining per-model fields are retained
 * as {@link OpenCodeConsoleModelDefinition}s. The requested provider's entry
 * wins; otherwise we prefer the canonical `opencode` entry and fall back to the
 * first provider that has an `api`. Each entry has its own `api`, `whitelist`,
 * and model map, so the chosen id is recorded as {@link
 * OpenCodeConsoleProjection.provider}.
 */
export function parseConsoleProjection(raw: unknown, providerId?: string): OpenCodeConsoleProjection | undefined {
	const providers = recordOrUndefined(recordOrUndefined(raw)?.config)?.provider;
	const entries = recordOrUndefined(providers);
	if (!entries) return undefined;
	const candidates = Object.entries(entries);
	const selected =
		(providerId ? candidates.find(([id, value]) => id === providerId && recordOrUndefined(value)) : undefined) ??
		candidates.find(([id, value]) => id === "opencode" && recordOrUndefined(value)) ??
		candidates.find(([, value]) => recordOrUndefined(value));
	const entry = recordOrUndefined(selected?.[1]);
	const apiUrl = typeof entry?.api === "string" && entry.api.length > 0 ? entry.api : undefined;
	if (!entry || !apiUrl) return undefined;
	const whitelist = Array.isArray(entry.whitelist)
		? entry.whitelist.filter((id): id is string => typeof id === "string" && id.length > 0)
		: [];
	const api = apiFromProviderNpm(typeof entry.npm === "string" ? entry.npm : undefined);
	const modelRoutes = parseModelRoutes(entry.models);
	const definitions = parseModelDefinitions(entry.models, whitelist);
	return {
		...(selected?.[0] ? { provider: selected[0] } : {}),
		apiUrl,
		headers: stringRecord(recordOrUndefined(entry.options)?.headers),
		models: whitelist,
		// `openai-completions` is the implicit default; only record a different one.
		...(api && api !== "openai-completions" ? { api } : {}),
		...(Object.keys(modelRoutes).length > 0 ? { modelRoutes } : {}),
		...(Object.keys(definitions).length > 0 ? { definitions } : {}),
	};
}

/**
 * Read the account's console config with the OAuth access token and `x-org-id`.
 * Best-effort: a missing/misconfigured endpoint (or a pre-migration account)
 * leaves the credential without a projection, and callers fall back to
 * {@link OPENCODE_INFERENCE_BASE_URL}.
 */
async function fetchConsoleProjection(
	server: string,
	access: string,
	orgID: string | undefined,
	fetchImpl: FetchLike,
	signal: AbortSignal,
	providerId?: string,
): Promise<OpenCodeConsoleProjection | undefined> {
	const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${access}` };
	if (orgID) headers["x-org-id"] = orgID;
	const { status, body } = await fetchJson(fetchImpl, `${server}/api/config`, { headers }, signal).catch(() => ({
		status: 0,
		body: undefined,
	}));
	if (status < 200 || status >= 300) return undefined;
	return parseConsoleProjection(body, providerId);
}

/**
 * Re-read a stored console credential's projection from `${console}/api/config`.
 *
 * Credentials logged in before per-model routing was captured (or before the
 * account moved endpoints) have no `console.modelRoutes`, so their catalog
 * would be projected as plain chat completions and models that need the
 * Responses API would fail. Callers use this to backfill the projection in
 * place, with no re-login. Best-effort: returns `undefined` off-network.
 */
export async function loadConsoleProjection(
	credential: OpenCodeCredential,
	options: { fetch?: FetchLike; signal?: AbortSignal; provider?: string } = {},
): Promise<OpenCodeConsoleProjection | undefined> {
	const rawServer = credential.server;
	const server = normalizeConsoleUrl(
		typeof rawServer === "string" && rawServer.length > 0 ? rawServer : OPENCODE_CONSOLE_URL,
	);
	const orgID = typeof credential.orgID === "string" && credential.orgID ? credential.orgID : undefined;
	const signal = options.signal ?? new AbortController().signal;
	return fetchConsoleProjection(
		server,
		credential.access,
		orgID,
		options.fetch ?? globalThis.fetch,
		signal,
		options.provider,
	);
}

/**
 * Whether a stored projection should be re-read from `/api/config`: absent, or
 * last checked at/before `now - ttlMs` (or with no recorded `checkedAt`, which
 * covers credentials from before the field and pre-migration projections).
 *
 * `providerId` additionally invalidates a projection whose recorded
 * {@link OpenCodeConsoleProjection.provider} does not match, and pre-`provider`
 * projections (which may carry the sibling's endpoint/whitelist).
 */
export function consoleProjectionStale(
	credential: OpenCodeCredential | undefined,
	now: number,
	ttlMs: number = CONSOLE_PROJECTION_TTL_MS,
	providerId?: string,
): boolean {
	const projection = credential?.console;
	const checkedAt = projection?.checkedAt;
	if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return true;
	// A projection captured from the sibling provider carries the wrong
	// endpoint/whitelist; treat it as stale so it is re-read.
	if (providerId && projection?.provider !== providerId) return true;
	// Projections captured before model-definition retention cannot synthesize
	// whitelist-only catalog entries; consider them stale so they migrate once.
	if (projection && projection.models.length > 0 && !projection.definitions) return true;
	return now - checkedAt >= ttlMs;
}

function sortedStringRecord(record: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function canonicalModelRoutes(
	routes: Record<string, OpenCodeConsoleModelRoute> | undefined,
): Record<string, OpenCodeConsoleModelRoute> | null {
	if (!routes) return null;
	const canonical: Record<string, OpenCodeConsoleModelRoute> = {};
	for (const id of Object.keys(routes).sort()) {
		const route = routes[id];
		canonical[id] = { ...(route.api ? { api: route.api } : {}), ...(route.apiUrl ? { apiUrl: route.apiUrl } : {}) };
	}
	return canonical;
}

function canonicalDefinitions(
	definitions: Record<string, OpenCodeConsoleModelDefinition> | undefined,
): Record<string, OpenCodeConsoleModelDefinition> | null {
	if (!definitions) return null;
	const canonical: Record<string, OpenCodeConsoleModelDefinition> = {};
	for (const id of Object.keys(definitions).sort()) {
		const def = definitions[id];
		canonical[id] = {
			...(def.name ? { name: def.name } : {}),
			reasoning: def.reasoning,
			input: [...def.input],
			cost: { ...def.cost },
			contextWindow: def.contextWindow,
			maxTokens: def.maxTokens,
		};
	}
	return canonical;
}

/**
 * Canonical payload of a projection, excluding `checkedAt`. Key order in
 * `headers`/`modelRoutes` is not semantic, so it is normalized before the
 * comparison.
 */
function consoleProjectionPayload(projection: OpenCodeConsoleProjection | undefined): string {
	if (!projection) return "";
	return JSON.stringify({
		provider: projection.provider ?? null,
		apiUrl: projection.apiUrl,
		headers: sortedStringRecord(projection.headers),
		models: [...projection.models],
		api: projection.api ?? null,
		modelRoutes: canonicalModelRoutes(projection.modelRoutes),
		definitions: canonicalDefinitions(projection.definitions),
	});
}

/** True when two projections differ in anything except the refresh timestamp. */
export function consoleProjectionDiffers(
	current: OpenCodeConsoleProjection | undefined,
	fetched: OpenCodeConsoleProjection | undefined,
): boolean {
	return consoleProjectionPayload(current) !== consoleProjectionPayload(fetched);
}

/**
 * Stamp a freshly fetched projection with `now` and merge it into a credential.
 * `changed` reports whether the model-affecting payload actually moved (so
 * callers can skip a model-registry refresh when only the timestamp advanced).
 */
export function mergeConsoleProjection(
	credential: OpenCodeCredential,
	fetched: OpenCodeConsoleProjection,
	now: number,
): { credential: OpenCodeCredential; changed: boolean } {
	return {
		credential: { ...credential, console: { ...fetched, checkedAt: now } },
		changed: consoleProjectionDiffers(credential.console, fetched),
	};
}

/**
 * Project Pi's built-in `opencode`/`opencode-go` catalog onto the console
 * account's inference endpoint.
 *
 * The built-in catalogs point at `opencode.ai/zen` and `opencode.ai/zen/go`,
 * which only accept `oc_sk_…`/`sk-…` API keys; an OAuth access token there
 * returns `401 {"type":"AuthError","message":"Invalid API key."}`. The console
 * account instead calls `provider.api` from `/api/config` (typically
 * `https://opencode.ai/inference/openai/v1`) with the access token as Bearer
 * and `x-opencode-org-id` selecting the workspace. Each model is routed through
 * the API OpenCode would use for its `provider.npm` (see
 * {@link apiFromProviderNpm}): most are OpenAI chat completions, but some
 * (e.g. `muse-spark`, `provider.npm = "@ai-sdk/openai"`) only answer on the
 * Responses endpoint. Models outside the account whitelist are hidden
 * (OpenCode's merged config only contains the entitled models).
 *
 * Pi's built-in catalog lags the console, so a newly entitled model can be in
 * the whitelist before `pi.dev` ships it. Those ids are synthesized from the
 * projection's {@link OpenCodeConsoleModelDefinition}s and appended, so an
 * entitlement surfaces without waiting for an upstream catalog update (the
 * previous filter-only projection dropped them). `providerId` labels the
 * synthesized entries; it defaults to the catalog's own provider.
 */
export function projectConsoleModels(
	models: Model<Api>[],
	credential: OpenCodeCredential,
	providerId?: string,
): Model<Api>[] {
	const projection = credential.console;
	const provider = providerId ?? models[0]?.provider;
	// Zen and Go share one console account but not one projection: each is a
	// separate `provider` entry with its own `api` and whitelist. A projection
	// captured for the sibling would route to the wrong endpoint and drop this
	// provider's entitlements, so ignore it; `consoleProjectionStale` schedules a
	// re-read for the correct entry.
	const mismatched =
		provider !== undefined && projection?.provider !== undefined && projection.provider !== provider;
	const active = mismatched ? undefined : projection;
	const fallbackApiUrl =
		provider === OPENCODE_GO_PROVIDER ? OPENCODE_GO_INFERENCE_BASE_URL : OPENCODE_INFERENCE_BASE_URL;
	const apiUrl = active?.apiUrl ?? fallbackApiUrl;
	const defaultApi: Api = active?.api ?? "openai-completions";
	const orgID = typeof credential.orgID === "string" && credential.orgID ? credential.orgID : undefined;
	const headers: Record<string, string> = { ...active?.headers };
	// The remote config already carries the header; derive it from orgID for
	// credentials logged in before the projection was captured.
	if (orgID && !Object.keys(headers).some((key) => key.toLowerCase() === OPENCODE_ORG_HEADER)) {
		headers[OPENCODE_ORG_HEADER] = orgID;
	}
	const allowed = active?.models && active.models.length > 0 ? new Set(active.models) : undefined;
	const projected: Model<Api>[] = models
		.filter((model) => !allowed || allowed.has(model.id))
		.map((model) => {
			const route = active?.modelRoutes?.[model.id];
			return {
				...model,
				api: route?.api ?? defaultApi,
				baseUrl: route?.apiUrl ?? apiUrl,
				headers: { ...(model.headers ?? {}), ...headers },
			};
		});

	if (allowed && provider && active?.definitions) {
		const present = new Set(projected.map((model) => model.id));
		for (const id of active.models) {
			if (present.has(id)) continue;
			const definition = active.definitions[id];
			if (!definition) continue;
			const route = active.modelRoutes?.[id];
			projected.push({
				id,
				name: definition.name ?? id,
				api: route?.api ?? defaultApi,
				provider,
				baseUrl: route?.apiUrl ?? apiUrl,
				reasoning: definition.reasoning,
				input: [...definition.input],
				cost: { ...definition.cost },
				contextWindow: definition.contextWindow,
				maxTokens: definition.maxTokens,
				headers: { ...headers },
			});
		}
	}
	return projected;
}

async function refreshToken(
	credentials: OpenCodeCredential,
	fetchImpl: FetchLike,
	signal: AbortSignal,
	readSibling?: () => OpenCodeCredential | undefined,
): Promise<OpenCodeCredential> {
	// Refresh tokens rotate. If the sibling provider already refreshed to a
	// newer token, adopt it instead of replaying a possibly-invalidated one.
	const sibling = readSiblingCredential(readSibling);
	if (
		sibling &&
		sibling.expires > Date.now() + ADOPT_MIN_VALIDITY_MS &&
		sibling.expires > credentials.expires
	) {
		return { ...sibling, server: sibling.server ?? credentials.server };
	}

	const rawServer = credentials.server;
	const server = normalizeConsoleUrl(
		typeof rawServer === "string" && rawServer.length > 0 ? rawServer : OPENCODE_CONSOLE_URL,
	);
	const { status, body } = await fetchJson(
		fetchImpl,
		`${server}/auth/device/token`,
		{
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: credentials.refresh,
				client_id: OPENCODE_OAUTH_CLIENT_ID,
			}),
		},
		signal,
	);
	if (status < 200 || status >= 300) {
		throw new Error(`OpenCode token refresh failed (HTTP ${status})`);
	}
	const token = parseDeviceToken(body);
	return {
		...credentials,
		access: token.access,
		refresh: token.refresh,
		expires: Date.now() + token.expiresInSeconds * 1000,
	};
}

async function login(
	server: string,
	fetchImpl: FetchLike,
	callbacks: OAuthLoginCallbacks,
	provider: string,
	readSibling?: () => OpenCodeCredential | undefined,
): Promise<OpenCodeCredential> {
	// `opencode-go` is the same console account as `opencode`: reuse the stored
	// Zen credential (same token/identity) instead of asking for a second
	// consent. The projection is *not* shared: Go has its own inference endpoint
	// and whitelist, so re-read it from Go's `/api/config` entry.
	if (provider === OPENCODE_GO_PROVIDER) {
		const adopted = readSiblingCredential(readSibling);
		if (adopted) {
			const target: OpenCodeCredential = { ...adopted, server: adopted.server ?? server };
			const signal = callbacks.signal ?? new AbortController().signal;
			const orgID = typeof target.orgID === "string" && target.orgID ? target.orgID : undefined;
			const projection = await fetchConsoleProjection(server, target.access, orgID, fetchImpl, signal, provider);
			if (projection) return { ...target, console: projection };
			// Off-network: drop the sibling's projection rather than route Go
			// through Zen's endpoint/whitelist; the startup refresh refills it.
			const withoutProjection = { ...target };
			delete withoutProjection.console;
			return withoutProjection;
		}
	}

	const signal = callbacks.signal ?? new AbortController().signal;
	const device = await requestDeviceCode(server, fetchImpl, signal);
	// `verification_uri_complete` already carries the user code, so opening the
	// browser is enough; keep the code in the instructions for manual entry.
	callbacks.onAuth({
		url: device.verificationUri,
		instructions: `Enter code: ${device.userCode}`,
	});
	// Re-render with the user code and a waiting indicator (the browser is
	// already open). Optional for older Pi versions that only pass `onAuth`.
	callbacks.onDeviceCode?.({
		userCode: device.userCode,
		verificationUri: device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	const token = await pollForToken(server, device, fetchImpl, signal);
	const identity = await fetchUserOrgs(server, token.access, fetchImpl, signal);
	const projection = await fetchConsoleProjection(server, token.access, identity.orgID, fetchImpl, signal, provider);
	return {
		access: token.access,
		refresh: token.refresh,
		expires: Date.now() + token.expiresInSeconds * 1000,
		server,
		...identity,
		...(projection ? { console: projection } : {}),
	};
}

/**
 * Build the `oauth` block for `pi.registerProvider("opencode", …)`.
 *
 * `getApiKey` returns the access token verbatim, so openai-completions sends it
 * as `Authorization: Bearer …`; `modifyModels` rewrites the built-in `/zen`
 * catalog onto the account's console inference endpoint (see
 * {@link projectConsoleModels}).
 */
export function createOpencodeOAuth(
	options: OpenCodeOAuthOptions = {},
): NonNullable<ProviderConfig["oauth"]> {
	const server = normalizeConsoleUrl(options.server ?? OPENCODE_CONSOLE_URL);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const provider = options.provider ?? "opencode";
	return {
		name: OPENCODE_OAUTH_NAME,
		isSubscription: true,
		async login(callbacks) {
			return login(server, fetchImpl, callbacks, provider, options.readSibling);
		},
		async refreshToken(credentials, signal) {
			return refreshToken(credentials as OpenCodeCredential, fetchImpl, signal, options.readSibling);
		},
		getApiKey(credentials) {
			return credentials.access;
		},
		modifyModels(models, credentials) {
			return projectConsoleModels(models as Model<Api>[], credentials as OpenCodeCredential, provider);
		},
	};
}
