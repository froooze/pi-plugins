/**
 * compact-per-model - fixed auto-compact threshold per model.
 *
 * Blackhole's own threshold knobs (`compactAfterTokens` / `compactAfterRatio` /
 * `compactAfterPreset`) are global: one value governs every model. This
 * extension adds the per-model layer blackhole lacks:
 *
 * - On `agent_end` (settled run, never aborts a turn) it compares
 *   `ctx.getContextUsage()` against a fixed token threshold resolved for the
 *   *active* model (`provider/id` → `provider/*` → `default`).
 * - On crossing, it calls `ctx.compact()`, which still flows through
 *   blackhole's `session_before_compact` pipeline — blackhole keeps owning
 *   the *engine* (deterministic summary), this extension owns the *timing*.
 *
 * 300k is blackhole's global backstop (set in the global config by
 * `blackhole-defaults.ts`; a project-local config or `PI_BLACKHOLE_*` env var
 * can shadow it). This extension sets the operative policy *below* it: 295k
 * for the listed 1M-window models (muse-spark, glm, deepseek V4), 249k as the
 * fallback default for unlisted models, 230k for luna
 * (~85% of its 272k window), 165k for mimo-v2.6-flash-free (82.5% of its
 * 200k window — the fallback would sit above that window itself). Every
 * per-model value is strictly under the 300k backstop, so per-model timing
 * always wins and blackhole only fires as the safety net (disabled /
 * cooldown / stale-ctx cases) — the two triggers no
 * longer race on the same boundary. Blackhole still owns the *engine*
 * (deterministic summary) for every compaction.
 *
 * Config lives in `<agentDir>/compact-per-model.json`. Only values that
 * differ from code DEFAULTS are persisted, so future DEFAULTS changes
 * propagate for keys never explicitly set. Missing keys fall back to
 * DEFAULTS:
 * {
 *   "enabled": true,
 *   "default": 249000,          // fallback for unlisted models
 *   "midRun": false,            // also check on turn_end (aborts the run!)
 *   "cooldownMs": 30000,
 *   "notify": true,
 *   "models": {
 *     "opencode/muse-spark-1.3-contributor-free": 295000,
 *     "openai-codex/gpt-5.6-luna": 230000,
 *     "opencode/mimo-v2.6-flash-free": 165000,
 *     "opencode-go/deepseek-v4.1-flash": 295000
 *   }
 * }
 *
 * Command: `/compact-per-model [status|on|off|set <provider/model> <n>|remove <provider/model>|default <n>|midrun <on|off>]`
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	COMPACT_PER_MODEL_1M,
	COMPACT_PER_MODEL_LUNA,
	COMPACT_PER_MODEL_MIMO,
	COMPACT_PER_MODEL_DEFAULT,
} from "./shared/compaction.ts";

type Config = {
	enabled: boolean;
	default: number;
	midRun: boolean;
	cooldownMs: number;
	notify: boolean;
	models: Record<string, number>;
	// DEFAULTS keys explicitly deleted at runtime via `remove`. Needed
	// because sparse persistence would otherwise re-add them on reload.
	removedModels: string[];
};

const DEFAULTS: Config = {
	enabled: true,
	default: COMPACT_PER_MODEL_DEFAULT,
	midRun: false,
	cooldownMs: 30_000,
	notify: true,
	removedModels: [],
	// 295k is the operative policy for the listed 1M-window models, strictly
	// below blackhole's 300k global backstop (`blackhole-defaults.ts`) so
	// per-model timing always wins and blackhole stays a pure fallback. luna
	// undercuts at ~85% of its 272k window (short-context pricing tier); 85% of
	// 272k = 231.2k → 230k. The 249k fallback (`default`) still applies to any
	// unlisted model — except mimo-v2.6-flash-free, which has only a 200k
	// window: there the fallback would sit *above* the wall and the trigger
	// could never fire, so it is pinned at 165k (82.5%; 35k headroom still
	// covers its 32k max output).
	models: {
		"opencode/muse-spark-1.3-contributor-free": COMPACT_PER_MODEL_1M,
		"opencode/muse-spark-1.3": COMPACT_PER_MODEL_1M,
		"opencode/muse-spark-1.2-contributor-free": COMPACT_PER_MODEL_1M,
		"opencode/muse-spark-1.2": COMPACT_PER_MODEL_1M,
		"opencode-go/glm-5.3-flash": COMPACT_PER_MODEL_1M,
		"opencode/glm-5.3-flash": COMPACT_PER_MODEL_1M,
		"opencode-go/deepseek-v4.1-flash": COMPACT_PER_MODEL_1M,
		"opencode-go/deepseek-v4-flash": COMPACT_PER_MODEL_1M,
		"opencode-go/deepseek-v4-flash-vision-exp": COMPACT_PER_MODEL_1M,
		"opencode-go/deepseek-v4-pro": COMPACT_PER_MODEL_1M,
		"opencode/deepseek-v4-flash": COMPACT_PER_MODEL_1M,
		"opencode/deepseek-v4-flash-vision-exp": COMPACT_PER_MODEL_1M,
		"opencode/deepseek-v4-pro": COMPACT_PER_MODEL_1M,
		"openai-codex/gpt-5.6-luna": COMPACT_PER_MODEL_LUNA,
		"opencode/gpt-5.6-luna": COMPACT_PER_MODEL_LUNA,
		"opencode-go/gpt-5.6-luna": COMPACT_PER_MODEL_LUNA,
		"opencode/mimo-v2.6-flash-free": COMPACT_PER_MODEL_MIMO,
		"opencode-go/mimo-v2.6-flash-free": COMPACT_PER_MODEL_MIMO,
	},
};

const CONFIG_FILE_NAME = "compact-per-model.json";
const STATUS_KEY = "compact-per-model";

function configPath(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return join(override || getAgentDir(), CONFIG_FILE_NAME);
}

function isPositiveInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function loadConfig(): Config {
	const cfg: Config = { ...DEFAULTS, models: { ...DEFAULTS.models }, removedModels: [] };
	let raw: Record<string, unknown> = {};
	try {
		if (existsSync(configPath())) {
			const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				return cfg; // Wrong shape: ignore file, use defaults.
			}
			// Note: legacy full snapshots (every key present) load fine and
			// are migrated to sparse form on the next save.
			raw = parsed as Record<string, unknown>;
		}
	} catch {
		return cfg; // Corrupt file: defaults rather than breaking startup.
	}
	if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
	if (isPositiveInt(raw.default)) cfg.default = raw.default;
	if (typeof raw.midRun === "boolean") cfg.midRun = raw.midRun;
	if (typeof raw.cooldownMs === "number" && Number.isFinite(raw.cooldownMs) && raw.cooldownMs >= 0) {
		cfg.cooldownMs = Math.floor(raw.cooldownMs);
	}
	if (typeof raw.notify === "boolean") cfg.notify = raw.notify;
	if (raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)) {
		for (const [k, v] of Object.entries(raw.models as Record<string, unknown>)) {
			if (typeof k === "string" && isPositiveInt(v)) cfg.models[k] = v;
		}
	}
	if (Array.isArray(raw.removedModels)) {
		for (const k of raw.removedModels) {
			if (typeof k === "string") {
				delete cfg.models[k];
				cfg.removedModels.push(k);
			}
		}
	}
	return cfg;
}

// Persist only values that differ from code DEFAULTS, so future DEFAULTS
// changes propagate for keys never explicitly set. A full snapshot would
// pin every value at first write and silently freeze the defaults.
function saveConfig(cfg: Config): void {
	const path = configPath();
	mkdirSync(join(path, ".."), { recursive: true });
	const out: Record<string, unknown> = {};
	if (cfg.enabled !== DEFAULTS.enabled) out.enabled = cfg.enabled;
	if (cfg.default !== DEFAULTS.default) out.default = cfg.default;
	if (cfg.midRun !== DEFAULTS.midRun) out.midRun = cfg.midRun;
	if (cfg.cooldownMs !== DEFAULTS.cooldownMs) out.cooldownMs = cfg.cooldownMs;
	if (cfg.notify !== DEFAULTS.notify) out.notify = cfg.notify;
	const models: Record<string, number> = {};
	for (const [k, v] of Object.entries(cfg.models)) {
		if (DEFAULTS.models[k] !== v) models[k] = v;
	}
	if (Object.keys(models).length > 0) out.models = models;
	if (cfg.removedModels.length > 0) out.removedModels = [...cfg.removedModels];
	writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
}

function modelKey(provider: string | undefined, id: string | undefined): string | undefined {
	if (!provider || !id) return undefined;
	return `${provider}/${id}`;
}

/** Exact `provider/id` → `provider/*` → `default`. */
function thresholdFor(cfg: Config, provider: string | undefined, id: string | undefined): number {
	const key = modelKey(provider, id);
	if (key && isPositiveInt(cfg.models[key])) return cfg.models[key];
	if (provider && isPositiveInt(cfg.models[`${provider}/*`])) return cfg.models[`${provider}/*`];
	return cfg.default;
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function notify(
	ctx: ExtensionContext,
	cfg: Config,
	message: string,
	level: "info" | "warning" | "error",
): void {
	if (!cfg.notify || !ctx.hasUI) return;
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Stale ctx after session replacement — safe to ignore.
	}
}

