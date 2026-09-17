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
 * Verified against the live gateway, the gate has three parts:
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
 *   3. The request *body* must look like an agentic OpenCode turn: it must be
 *      streaming (`stream: true`) and declare tools named `bash`, `glob`,
 *      `grep`, and `read`. Verified against the live gateway: removing any one
 *      of those four names, emptying `tools`, or setting `stream: false` all
 *      bring the 403 FreeTierError back, while tool descriptions/schemas and
 *      every other tool name are ignored. OpenCode streams by default and Pi
 *      always ships `read` and `bash`, but its search tools are `grep`/`find`
 *      only when those are the active names - FFF-based setups expose
 *      `ffgrep`/`fffind` instead, so `glob` is always missing and `grep` is
 *      usually missing too. The request is therefore rejected again even with
 *      perfect headers.
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
 * `before_provider_request` then fixes the body-level gate. On session start
 * it makes sure the request can advertise `glob` and `grep`: `glob` is
 * registered as a thin alias of Pi's built-in `find`, and the built-in `grep`
 * is registered under the `grep` name when the session does not already expose
 * one (FFF, for example, exposes `ffgrep` instead). Only for free-tier
 * `opencode` requests are those two names left in the outgoing payload's
 * `tools` array; every other request has the names we added stripped back out,
 * so no other provider sees a tool Pi would not normally send.
 *
 * The OpenCode version is read from a locally installed OpenCode binary when
 * one is available (so this keeps working as OpenCode ships new releases). It
 * can be overridden with `PI_OPENCODE_SPOOF_VERSION`, which must itself be
 * >= 1.17.0 or it is ignored.
 */
import { execFileSync } from "node:child_process";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

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

/**
 * Console's free-tier gate requires the body to declare tools named `bash`,
 * `glob`, `grep`, and `read`. Pi always ships `read` and `bash`; the search
 * tools are the loose ends: Pi names them `find`/`grep`, and FFF-based setups
 * expose `ffind`/`ffgrep` instead, so `glob` is always missing and `grep` is
 * usually missing too.
 */
const GLOB_TOOL_NAME = "glob";
const GREP_TOOL_NAME = "grep";

/** Read a provider-format tool entry's name (Responses / Anthropic / completions). */
function toolEntryName(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	if (typeof record.name === "string") return record.name;
	const fn = record.function;
	if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string") {
		return (fn as Record<string, unknown>).name as string;
	}
	return undefined;
}

/** Clone a provider-format tool entry under a new name, preserving its shape. */
function cloneToolEntry(template: unknown, name: string): unknown {
	if (template && typeof template === "object") {
		const record = template as Record<string, unknown>;
		const fn = record.function;
		if (fn && typeof fn === "object") {
			return { ...record, function: { ...(fn as Record<string, unknown>), name } };
		}
		return { ...record, name };
	}
	return {
		type: "function",
		name,
		description: "Search files by pattern.",
		parameters: {
			type: "object",
			properties: { pattern: { type: "string", description: "Glob or search pattern" } },
			required: ["pattern"],
		},
	};
}

/** Existing entries that can stand in for the `glob` / `grep` names we add. */
const GLOB_TEMPLATES = ["find", "ffind", GLOB_TOOL_NAME];
const GREP_TEMPLATES = [GREP_TOOL_NAME, "ffgrep"];

/** Make sure the payload's `tools` array carries both gated search tools. */
function ensureGateTools(payload: Record<string, unknown>): void {
	if (!Array.isArray(payload.tools)) return;
	const tools = payload.tools as unknown[];
	const present = new Set(tools.map(toolEntryName).filter((name): name is string => !!name));
	for (const [name, templates] of [
		[GLOB_TOOL_NAME, GLOB_TEMPLATES],
		[GREP_TOOL_NAME, GREP_TEMPLATES],
	] as const) {
		if (present.has(name)) continue;
		const template = tools.find((entry) => templates.includes(toolEntryName(entry) ?? ""));
		tools.push(cloneToolEntry(template, name));
	}
}

/** Strip a tool name out of the payload, keeping non-target providers untouched. */
function removeTool(payload: Record<string, unknown>, name: string): void {
	if (!Array.isArray(payload.tools)) return;
	const tools = payload.tools as unknown[];
	const filtered = tools.filter((entry) => toolEntryName(entry) !== name);
	if (filtered.length !== tools.length) payload.tools = filtered;
}

export default function opencodeClientSpoof(pi: ExtensionAPI) {
	// Names this session did not originally have. Only these are stripped back
	// out of requests that are not free-tier opencode calls.
	const borrowed = new Set<string>();

	// The Console gate looks for tools literally named `glob` and `grep`. Pi
	// names those capabilities `find`/`grep` (or `ffind`/`ffgrep` with FFF), so
	// expose real `glob`/`grep` aliases when the session lacks those names.
	// Both are invisible in the system prompt (no snippet) and only advertised
	// for free-tier opencode requests.
	pi.on("session_start", () => {
		const active = new Set(pi.getActiveTools());
		const additions: string[] = [];

		if (!active.has(GLOB_TOOL_NAME)) {
			pi.registerTool({
				...createFindToolDefinition(process.cwd()),
				name: GLOB_TOOL_NAME,
				label: GLOB_TOOL_NAME,
				promptSnippet: undefined,
				promptGuidelines: undefined,
			});
			additions.push(GLOB_TOOL_NAME);
		}

		if (!active.has(GREP_TOOL_NAME)) {
			pi.registerTool({
				...createGrepToolDefinition(process.cwd()),
				name: GREP_TOOL_NAME,
				label: GREP_TOOL_NAME,
				promptSnippet: undefined,
				promptGuidelines: undefined,
			});
			additions.push(GREP_TOOL_NAME);
		}

		if (additions.length > 0) {
			pi.setActiveTools([...active, ...additions]);
			for (const name of additions) borrowed.add(name);
		}
	});

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

	// Body-level gate: free-tier requests must declare `glob` and `grep`. The
	// proxy sees provider-format tools here (before_provider_request runs after
	// Pi converts them), so this works for Responses, Chat Completions and
	// Anthropic Messages alike.
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		const record = payload as Record<string, unknown>;
		const model = ctx.model as Model<Api> | undefined;

		if (isFreeOpencodeModel(model)) {
			ensureGateTools(record);
			return;
		}
		// Unknown model: leave the payload alone rather than guess. Known
		// non-target models never see the borrowed tools.
		if (model) for (const name of borrowed) removeTool(record, name);
	});
}
