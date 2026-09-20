/**
 * model-defaults - apply the repository-versioned startup model defaults.
 *
 * The shared defaults live in `model-defaults.json` at the package root, so
 * every machine gets them through the `git:github.com/froooze/pi-plugins`
 * package (same mechanism as `model-hotkeys.json`). Pi only reads the
 * machine-local `<agentDir>/settings.json`, and we deliberately do NOT write
 * the shared defaults there: settings.json then holds a model default only when
 * a user explicitly set one (e.g. `/model` → Ctrl+S), and that local value
 * always wins.
 *
 * On a fresh session (`session_start` reason "startup" or "new") we:
 *   1. remove managed keys from settings.json that are redundant (equal to the
 *      current shared value) or stale (equal to the previously propagated
 *      shared value, tracked in `<agentDir>/model-defaults.state.json`);
 *   2. leave any managed key that differs (explicit local choice) untouched;
 *   3. apply the shared model/thinking at runtime with `pi.setModel()` /
 *      `pi.setThinkingLevel()` when no local choice overrides it.
 *
 * CLI `--model` / `--provider` / `--thinking` always wins for that run.
 *
 * Command: `/model-defaults` shows the shared values and their local state.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MANAGED_KEYS,
	type Defaults,
	type ManagedKey,
	reconcileModelDefaults,
	resolveThinking,
} from "./shared/model-defaults.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const bundledFile = join(dirname(fileURLToPath(import.meta.url)), "..", "model-defaults.json");

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
}

function settingsPath(): string {
	return join(agentDir(), "settings.json");
}

function statePath(): string {
	return join(agentDir(), "model-defaults.state.json");
}

/** Read a JSON object, or null when missing / malformed / not an object. */
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

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The shared defaults, filtered to the managed keys. */
function loadShared(): Defaults {
	const raw = readJsonObject(bundledFile);
	const shared: Defaults = {};
	if (!raw) return shared;
	for (const key of MANAGED_KEYS) {
		if (Object.prototype.hasOwnProperty.call(raw, key)) shared[key] = raw[key];
	}
	return shared;
}

function loadPrevious(): Defaults {
	const state = readJsonObject(statePath());
	const previous = state?.shared;
	if (previous === null || typeof previous !== "object" || Array.isArray(previous)) return {};
	return previous as Defaults;
}

function savePrevious(shared: Defaults): void {
	try {
		writeJson(statePath(), { version: 1, shared });
	} catch {
		// A state-write failure only degrades stale-mirror detection; never fail startup.
	}
}

/** True when the user pinned a model/thinking on the command line for this run. */
function cliPinned(): boolean {
	return process.argv.some(
		(arg) =>
			arg === "--model" ||
			arg.startsWith("--model=") ||
			arg === "--provider" ||
			arg.startsWith("--provider=") ||
			arg === "--thinking" ||
			arg.startsWith("--thinking="),
	);
}

async function applyShared(pi: ExtensionAPI, ctx: ExtensionContext, shared: Defaults, settings: Record<string, unknown>): Promise<void> {
	const provider = shared.defaultProvider;
	const modelId = shared.defaultModel;
	if (typeof provider !== "string" || typeof modelId !== "string") return;

	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		ctx.ui.notify(`model-defaults: shared model not found: ${provider}/${modelId}`, "error");
		return;
	}

	const alreadyActive = ctx.model?.provider === model.provider && ctx.model.id === model.id;
	if (!alreadyActive && !(await pi.setModel(model))) {
		ctx.ui.notify(`model-defaults: authentication unavailable for ${provider}`, "error");
		return;
	}

	const thinking = resolveThinking(settings, shared, provider, modelId, THINKING_LEVELS);
	if (thinking && thinking !== ctx.thinkingLevel) pi.setThinkingLevel(thinking as (typeof THINKING_LEVELS)[number]);
}

export default function modelDefaults(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		// Only a fresh session should adopt the shared defaults. A resumed/forked
		// session keeps its own model, and a reload must not clobber an in-session
		// model switch.
		if (event.reason !== "startup" && event.reason !== "new") return;

		const shared = loadShared();
		if (Object.keys(shared).length === 0) return;

		const path = settingsPath();
		const settings = existsSync(path) ? readJsonObject(path) : {};
		if (settings === null) return; // Corrupt settings: leave them for Pi.

		const previous = loadPrevious();
		const result = reconcileModelDefaults(settings, shared, previous);
		if (result.changed) {
			try {
				writeJson(path, result.settings);
			} catch {
				// Never let settings cleanup break startup.
			}
		}
		savePrevious(shared);

		if (result.removed.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`model-defaults: removed redundant local ${result.removed.join(", ")} — centralized defaults now own them`,
				"info",
			);
		}

		const modelOverridden = result.overridden.includes("defaultProvider") || result.overridden.includes("defaultModel");
		if (modelOverridden) {
			if (ctx.hasUI) ctx.ui.notify("model-defaults: local settings override the shared model default", "info");
			return;
		}
		if (cliPinned()) return;

		try {
			await applyShared(pi, ctx, shared, result.settings);
		} catch {
			// Never let default application break startup.
		}
	});

	pi.registerCommand("model-defaults", {
		description: "Show the centralized model defaults and their local state",
		handler: async (_args, ctx) => {
			const shared = loadShared();
			const settings = readJsonObject(settingsPath()) ?? {};
			const previous = loadPrevious();
			const managed = MANAGED_KEYS.map((key: ManagedKey) => {
				const local = Object.prototype.hasOwnProperty.call(settings, key) ? JSON.stringify(settings[key]) : "—";
				const remote = Object.prototype.hasOwnProperty.call(shared, key) ? JSON.stringify(shared[key]) : "—";
				return `${key}: shared=${remote} local=${local}`;
			});
			ctx.ui.notify(
				`model-defaults\n${managed.join("\n")}\nstate=${statePath()}`,
				"info",
			);
		},
	});
}
