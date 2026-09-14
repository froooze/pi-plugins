/**
 * blackhole-defaults - mirror our preferred pi-blackhole settings on every machine.
 *
 * pi-blackhole reads its config from `<agentDir>/pi-blackhole/pi-blackhole-config.json`
 * (global file; project-local `<cwd>/.pi/pi-blackhole-config.json` and env vars like
 * `PI_BLACKHOLE_MEMORY` override it). That file is machine-local and not versioned,
 * so fresh installs lose our choices.
 *
 * On `session_start` this backfills preferred defaults for keys that are ABSENT
 * (never overwriting explicit choices) and enforces ENFORCED_DEFAULTS even when
 * present with a different value. Delete a key from a table to stop managing it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Preferred defaults. Only applied when the key is missing from the global file. */
const PREFERRED_DEFAULTS: Record<string, unknown> = {
	// `compaction: "auto"` + `compactionEngine: "blackhole"` makes pi's native
	// threshold auto-compact, overflow recovery, and `/compact` all run through
	// blackhole's deterministic zero-LLM pipeline instead of the LLM summarizer.
	compaction: "auto",
	compactionEngine: "blackhole",
};

/**
 * Enforced values. Applied even when the key exists with a different value.
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
	// Global standard threshold (299k). An explicit `compactAfterTokens`
	// always wins over blackhole's `compactAfterRatio` / preset curve, so
	// pinning it here disables the built-in `default` preset (which would
	// otherwise fire at ~189k on 272k-window models and undercut luna's
	// 255k per-model threshold). compact-per-model carries the same 299k
	// for 1M-window models and undercuts with 255k for luna; blackhole
	// remains the fallback safety net and still owns the *engine*
	// (deterministic summary) for every compaction.
	compactAfterTokens: 299_000,
};

function blackholeConfigPath(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = override || getAgentDir();
	return join(agentDir, "pi-blackhole", "pi-blackhole-config.json");
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
	});
}
