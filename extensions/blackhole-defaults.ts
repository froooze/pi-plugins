/**
 * blackhole-defaults - mirror our preferred pi-blackhole settings on every machine.
 *
 * pi-blackhole reads its config from `<agentDir>/pi-blackhole/pi-blackhole-config.json`
 * (global file; project-local `<cwd>/.pi/pi-blackhole-config.json` and env vars like
 * `PI_BLACKHOLE_MEMORY` override it). That file is machine-local and not versioned,
 * so fresh installs lose our choices.
 *
 * On `session_start` this backfills preferred defaults for keys that are ABSENT
 * (never overwriting explicit choices) and enforces ENFORCED_DEFAULTS in the
 * GLOBAL file. Enforcement is not absolute: blackhole merges a project-local
 * `<cwd>/.pi/pi-blackhole-config.json` over the global file and applies
 * `PI_BLACKHOLE_*` env vars last, so either can shadow an enforced value. When
 * that happens we warn instead of fighting the override. Delete a key from a
 * table to stop managing it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPACT_BACKSTOP_TOKENS, RETAINED_TOOL_OUTPUT_MAX_TOKENS } from "./shared/compaction.ts";

/** Preferred defaults. Only applied when the key is missing from the global file. */
const PREFERRED_DEFAULTS: Record<string, unknown> = {
	// `compaction: "auto"` + `compactionEngine: "blackhole"` makes pi's native
	// threshold auto-compact, overflow recovery, and `/compact` all run through
	// blackhole's deterministic zero-LLM pipeline instead of the LLM summarizer.
	compaction: "auto",
	compactionEngine: "blackhole",
};

/**
 * Enforced values, written to the GLOBAL file even when the key exists with a
 * different value. A project-local config or `PI_BLACKHOLE_*` env var takes
 * precedence at blackhole's runtime and shadows these (see `detectShadows`).
 *
 * Background observer/reflector/dropper workers share the session model's rate
 * limit when no dedicated worker models are configured, producing
 * "all model candidates exhausted" warnings on free tiers. Off until we give
 * the workers their own models. Deterministic compaction and recall are unaffected.
 * blackhole itself defaults `memory` to true and its settings modal flips it back
 * to true, so backfill-if-absent never sticks — hence enforced.
 */
const ENFORCED_DEFAULTS: Record<string, unknown> = {
	memory: false,
	// Global backstop (300k). An explicit `compactAfterTokens` always wins
	// over `compactAfterRatio` / the preset curve, so pinning it here disables
	// the built-in `default` preset for windows above ~300k. compact-per-model
	// sets the operative policy *below* this (295k listed 1M-window models, 249k
	// fallback default, luna 245k), so per-model timing fires first and this stays
	// a pure safety net (also covering disabled / cooldown / stale-ctx cases). Blackhole still owns
	// the *engine* (deterministic summary) for every compaction.
	compactAfterTokens: COMPACT_BACKSTOP_TOKENS,
	// Retain more recent tool output (20k default) in the post-compaction
	// context. Enforced so the value tracks the plugin on every machine instead
	// of freezing at whatever a config file first wrote (0 = budget disabled).
	// Derived from the shared 1M-window threshold (10%), currently 29500.
	retainedToolOutputMaxTokens: RETAINED_TOOL_OUTPUT_MAX_TOKENS,
};

/**
 * Env vars that shadow `ENFORCED_DEFAULTS` at blackhole's runtime, with the same
 * parsing blackhole uses (see pi-blackhole `src/core/config-env.ts`). Invalid
 * values are ignored by blackhole, so they are ignored here too.
 */
const ENFORCED_ENV_VARS: Record<
	string,
	{ var: string; parse: (raw: string) => unknown }
