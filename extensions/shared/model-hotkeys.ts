/**
 * Config resolution and validation for the model hotkeys.
 *
 * The bindings ship with the package in the repo-versioned `model-hotkeys.json`
 * at the package root, so every machine gets them through the
 * `git:github.com/froooze/pi-plugins` package. A machine may override them with
 * its own `<agentDir>/model-hotkeys.json`; when that file is absent we fall back
 * to the bundled copy so the plugin's hotkeys always work out of the box.
 *
 * NOTE: like `model-defaults.ts`, this lives in a subdirectory without an
 * `index.ts`, so pi's extension discovery does not load it as an extension.
 */
import { existsSync } from "node:fs";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelBinding = {
	provider: string;
	model: string;
	thinking?: ThinkingLevel;
	label?: string;
};

/**
 * Pick the config file to read: the machine-local file when it exists,
 * otherwise the bundled file that ships with the plugin.
 */
export function resolveHotkeysConfigPath(userConfigFile: string, bundledConfigFile: string): string {
	return existsSync(userConfigFile) ? userConfigFile : bundledConfigFile;
}

/**
 * Validate a parsed `model-hotkeys.json` object into bindings.
 * Throws with a `sourceFile`-qualified message on any malformed entry.
 */
export function parseModelBindings(parsed: unknown, sourceFile: string): Record<string, ModelBinding> {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${sourceFile} must contain an object of shortcut bindings`);
	}

	const bindings: Record<string, ModelBinding> = {};
	for (const [shortcut, value] of Object.entries(parsed)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`Binding ${shortcut} must be an object`);
		}

		const binding = value as Record<string, unknown>;
		if (typeof binding.provider !== "string" || typeof binding.model !== "string") {
			throw new Error(`Binding ${shortcut} requires string provider and model fields`);
		}
		if (binding.thinking !== undefined && !THINKING_LEVELS.includes(binding.thinking as ThinkingLevel)) {
			throw new Error(`Binding ${shortcut} has an invalid thinking level`);
		}

		bindings[shortcut] = {
			provider: binding.provider,
			model: binding.model,
			thinking: binding.thinking as ThinkingLevel | undefined,
			label: typeof binding.label === "string" ? binding.label : undefined,
		};
	}

	return bindings;
}
