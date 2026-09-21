/**
 * opencode-session-id - make OpenCode / OpenCode Go recognise every
 * extension-initiated one-shot completion as belonging to this Pi session.
 *
 * Background
 * ----------
 * OpenCode and OpenCode Go require a per-conversation routing id in the
 * `x-opencode-session` header. Pi produces it from `options.sessionId`:
 *
 *   - the built-in provider adapters add the header themselves
 *     (pi/packages/ai/src/providers/opencode-headers.ts), and
 *   - the main agent path additionally maps the Pi session id through
 *     mergeProviderAttributionHeaders in the SDK's `streamFn`
 *     (pi/packages/coding-agent/src/core/provider-attribution.ts).
 *
 * Extensions that call the runtime completion facade directly — custom
 * compaction and handoff one-shots, for example — bypass that `streamFn`, and `completeSimple`
 * never gets a `sessionId`, so the request reaches the gateway with no session
 * header and is rejected:
 *
 *   400 {"type":"MissingSessionID", ...}
 *
 * What this does
 * --------------
 * `session_start` (which also fires for `reload`, `new`, `resume`, and `fork`)
 * records the current Pi session id and wraps the shared ModelRuntime's one-shot
 * completion entry points (`completeSimple` / `complete`) exactly once. The
 * wrapper fills in `options.sessionId` only when the caller omitted it *and* the
 * model is an OpenCode-family model. Callers that already pass a session id —
 * including the main agent — are left untouched, and streaming entry points
 * (`streamSimple` / `stream`), which the agent uses, are not wrapped at all.
 *
 * The wrapper lives on the ModelRuntime instance and the recorded id lives on
 * globalThis, so both survive an extension `/reload`. It is deliberately
 * provider-scoped: no other provider's requests are modified.
 *
 * OpenCode Zen free tier (opt-in)
 * -------------------------------
 * Restoring `sessionId` is enough for `opencode-go` and paid `opencode`. Zen's
 * *free* tier additionally gates on identity and an agentic-looking body, which
 * `opencode-client-spoof` normally applies through `before_provider_headers` /
 * `before_provider_request` — hooks the runtime facade never emits.
 *
 * Setting `PI_OPENCODE_ZEN_SPOOF=1` extends this wrapper to spoofed Zen
 * one-shot completions: it injects the spoofed `User-Agent`/`x-opencode-client`
 * headers, a well-formed `ses_…` session id plus `x-opencode-project` and
 * `x-opencode-request` (the other identity headers the Console logs, matching
 * `opencode/packages/opencode/src/session/llm/request.ts`), and — only for
 * tool-free contexts — the four gate tool names (`bash`, `glob`, `grep`,
 * `read`) with `toolChoice: "none"`. Declaring the tools satisfies the body gate
 * while forbidding the model from calling them, so the one-shot stays
 * functionally tool-free.
 *
 * Which models get the spoofed identity follows `opencode-client-spoof`'s
 * `PI_OPENCODE_SPOOF_SCOPE` (`auto` also covers paid Zen and Go when the
 * provider is OAuth-authenticated), so the main agent and extension one-shots
 * never disagree on the account's client identity. Non-OpenCode providers are
 * never affected.
 *
 * The free-tier *body* spoof (gate tools + `toolChoice: "none"`) remains
 * behind `PI_OPENCODE_ZEN_SPOOF=1` and is unverified against the live gateway:
 * it is unknown whether Zen accepts `tool_choice: "none"` as a genuine agentic
 * turn. Paid Zen/Go one-shots get the identity headers only, matching the main
 * agent, with no body spoof.
 */
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createOpencodeMessageId,
	isFreeOpencodeModel,
	isOpencodeModel,
	opencodeSessionId,
	parseSpoofScope,
	resolveOpencodeProjectId,
	resolveOpencodeVersion,
	shouldSpoofOpencode,
	SPOOF_SCOPE_ENV,
	SPOOFED_CLIENT,
} from "./shared/opencode-zen.ts";

/** Cross-reload singleton state (same idiom as rpiv's `Symbol.for` stores). */
const STATE_KEY = Symbol.for("pi-plugins.opencode-session-id");

/** Marks a ModelRuntime whose completion methods are already wrapped. */
const PATCHED_KEY = Symbol.for("pi-plugins.opencode-session-id.patched");

/** Opt-in toggle for the free-tier Zen spoof (default off). */
const ZEN_SPOOF_ENV = "PI_OPENCODE_ZEN_SPOOF";

/** Tool names Zen's free-tier body gate looks for. */
const GATE_TOOL_NAMES = ["bash", "glob", "grep", "read"] as const;

interface SessionState {
	sessionId?: string;
	/** Working directory, for the `x-opencode-project` value. */
	cwd?: string;
	/** Live registry, used at call time to tell whether `opencode` uses OAuth. */
	modelRegistry?: ExtensionContext["modelRegistry"];
}

interface RuntimeLike {
	completeSimple?: (model: Model<Api>, context: Context, options?: unknown) => unknown;
	complete?: (model: Model<Api>, context: Context, options?: unknown) => unknown;
	[key: symbol]: unknown;
}

