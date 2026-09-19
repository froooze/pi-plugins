/**
 * shared/opencode-zen — OpenCode Zen identity spoof primitives.
 *
 * OpenCode's Zen gateway only serves free-tier models to requests that look
 * like a real, recent OpenCode client. Two extensions need those primitives:
 *
 *   - `opencode-client-spoof` rewrites the main agent's request headers/body
 *     through `before_provider_headers` / `before_provider_request`;
 *   - `opencode-session-id` needs the same identity (and a well-formed
 *     `ses_…` id) when it spoofs extension one-shot completions, which never
 *     reach those hooks.
 *
 * This module owns the shared, pure-ish pieces so the two do not drift:
 * version resolution, the OpenCode-shaped session id generator/memo, and
 * free-model detection. It performs no I/O beyond the optional
 * `opencode --version` probe inside `resolveOpencodeVersion()`.
 */
import { execFileSync } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Only models on OpenCode's main Zen provider are free-tier eligible. */
export const OPENCODE_PROVIDER = "opencode";

/** OpenCode-family provider ids (Zen and the Go subscription). */
export const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);

/** Host OpenCode endpoints live on (used for custom base-url overrides). */
export const OPENCODE_HOST = "opencode.ai";

/** Value OpenCode's own CLI sends by default (`OPENCODE_CLIENT`). */
export const SPOOFED_CLIENT = "cli";

/** Zen's free tier refuses OpenCode clients older than this. */
export const MIN_OPENCODE_VERSION: readonly [number, number, number] = [1, 17, 0];

/** Used when no local OpenCode install can be found. */
export const FALLBACK_OPENCODE_VERSION = "1.18.31";

/** base62 alphabet OpenCode uses for the random tail of its identifiers. */
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function parseVersion(value: string): [number, number, number] | undefined {
	const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isAtLeast(
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
export function resolveOpencodeVersion(): string {
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
 * Mirrors OpenCode's `Identifier.descending()`: the first 12 hex chars encode a
 * monotonically increasing millisecond timestamp plus a per-ms counter, and the
 * remaining 14 chars are base62 random. Zen accepts exactly this shape.
 */
export function createOpencodeSessionId(now = Date.now()): string {
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

export function opencodeSessionId(piSessionId: string | undefined): string {
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
export function isFreeModel(model: Model<Api>): boolean {
	if (/free/i.test(model.id) || /free/i.test(model.name)) return true;
	const cost = model.cost;
	if (!cost) return false;
	return cost.input === 0 && cost.output === 0;
}

/** Free-tier model on the Zen (not Go) provider. */
export function isFreeOpencodeModel(model: Model<Api> | undefined): boolean {
	if (!model) return false;
	return model.provider === OPENCODE_PROVIDER && isFreeModel(model);
}

/** True when `baseUrl` points at an OpenCode host. */
export function isOpencodeHost(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === OPENCODE_HOST;
	} catch {
		return false;
	}
}

/** True for the OpenCode family, matching Pi's own attribution predicate. */
export function isOpencodeModel(model: Model<Api> | undefined): boolean {
	if (!model) return false;
	return OPENCODE_PROVIDERS.has(model.provider) || isOpencodeHost(model.baseUrl);
}
