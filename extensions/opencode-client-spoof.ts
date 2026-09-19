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
 * `before_provider_request` then fixes the body-level gate. Before the agent
 * starts it makes sure the request can advertise `glob` and `grep`: `glob` is
 * registered as a thin alias of Pi's built-in `find` (with a minimal schema,
 * since the gate ignores schemas), and the built-in `grep` is registered under
 * the `grep` name when the session does not already expose one (FFF, for
 * example, exposes `ffgrep` instead). Only for free-tier
 * `opencode` requests are those two names left in the outgoing payload's
 * `tools` array; every other request has the names we added stripped back out,
 * so no other provider sees a tool Pi would not normally send.
 *
 * Why `before_agent_start` and not `session_start`: extension `session_start`
 * handlers run in load order, and this extension loads before FFF. FFF can
 * register a tool literally named `grep` itself (its `override` mode, which
 * replaces the built-ins instead of exposing `ffgrep`/`fffind`). Borrowing the
 * name first and then re-registering by name on teardown would strip FFF's
 * tool from non-target providers. `before_agent_start` fires after every
 * `session_start` handler, so we only borrow `glob`/`grep` when no other
 * extension has already provided them.
 *
 * The OpenCode version is read from a locally installed OpenCode binary when
 * one is available (so this keeps working as OpenCode ships new releases). It
 * can be overridden with `PI_OPENCODE_SPOOF_VERSION`, which must itself be
 * >= 1.17.0 or it is ignored.
 */
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	isFreeOpencodeModel,
	opencodeSessionId,
	resolveOpencodeVersion,
	SPOOFED_CLIENT,
} from "./shared/opencode-zen.ts";

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

/**
 * Minimal schema for the borrowed gate tools. Zen's free-tier gate only checks
 * the tool *names* (`bash`, `glob`, `grep`, `read`) - descriptions and schemas
 * are ignored. The session's real search tools (`fffind`/`ffgrep`, or
 * `find`/`grep`) already carry their full schemas, so these aliases ship a
 * tiny schema instead of duplicating the built-in definition and inflating
 * every free-tier request.
 */
const GATE_TOOL_SCHEMA = Type.Object({
	pattern: Type.String({ description: "Glob (glob) or regex/literal (grep) pattern" }),
	path: Type.Optional(Type.String({ description: "Directory or file (default: cwd)" })),
	limit: Type.Optional(Type.Number({ description: "Max results" })),
});

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
	//
	// Runs on `before_agent_start`, not `session_start`, so other extensions'
	// `session_start` handlers have already registered their tools (see the
	// file header). It fires again on later turns; the `active` check makes it a
	// no-op once the aliases exist.
	pi.on("before_agent_start", () => {
		const active = new Set(pi.getActiveTools());
		const additions: string[] = [];

		if (!active.has(GLOB_TOOL_NAME)) {
			pi.registerTool({
				...createFindToolDefinition(process.cwd()),
				name: GLOB_TOOL_NAME,
				label: GLOB_TOOL_NAME,
				description: "Find files by glob pattern.",
				promptSnippet: undefined,
				promptGuidelines: undefined,
				parameters: GATE_TOOL_SCHEMA,
			});
			additions.push(GLOB_TOOL_NAME);
		}

		if (!active.has(GREP_TOOL_NAME)) {
			pi.registerTool({
				...createGrepToolDefinition(process.cwd()),
				name: GREP_TOOL_NAME,
				label: GREP_TOOL_NAME,
				description: "Search file contents by pattern.",
				promptSnippet: undefined,
				promptGuidelines: undefined,
				parameters: GATE_TOOL_SCHEMA,
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