function sessionState(): SessionState {
	const g = globalThis as unknown as Record<symbol, unknown>;
	let state = g[STATE_KEY] as SessionState | undefined;
	if (!state) {
		state = {};
		g[STATE_KEY] = state;
	}
	return state;
}

function zenSpoofEnabled(): boolean {
	const value = process.env[ZEN_SPOOF_ENV]?.trim().toLowerCase();
	return value === "1" || value === "on" || value === "true" || value === "yes";
}

/**
 * Mirror `opencode-client-spoof`'s scope so an extension one-shot never sends
 * a different identity than the main agent under the same account. Only the
 * opt-in free-tier body spoof is separate; session-id routing is unchanged.
 */
function shouldSpoofOneShot(model: Model<Api>): boolean {
	const scope = parseSpoofScope(process.env[SPOOF_SCOPE_ENV]);
	let usingOAuth = false;
	try {
		usingOAuth = sessionState().modelRegistry?.isUsingOAuth(model) ?? false;
	} catch {
		// Registry unavailable (e.g. test double): treat as unauthenticated.
	}
	return shouldSpoofOpencode({ scope, model, usingOAuth });
}

function hasSessionId(options: unknown): boolean {
	return Boolean(options && typeof options === "object" && (options as { sessionId?: unknown }).sessionId);
}

function hasTools(context: unknown): boolean {
	const tools = context && typeof context === "object" ? (context as { tools?: unknown }).tools : undefined;
	return Array.isArray(tools) && tools.length > 0;
}

/**
 * Minimal declarations for the Zen free-tier body gate. Descriptions/schemas
 * are ignored by the gate, so these are intentionally tiny; `toolChoice: "none"`
 * keeps the model from ever selecting them.
 */
function gateTools(): Tool[] {
	return GATE_TOOL_NAMES.map((name) => ({
		name,
		description: `${name} (gate stub)`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
	})) as Tool[];
}

/**
 * Build the spoofed options/context for a Zen one-shot.
 *
 * Identity headers are always spoofed when the scope says so (so main-agent
 * and one-shot requests never disagree). The gate tool names + `toolChoice`
 * are only injected for free-tier models when the legacy
 * `PI_OPENCODE_ZEN_SPOOF` opt-in is set; paid Zen needs no body spoof.
 */
function spoofZen(piSessionId: string, options: unknown, context: unknown, injectGateTools: boolean) {
	const opts = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
	const zenSessionId = opencodeSessionId(piSessionId);
	const nextOptions: Record<string, unknown> = {
		...opts,
		sessionId: zenSessionId,
		headers: {
			...(opts.headers as Record<string, string> | undefined),
			"User-Agent": `opencode/${resolveOpencodeVersion()}`,
			"x-opencode-client": SPOOFED_CLIENT,
			"x-opencode-session": zenSessionId,
			"x-opencode-project": resolveOpencodeProjectId(sessionState().cwd),
			"x-opencode-request": createOpencodeMessageId(),
		},
	};
	let nextContext = context;
	if (injectGateTools && !hasTools(context)) {
		nextContext = { ...(context && typeof context === "object" ? context : {}), tools: gateTools() };
		if (!("toolChoice" in opts)) nextOptions.toolChoice = "none";
	}
	return { options: nextOptions, context: nextContext };
}

/** Wrap the runtime's one-shot completions once, filling in the session id. */
function patchRuntime(runtime: unknown): void {
	if (!runtime || typeof runtime !== "object") return;
	const target = runtime as RuntimeLike;
	if (target[PATCHED_KEY]) return;

	for (const method of ["completeSimple", "complete"] as const) {
		const original = target[method];
		if (typeof original !== "function") continue;
		target[method] = function (this: unknown, model: Model<Api>, context: Context, options?: unknown) {
			// Read the id at call time: `/new`, `/resume`, and `/fork` change it
			// without re-wrapping (the runtime instance is shared across sessions).
			const sessionId = sessionState().sessionId;
			if (!sessionId || !isOpencodeModel(model)) {
				return original.call(this, model, context, options);
			}
			if (shouldSpoofOneShot(model)) {
				// Free-tier one-shots need the body gate; keep that behind the
				// unverified opt-in. Paid Zen only needs the identity headers.
				const injectGateTools = isFreeOpencodeModel(model) && zenSpoofEnabled();
				const spoofed = spoofZen(sessionId, options, context, injectGateTools);
				return original.call(this, model, spoofed.context, spoofed.options);
			}
			const next = hasSessionId(options) ? options : { ...(options as object | undefined), sessionId };
			return original.call(this, model, context, next);
		};
	}
	target[PATCHED_KEY] = true;
}

function install(_event: unknown, ctx: ExtensionContext): void {
	try {
		sessionState().sessionId = ctx.sessionManager.getSessionId();
	} catch {
		// Stale ctx after session replacement — the previous id is still valid.
	}
	sessionState().modelRegistry = ctx.modelRegistry;
	sessionState().cwd = ctx.cwd;
	patchRuntime((ctx.modelRegistry as unknown as { runtime?: unknown }).runtime);
}

export default function opencodeSessionIdExtension(pi: ExtensionAPI): void {
	pi.on("session_start", install);
}
