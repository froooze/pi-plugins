/**
 * blackhole-defaults - mirror our preferred pi-blackhole settings on every machine.
 *
 * pi-blackhole reads its config from `<agentDir>/pi-blackhole/pi-blackhole-config.json`
 * (global file; project-local `<cwd>/.pi/pi-blackhole-config.json` and env vars like
 * `PI_BLACKHOLE_MEMORY` override it). That file is machine-local and not versioned,
 * so fresh installs lose our choices.
 *
 * On `session_start` this backfills our preferred defaults for keys that are ABSENT.
 * Explicit user choices are never overwritten — delete a key from this table to stop
 * managing it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Preferred defaults. Only applied when the key is missing from the global file. */
const PREFERRED_DEFAULTS: Record<string, unknown> = {
	// Background observer/reflector/dropper workers share the session model's rate
	// limit when no dedicated worker models are configured, producing
	// "all model candidates exhausted" warnings on free tiers. Off until we give
	// the workers their own models. Deterministic compaction and recall are unaffected.
	memory: false,
	// `compaction: "auto"` + `compactionEngine: "blackhole"` makes pi's native
	// threshold auto-compact, overflow recovery, and `/compact` all run through
	// blackhole's deterministic zero-LLM pipeline instead of the LLM summarizer.
	compaction: "auto",
	compactionEngine: "blackhole",
};

function blackholeConfigPath(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = override || getAgentDir();
	return join(agentDir, "pi-blackhole", "pi-blackhole-config.json");
}

function backfillDefaults(): string[] {
	const path = blackholeConfigPath();
	let current: Record<string, unknown> = {};
	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return []; // Corrupt file: leave it for blackhole itself to report.
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return [];
		}
		current = parsed as Record<string, unknown>;
	}

	const applied: string[] = [];
	for (const [key, value] of Object.entries(PREFERRED_DEFAULTS)) {
		if (!(key in current)) {
			current[key] = value;
			applied.push(key);
		}
	}
	if (applied.length === 0) return [];

	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
	return applied;
}

export default function blackholeDefaults(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		let applied: string[];
		try {
			applied = backfillDefaults();
		} catch {
			return;
		}
		if (applied.length > 0) {
			ctx.ui.notify(
				`blackhole-defaults: set ${applied.join(", ")} in pi-blackhole-config.json (was absent)`,
				"info",
			);
		}
	});
}
