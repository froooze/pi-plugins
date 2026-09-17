/**
 * opencode-client-spoof - make the OpenCode Zen gateway believe a real OpenCode
 * client is calling it, so its free tier stays usable.
 *
 * Background
 * ----------
 * OpenCode's Zen gateway (https://opencode.ai/zen) serves some models on a free
 * tier. Requests that do not look like they come from OpenCode are rejected by
 * the upstream provider with
 *
 *   403 {"type":"FreeTierError",
 *        "message":"... free tier can only be used from within OpenCode"}
 *
 * and, when the client is recognised but too old,
 *
 *   426 {"type":"UpgradeRequired",
 *        "message":"OpenCode 1.17.0 or newer is required to use the free tier"}
 *
 * Verified against the live gateway, the gate has two parts:
 *
 *   1. `User-Agent` must identify OpenCode and claim a supported version.
 *      OpenCode sends `opencode/<version>`
 *      (opencode/packages/opencode/src/session/llm/request.ts). Anything older
 *      than 1.17.0 - or Pi's own `pi (…)` UA - is refused.
 *
 *   2. `x-opencode-session` must be a well-formed OpenCode session id:
 *      `ses_` + 12 lowercase hex chars (an encoding of the creation
 *      timestamp/counter) + 14 base62 random chars. That is exactly the shape
 *      produced by `Identifier.descending()`
 *      (opencode/packages/schema/src/identifier.ts) via `SessionID.create`
 *      (opencode/packages/schema/src/session-id.ts). A short, foreign or
 *      malformed value is treated as a non-OpenCode caller.
 *
 *      `x-opencode-client` used to be part of the story for metrics, but the
 *      gate does not care which known OpenCode client value is sent.
 *
 * Pi deliberately identifies itself instead:
 *
 *   x-opencode-client: "pi"        (pi/packages/coding-agent/src/core/provider-attribution.ts)
 *   User-Agent:        "pi (…)"    (pi/packages/ai/src/utils/pi-user-agent.ts)
 *   x-opencode-session: <pi session id>  (not OpenCode-shaped)
 *
 * so the gateway sees a non-OpenCode client and rejects free-tier models.
 *
 * Scope
 * -----
 * Deliberately narrow: this only rewrites caller identity for **free-tier
 * models on the `opencode` (Zen) provider**. Paid models, `opencode-go`, and
 * every other provider are left byte-for-byte identical, so this never
 * misrepresents a paid request and is safe to keep enabled globally.
 *
 * A model counts as free-tier when its id or display name contains "free",
 * or when its catalog cost is zero (which catches unnamed free models such as
 * `big-pickle`).
 *
 * What this does
 * --------------
 * `before_provider_headers` runs *after* Pi has merged its attribution headers
 * (see pi/packages/coding-agent/src/core/sdk.ts, which calls
 * mergeProviderAttributionHeaders and then emits the hook), so this extension
 * can overwrite them:
 *
 *   x-opencode-client  -> "cli"
 *   User-Agent         -> "opencode/<version>"
 *   x-opencode-session -> a stable, well-formed OpenCode session id
 *
 * The OpenCode version is read from a locally installed OpenCode binary when
 * one is available (so this keeps working as OpenCode ships new releases). It
 * can be overridden with `PI_OPENCODE_SPOOF_VERSION`, which must itself be
 * >= 1.17.0 or it is ignored.
 */
import { execFileSync } from "node:child_process";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Only models on OpenCode's main Zen provider are eligible. */
const OPENCODE_PROVIDER = "opencode";

/** Value OpenCode's own CLI sends by default (`OPENCODE_CLIENT`). */
const SPOOFED_CLIENT = "cli";

/** Zen's free tier refuses OpenCode clients older than this. */
const MIN_OPENCODE_VERSION: readonly [number, number, number] = [1, 17, 0];

/** Used when no local OpenCode install can be found. */
const FALLBACK_OPENCODE_VERSION = "1.18.31";

