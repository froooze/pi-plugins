/**
 * shared/opencode-oauth — OpenCode Console OAuth (RFC 8628 device flow).
 *
 * OpenCode's own client no longer authenticates against the Zen gateway with a
 * static console API key alone. `opencode console login` runs a device
 * authorization against `https://opencode.ai/console` with the public
 * `opencode-cli` client id, then uses the resulting OAuth access token as the
 * bearer credential for `/zen` requests. This module gives Pi the same login
 * method so `/login opencode` offers OAuth alongside the built-in API-key
 * option. Pi's type selector labels them "Sign in with an account" (OAuth,
 * listed first) and "Sign in with an API key"; the `name` below is used as the
 * ambient-auth description.
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
 *      keep the first org (matching OpenCode's lexicographic selection).
 *
 * The access token is handed to Pi as the provider API key; the OpenCode
 * provider sends it as `Authorization: Bearer …` against `opencode.ai/zen`.
 * Tokens are rotated with the refresh token via `refreshToken`.
 *
 * `opencode` (Zen) and `opencode-go` are the same console account, so this
 * module also registers for Go: its `login` adopts the Zen credential instead
 * of asking for a second consent, and both `refreshToken` implementations
 * adopt the sibling's credential when it is fresher, so a rotate-on-refresh
 * server cannot leave one provider replaying an invalidated refresh token.
 */
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

/** Console origin used by `opencode console login` (`defaultConsoleUrl`). */
export const OPENCODE_CONSOLE_URL = "https://opencode.ai/console";

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

export interface OpenCodeCredential {
	access: string;
	refresh: string;
	expires: number;
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
	// `opencode-go` is the same console account as `opencode`: reuse a stored
	// Zen credential instead of asking the user to authorize a second time.
	if (provider === OPENCODE_GO_PROVIDER) {
		const adopted = readSiblingCredential(readSibling);
		if (adopted) return { ...adopted, server: adopted.server ?? server };
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
	return {
		access: token.access,
		refresh: token.refresh,
		expires: Date.now() + token.expiresInSeconds * 1000,
		server,
		...identity,
	};
}

/**
 * Build the `oauth` block for `pi.registerProvider("opencode", …)`.
 * The access token is returned verbatim as the provider API key, so Pi sends
 * it as `Authorization: Bearer …` to the Zen endpoint.
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
	};
}
