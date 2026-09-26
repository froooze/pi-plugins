/**
 * blackhole-defaults - warn when a blackhole/Pi setting is shadowed.
 *
 * The preferred and enforced pi-blackhole values (engine, `tailBehavior:
 * pi-default`, 300k backstop, 29.5k retained tool output, memory off, ...) and
 * Pi's `compaction.keepRecentTokens` cut are declared in the repo-versioned
 * `settings-defaults.json` and written by the `settings-defaults` extension.
 * This extension only reports the sources that still outrank those global
 * values at runtime, so the user knows the enforced value is not the effective
 * one:
 *
 *   - a project-local `<cwd>/.pi/pi-blackhole-config.json` or `PI_BLACKHOLE_*`
 *     env var shadows an enforced blackhole value;
 *   - a project-local `<cwd>/.pi/settings.json` or a per-model
 *     `compaction.modelOverrides[...]` entry shadows Pi's enforced cut size.
 *
 * Handling the config write in one place means this extension can be
 * read-only: it never recurses into directories it does not own.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBundledConfig } from "./shared/settings-defaults.ts";

/**
 * Env vars that shadow enforced pi-blackhole values at runtime, with the same
 * parsing blackhole uses (see pi-blackhole `src/core/config-env.ts`). Invalid
 * values are ignored by blackhole, so they are ignored here too. Keys must
 * match the `pi-blackhole` target's `enforce` map in settings-defaults.json.
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
	statusBar: {
		var: "PI_BLACKHOLE_STATUSBAR",
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

/** Pi's global settings file (`<agentDir>/settings.json`). */
function piSettingsPath(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = override || getAgentDir();
	return join(agentDir, "settings.json");
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
 * Return descriptions of enforced blackhole keys that a higher-precedence
 * source will override at runtime. Only differences are reported, so
 * re-asserting an enforced value stays quiet.
 */
function detectShadows(cwd: string, enforced: Record<string, unknown>): string[] {
	const shadows: string[] = [];
	const project = readJsonObject(join(cwd, ".pi", "pi-blackhole-config.json"));
	if (project) {
		for (const [key, value] of Object.entries(enforced)) {
			if (key in project && project[key] !== value) {
				shadows.push(`${key}=${JSON.stringify(project[key])} (project config)`);
			}
		}
	}
	for (const [key, spec] of Object.entries(ENFORCED_ENV_VARS)) {
		const raw = process.env[spec.var];
		if (raw === undefined) continue;
		const parsed = spec.parse(raw);
		if (parsed !== undefined && parsed !== enforced[key]) {
			shadows.push(`${key}=${JSON.stringify(parsed)} (${spec.var})`);
		}
	}
	return shadows;
}

/**
 * Report Pi-side sources that shadow the enforced global `keepRecentTokens`:
 * a project-local `<cwd>/.pi/settings.json`, or a per-model
 * `compaction.modelOverrides[...]` entry in the global file. Both win over the
 * global value in Pi's resolver, so we surface rather than fight them.
 */
function detectPiShadows(cwd: string, keepRecentTokens: number): string[] {
	const shadows: string[] = [];

	const projectCompaction = readJsonObject(join(cwd, ".pi", "settings.json"))?.compaction;
	if (projectCompaction !== null && typeof projectCompaction === "object" && !Array.isArray(projectCompaction)) {
		const value = (projectCompaction as Record<string, unknown>).keepRecentTokens;
		if (value !== undefined && value !== keepRecentTokens) {
			shadows.push(`keepRecentTokens=${JSON.stringify(value)} (.pi/settings.json)`);
		}
	}

	const overrides = (readJsonObject(piSettingsPath())?.compaction as Record<string, unknown> | undefined)
		?.modelOverrides;
	if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) {
		for (const [model, entry] of Object.entries(overrides as Record<string, unknown>)) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
			const value = (entry as Record<string, unknown>).keepRecentTokens;
			if (value !== undefined && value !== keepRecentTokens) {
				shadows.push(`keepRecentTokens=${JSON.stringify(value)} (modelOverrides["${model}"])`);
			}
		}
	}

	return shadows;
}

export default function blackholeDefaults(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const config = loadBundledConfig();
		const enforced = config.targets["pi-blackhole"]?.enforce ?? {};

		try {
			for (const shadow of detectShadows(ctx.cwd, enforced)) {
				ctx.ui.notify(
					`blackhole-defaults: ${shadow} shadows an enforced global value — pi-blackhole will use that instead`,
					"warning",
				);
			}
		} catch {
			// Never let shadow detection break startup.
		}

		const keepRecentTokens = config.targets.settings?.enforce?.["compaction.keepRecentTokens"];
		if (typeof keepRecentTokens === "number") {
			try {
				for (const shadow of detectPiShadows(ctx.cwd, keepRecentTokens)) {
					ctx.ui.notify(
						`blackhole-defaults: ${shadow} shadows the enforced keepRecentTokens — Pi will use that instead`,
						"warning",
					);
				}
			} catch {
				// Never let shadow detection break startup.
			}
		}
	});
}
