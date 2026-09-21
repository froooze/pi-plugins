/**
 * settings-defaults - the single applier for every plugin's file-backed defaults.
 *
 * Pi has no native package/extension API to seed or override a machine-local
 * config: `SettingsManager.applyOverrides()` is SDK-only and in-memory, the
 * setters Pi exposes cover only selected fields and are not reachable from
 * `ExtensionContext` (which has no settings handle), and nothing lets a package
 * write another plugin's config. So this extension writes the files directly.
 *
 * Every default value lives in the repo-versioned `settings-defaults.json`
 * under `targets.<id>` (`backfill` / `enforce` / `env` — see README), and every
 * target is applied through the one shared `applySettingsDefaults` function.
 * This replaces the per-extension writes that used to live in
 * `fullscreen-mode` (tuiMode/theme), `blackhole-defaults` (pi-blackhole config)
 * and `fff-guard` (pi-fff config); those extensions now only keep their
 * non-settings behavior (shadow warnings, refusal hints).
 *
 * Pi caches `settings.json` in memory at startup, so writes apply to the next
 * session (`/reload` or restart). `pi-fff` snapshots its config at extension
 * load, so the `pi-fff` target is also applied eagerly at import, before the
 * bundled pi-fff extension loads. Malformed local values and corrupt files are
 * never clobbered; they are reported instead.
 *
 * Command: `/settings-defaults` shows every target and its effective values.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type SkippedPath,
	type SettingsDefaultsResult,
	type TargetDefaults,
	applySettingsDefaults,
	loadBundledConfig,
} from "./shared/settings-defaults.ts";

export default function settingsDefaults(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const config = loadBundledConfig();

		for (const [id, target] of Object.entries(config.targets)) {
			const path = targetPath(id);
			if (!path) continue;
			const applied = applyToFile(path, target);
			if (!applied) continue;
			announce(ctx, id, applied.result);
		}

		// The packaged theme had an immediate-apply path before this extension
		// owned it (fullscreen-mode). Keep that: the file write only takes effect
		// next startup, so apply the theme now when we're in the TUI.
		const theme = config.targets.settings?.enforce?.theme;
		if (ctx.mode === "tui" && typeof theme === "string") {
			try {
				if (ctx.ui.getTheme(theme)) ctx.ui.setTheme(theme);
			} catch {
				// Theme application is cosmetic; never break startup.
			}
		}
	});

	pi.registerCommand("settings-defaults", {
		description: "Show the centralized plugin settings defaults and their local state",
		handler: async (_args, ctx) => {
			const config = loadBundledConfig();
			const lines: string[] = ["settings-defaults"];
			for (const [id, target] of Object.entries(config.targets)) {
				const path = targetPath(id);
				if (!path) continue;
				const local = readJsonObject(path) ?? {};
				lines.push(`[${id}] ${path}`);
				for (const [key, value] of Object.entries(target.backfill ?? {})) {
					lines.push(`  backfill ${key}: default=${JSON.stringify(value)} local=${displayRead(local, key)}`);
				}
				for (const [key, value] of Object.entries(target.enforce ?? {})) {
					lines.push(`  enforce ${key}: value=${JSON.stringify(value)} local=${displayRead(local, key)}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/** Known target ids → the machine-local file they map to. Unknown ids are ignored. */
function targetPath(id: string): string | undefined {
	const dir = process.env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
	switch (id) {
		case "settings":
			return join(dir, "settings.json");
		case "pi-blackhole":
			return join(dir, "pi-blackhole", "pi-blackhole-config.json");
		case "pi-fff":
			return join(dir, "pi-fff.json");
		default:
			return undefined;
	}
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

/** Read + apply + persist one target. Returns null when the file is corrupt or unwritable. */
function applyToFile(
	path: string,
	target: TargetDefaults,
): { result: SettingsDefaultsResult; path: string } | null {
	const settings = existsSync(path) ? readJsonObject(path) : {};
	if (settings === null) return null; // Corrupt: leave it for the owning plugin to report.

	let result: SettingsDefaultsResult;
	try {
		result = applySettingsDefaults(settings, target);
	} catch {
		return null;
	}
	if (!result.changed) return { result, path };

	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(result.settings, null, 2)}\n`);
	} catch {
		return null;
	}
	return { result, path };
}

function announce(ctx: ExtensionContext, id: string, result: SettingsDefaultsResult): void {
	if (!ctx.hasUI) return;
	if (result.backfilled.length > 0) {
		ctx.ui.notify(
			`settings-defaults: [${id}] backfilled ${result.backfilled.join(", ")} — applies after /reload`,
			"info",
		);
	}
	if (result.enforced.length > 0) {
		ctx.ui.notify(
			`settings-defaults: [${id}] enforced ${result.enforced.join(", ")} — applies after /reload`,
			"info",
		);
	}
	if (result.mirrored.length > 0) {
		ctx.ui.notify(`settings-defaults: [${id}] mirrored env ${result.mirrored.join(", ")}`, "info");
	}
	if (result.skipped.length > 0) {
		ctx.ui.notify(
			`settings-defaults: [${id}] left ${describeSkipped(result.skipped)} untouched — remove the value to use the default`,
			"warning",
		);
	}
}

function describeSkipped(skipped: SkippedPath[]): string {
	return skipped
		.map(({ path, reason }) =>
			reason === "invalid-path" ? `${path} (invalid dotted path)` : `${path} (local value is not an object)`,
		)
		.join(", ");
}

function displayRead(root: Record<string, unknown>, path: string): string {
	const value = readPath(root, path);
	return value === undefined ? "—" : JSON.stringify(value);
}

/** Read a dotted path from a settings object. */
function readPath(root: Record<string, unknown>, path: string): unknown {
	let current: unknown = root;
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
		if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

// Eager apply for pi-fff only: it snapshots its config at extension load, and
// this module is imported before the bundled pi-fff extension. Silent (no ctx),
// and re-applied on session_start above so changes are reported.
try {
	const target = loadBundledConfig().targets["pi-fff"];
	if (target) {
		const path = targetPath("pi-fff");
		if (path) applyToFile(path, target);
	}
} catch {
	// session_start will retry; never break startup from here.
}