export default function compactPerModel(pi: ExtensionAPI) {
	let cfg = loadConfig();
	let compactInFlight = false;
	let lastTriggerAt = 0;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			if (!cfg.enabled) {
				ctx.ui.setStatus(STATUS_KEY, "🗜 off");
				return;
			}
			const usage = ctx.getContextUsage();
			const tokens = usage?.tokens ?? null;
			const threshold = thresholdFor(cfg, ctx.model?.provider, ctx.model?.id);
			if (tokens === null) {
				ctx.ui.setStatus(STATUS_KEY, `🗜`);
				return;
			}
			const pct = threshold ? ` ${((tokens / threshold) * 100).toFixed(0)}%` : "";
			ctx.ui.setStatus(STATUS_KEY, `🗜${pct}`);
		} catch {
			// Stale ctx — ignore.
		}
	}

	function maybeTrigger(ctx: ExtensionContext, source: string): void {
		if (!cfg.enabled || compactInFlight) return;
		let usage: ReturnType<ExtensionContext["getContextUsage"]>;
		try {
			usage = ctx.getContextUsage();
		} catch {
			return; // Stale ctx.
		}
		const tokens = usage?.tokens ?? null;
		if (tokens === null) return; // Unknown (e.g. right after a compaction).
		const threshold = thresholdFor(cfg, ctx.model?.provider, ctx.model?.id);
		updateStatus(ctx);
		if (tokens < threshold) return;
		if (Date.now() - lastTriggerAt < cfg.cooldownMs) return;

		compactInFlight = true;
		lastTriggerAt = Date.now();
		const key = modelKey(ctx.model?.provider, ctx.model?.id) ?? "unknown-model";
		notify(
			ctx,
			cfg,
			`compact-per-model: ${formatTokens(tokens)} over ${formatTokens(threshold)} (${key}, ${source}) — compacting…`,
			"info",
		);
		try {
			ctx.compact({
				onComplete: () => {
					compactInFlight = false;
					notify(ctx, cfg, "compact-per-model: compaction complete", "info");
					updateStatus(ctx);
				},
				onError: (error) => {
					compactInFlight = false;
					// Benign race: blackhole (or pi native) compacted first,
					// so there is nothing left for us to do. Stay quiet.
					if (/already compacted|nothing to compact|pressure relieved|compaction cancelled/i.test(error.message)) {
						updateStatus(ctx);
						return;
					}
					notify(ctx, cfg, `compact-per-model: compaction failed: ${error.message}`, "error");
					updateStatus(ctx);
				},
			});
		} catch (error) {
			compactInFlight = false;
			notify(
				ctx,
				cfg,
				`compact-per-model: could not trigger: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		cfg = loadConfig();
		compactInFlight = false;
		updateStatus(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		compactInFlight = false;
		updateStatus(ctx);
	});

	// Settled-run trigger: safe, never aborts an in-flight turn.
	pi.on("agent_end", (_event, ctx) => {
		try {
			maybeTrigger(ctx, "agent_end");
		} catch {
			// Stale ctx — ignore.
		}
	});

	// Mid-run trigger: fires while the agent is still working and aborts the
	// run (continuation is left to the user). Opt-in via "midRun".
	pi.on("turn_end", (_event, ctx) => {
		if (!cfg.midRun) return;
		try {
			maybeTrigger(ctx, "turn_end");
		} catch {
			// Stale ctx — ignore.
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		compactInFlight = false;
		updateStatus(ctx);
	});

	pi.on("session_compact_failed", (_event, ctx) => {
		compactInFlight = false;
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		// Threshold is per-model; refresh the footer on switches.
		updateStatus(ctx);
	});

	pi.registerCommand("compact-per-model", {
		description: "Show or change per-model compact thresholds",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "status").toLowerCase();

			const show = (): void => {
				const usage = ctx.getContextUsage();
				const tokens = usage?.tokens ?? null;
				const threshold = thresholdFor(cfg, ctx.model?.provider, ctx.model?.id);
				const key = modelKey(ctx.model?.provider, ctx.model?.id) ?? "unknown-model";
				const pct =
					tokens !== null && tokens > 0
						? ` (${((tokens / threshold) * 100).toFixed(0)}% of threshold)`
						: "";
				const entries = Object.entries(cfg.models)
					.map(([k, v]) => `${k}=${formatTokens(v)}`)
					.join(", ");
				ctx.ui.notify(
					`compact-per-model: ${cfg.enabled ? "on" : "off"}, ${key} → ${formatTokens(threshold)}${pct}, default ${formatTokens(cfg.default)}, midRun ${cfg.midRun ? "on" : "off"} [${entries}]`,
					"info",
				);
			};

			switch (sub) {
				case "status":
				case "":
					show();
					break;
				case "on":
					cfg.enabled = true;
					saveConfig(cfg);
					ctx.ui.notify("compact-per-model: enabled", "info");
					break;
				case "off":
					cfg.enabled = false;
					saveConfig(cfg);
					ctx.ui.notify("compact-per-model: disabled", "info");
					break;
				case "set": {
					// /compact-per-model set <provider/model> <tokens>
					const [target, value] = [parts[1], parts[2]];
					const n = value !== undefined ? Math.floor(Number(value)) : NaN;
					if (!target?.includes("/") || !Number.isFinite(n) || n <= 0) {
						ctx.ui.notify("Usage: /compact-per-model set <provider/model> <tokens>", "error");
						break;
					}
					cfg.models[target] = n;
					cfg.removedModels = cfg.removedModels.filter((k) => k !== target);
					saveConfig(cfg);
					ctx.ui.notify(`compact-per-model: ${target} → ${formatTokens(n)}`, "info");
					break;
				}
				case "remove": {
					const target = parts[1];
					if (!target || !(target in cfg.models)) {
						ctx.ui.notify("Usage: /compact-per-model remove <provider/model>", "error");
						break;
					}
					delete cfg.models[target];
					// Tombstone: without this, the sparse file stays silent
					// and the DEFAULTS entry resurrects on reload. Re-`set`
					// clears the tombstone again.
					if (target in DEFAULTS.models && !cfg.removedModels.includes(target)) {
						cfg.removedModels.push(target);
					}
					saveConfig(cfg);
					ctx.ui.notify(`compact-per-model: ${target} removed (falls back)`, "info");
					break;
				}
				case "default": {
					const n = Math.floor(Number(parts[1]));
					if (!Number.isFinite(n) || n <= 0) {
						ctx.ui.notify("Usage: /compact-per-model default <tokens>", "error");
						break;
					}
					cfg.default = n;
					saveConfig(cfg);
					ctx.ui.notify(`compact-per-model: default → ${formatTokens(n)}`, "info");
					break;
				}
				case "midrun": {
					if (parts[1] !== "on" && parts[1] !== "off") {
						ctx.ui.notify("Usage: /compact-per-model midrun <on|off>", "error");
						break;
					}
					cfg.midRun = parts[1] === "on";
					saveConfig(cfg);
					ctx.ui.notify(`compact-per-model: mid-run trigger ${parts[1]}`, "info");
					break;
				}
				default:
					ctx.ui.notify(
						"Usage: /compact-per-model [status|on|off|set <provider/model> <tokens>|remove <provider/model>|default <tokens>|midrun <on|off>]",
						"error",
					);
			}
			updateStatus(ctx);
		},
	});
}