/** base62 alphabet OpenCode uses for the random tail of its identifiers. */
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function parseVersion(value: string): [number, number, number] | undefined {
	const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(
	version: readonly [number, number, number],
	min: readonly [number, number, number],
): boolean {
	for (let i = 0; i < 3; i++) {
		if (version[i] !== min[i]) return version[i] > min[i];
	}
	return true;
}

let cachedVersion: string | undefined;

/**
 * Resolve a User-Agent version the free tier accepts. Prefers the locally
 * installed OpenCode so the spoof tracks upstream releases, then a pinned
 * fallback. Resolved once per process.
 */
function resolveOpencodeVersion(): string {
	if (cachedVersion) return cachedVersion;

	const override = process.env.PI_OPENCODE_SPOOF_VERSION?.trim();
	const parsedOverride = override ? parseVersion(override) : undefined;
	if (override && parsedOverride && isAtLeast(parsedOverride, MIN_OPENCODE_VERSION)) {
		cachedVersion = parsedOverride.join(".");
		return cachedVersion;
	}

	try {
		const output = execFileSync("opencode", ["--version"], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const parsed = parseVersion(output);
		if (parsed && isAtLeast(parsed, MIN_OPENCODE_VERSION)) {
			cachedVersion = parsed.join(".");
			return cachedVersion;
		}
	} catch {
		// No OpenCode on PATH - fall through to the pinned version.
	}

	cachedVersion = FALLBACK_OPENCODE_VERSION;
	return cachedVersion;
}

let lastTimestamp = 0;
let counter = 0;

/**
 * Mirrors OpenCode's `Identifier.descending()`
 * (opencode/packages/schema/src/identifier.ts): the first 12 hex chars encode
 * a monotonically increasing millisecond timestamp plus a per-ms counter, and
 * the remaining 14 chars are base62 random. Zen accepts exactly this shape.
 */
function createOpencodeSessionId(now = Date.now()): string {
	if (now !== lastTimestamp) {
		lastTimestamp = now;
		counter = 0;
	}
	counter += 1;

	const value = ~(BigInt(now) * 0x1000n + BigInt(counter));
	let time = "";
	for (let i = 0; i < 6; i++) {
		time += Number((value >> BigInt(40 - 8 * i)) & 0xffn)
			.toString(16)
			.padStart(2, "0");
	}

	const bytes = new Uint8Array(14);
	crypto.getRandomValues(bytes);
	let tail = "";
	for (const byte of bytes) tail += ID_CHARS[byte % ID_CHARS.length];

	return `ses_${time}${tail}`;
}

/** Pi session id -> OpenCode-shaped session id, so Zen's sticky routing stays stable. */
const opencodeSessionIds = new Map<string, string>();

function opencodeSessionId(piSessionId: string | undefined): string {
	if (!piSessionId) return createOpencodeSessionId();
	let id = opencodeSessionIds.get(piSessionId);
	if (!id) {
		id = createOpencodeSessionId();
		opencodeSessionIds.set(piSessionId, id);
	}
	return id;
}

/**
 * Free-tier detection. Most Zen free models carry "-free" in the id, but not
 * all of them (`big-pickle` is free with no name marker), so a zero catalog
 * cost is the catch-all. The name check is just a cheap positive signal for
 * when cost metadata is missing (e.g. custom model overrides).
 */
function isFreeModel(model: Model<Api>): boolean {
	if (/free/i.test(model.id) || /free/i.test(model.name)) return true;
	const cost = model.cost;
	if (!cost) return false;
	return cost.input === 0 && cost.output === 0;
}

function isFreeOpencodeModel(model: Model<Api> | undefined): boolean {
	if (!model) return false;
	return model.provider === OPENCODE_PROVIDER && isFreeModel(model);
}

/** Case-insensitively find the existing key for a header name, if present. */
function findHeaderKey(headers: ProviderHeaders, name: string): string | undefined {
	const wanted = name.toLowerCase();
	return Object.keys(headers).find((k) => k.toLowerCase() === wanted);
}

function setHeader(headers: ProviderHeaders, name: string, value: string): void {
	const key = findHeaderKey(headers, name);
	headers[key ?? name] = value;
}

export default function opencodeClientSpoof(pi: ExtensionAPI) {
	pi.on("before_provider_headers", (event, ctx) => {
		const headers = event.headers;
		if (!headers) return;

		if (!isFreeOpencodeModel(ctx.model as Model<Api> | undefined)) return;

		// 1. Caller identity: "pi" -> "cli".
		setHeader(headers, "x-opencode-client", SPOOFED_CLIENT);

		// 2. User-Agent: "pi (…)" -> "opencode/<supported version>".
		setHeader(headers, "User-Agent", `opencode/${resolveOpencodeVersion()}`);

		// 3. Session: Pi's session id -> a well-formed, stable OpenCode session id.
		let piSessionId: string | undefined;
		try {
			piSessionId = ctx.sessionManager.getSessionId();
		} catch {
			piSessionId = undefined;
		}
		setHeader(headers, "x-opencode-session", opencodeSessionId(piSessionId));
	});
}