> = {
	memory: {
		var: "PI_BLACKHOLE_MEMORY",
		parse: (raw) => {
			const v = raw.trim().toLowerCase();
			if (["1", "true", "yes", "on"].includes(v)) return true;
			if (["0", "false", "no", "off"].includes(v)) return false;
			return undefined;
		},
	},
	compactAfterTokens: {
		var: "PI_BLACKHOLE_COMPACT_AFTER_TOKENS",
		parse: (raw) => {
			const n = Number(raw);
			return Number.isInteger(n) && n > 0 ? n : undefined;
		},
	},
	retainedToolOutputMaxTokens: {
		var: "PI_BLACKHOLE_RETAINED_TOOL_OUTPUT_MAX_TOKENS",
		parse: (raw) => {
			const n = Number.parseInt(raw, 10);
			return Number.isFinite(n) && n > 0 ? n : undefined;
		},
	},
};

function blackholeConfigPath(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = override || getAgentDir();
	return join(agentDir, "pi-blackhole", "pi-blackhole-config.json");
}

/** Read a JSON object from disk, or null when missing / malformed / not an object. */
function readJsonObject(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Return descriptions of enforced keys that a higher-precedence source
 * (project-local config or `PI_BLACKHOLE_*` env var) will override at runtime.
 * Only differences are reported, so re-asserting an enforced value stays quiet.
 */
function detectShadows(cwd: string): string[] {
	const shadows: string[] = [];
	const project = readJsonObject(join(cwd, ".pi", "pi-blackhole-config.json"));
	if (project) {
		for (const [key, value] of Object.entries(ENFORCED_DEFAULTS)) {
			if (key in project && project[key] !== value) {
				shadows.push(`${key}=${JSON.stringify(project[key])} (project config)`);
			}
		}
	}
	for (const [key, spec] of Object.entries(ENFORCED_ENV_VARS)) {
		const raw = process.env[spec.var];
		if (raw === undefined) continue;
		const parsed = spec.parse(raw);
		if (parsed !== undefined && parsed !== ENFORCED_DEFAULTS[key]) {
			shadows.push(`${key}=${JSON.stringify(parsed)} (${spec.var})`);
		}
	}
	return shadows;
}

function applyDefaults(): { backfilled: string[]; enforced: string[] } {
	const path = blackholeConfigPath();
	let current: Record<string, unknown> = {};
	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return { backfilled: [], enforced: [] }; // Corrupt file: leave it for blackhole itself to report.
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { backfilled: [], enforced: [] };
		}
		current = parsed as Record<string, unknown>;
	}

	const backfilled: string[] = [];
	for (const [key, value] of Object.entries(PREFERRED_DEFAULTS)) {
		if (!(key in current)) {
			current[key] = value;
			backfilled.push(key);
		}
	}
	const enforced: string[] = [];
	for (const [key, value] of Object.entries(ENFORCED_DEFAULTS)) {
		if (current[key] !== value) {
			current[key] = value;
			enforced.push(`${key}=${JSON.stringify(value)}`);
		}
	}
	if (backfilled.length === 0 && enforced.length === 0) {
		return { backfilled, enforced };
	}

	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
	return { backfilled, enforced };
}

export default function blackholeDefaults(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		let applied: { backfilled: string[]; enforced: string[] };
		try {
			applied = applyDefaults();
		} catch {
			return;
		}
		if (applied.enforced.length > 0) {
			ctx.ui.notify(
				`blackhole-defaults: enforced ${applied.enforced.join(", ")} in pi-blackhole-config.json`,
				"info",
			);
		}
		if (applied.backfilled.length > 0) {
			ctx.ui.notify(
				`blackhole-defaults: set ${applied.backfilled.join(", ")} in pi-blackhole-config.json (was absent)`,
				"info",
			);
		}

		// Enforcement only covers the global file; blackhole lets project config and
		// env vars win. Surface that instead of pretending the value always holds.
		try {
			for (const shadow of detectShadows(ctx.cwd)) {
				ctx.ui.notify(
					`blackhole-defaults: ${shadow} shadows an enforced global value — pi-blackhole will use that instead`,
					"warning",
				);
			}
		} catch {
			// Never let shadow detection break startup.
		}
	});
}
