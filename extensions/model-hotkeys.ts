import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
	type ModelBinding,
	parseModelBindings,
	resolveHotkeysConfigPath,
} from "./shared/model-hotkeys.ts";

const userConfigFile = join(process.env.HOME ?? "", ".pi", "agent", "model-hotkeys.json");
const bundledConfigFile = join(dirname(fileURLToPath(import.meta.url)), "..", "model-hotkeys.json");
// Prefer the machine-local file, but fall back to the copy that ships with the
// plugin so the hotkeys work even with no local config.
const CONFIG_FILE = resolveHotkeysConfigPath(userConfigFile, bundledConfigFile);

function loadBindings(): Record<string, ModelBinding> {
	if (!existsSync(CONFIG_FILE)) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	} catch (error) {
		throw new Error(`Could not parse ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
	}

	return parseModelBindings(parsed, CONFIG_FILE);
}

async function activateBinding(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	shortcut: string,
	binding: ModelBinding,
): Promise<void> {
	const model = ctx.modelRegistry.find(binding.provider, binding.model);
	if (!model) {
		ctx.ui.notify(`Model not found: ${binding.provider}/${binding.model}`, "error");
		return;
	}

	if (!(await pi.setModel(model))) {
		ctx.ui.notify(`Authentication unavailable for ${binding.provider}`, "error");
		return;
	}

	if (binding.thinking) pi.setThinkingLevel(binding.thinking);
	ctx.ui.notify(`Model: ${binding.label ?? model.name ?? binding.model} (${shortcut})`, "info");
}

export default function modelHotkeys(pi: ExtensionAPI): void {
	let bindings: Record<string, ModelBinding>;
	try {
		bindings = loadBindings();
	} catch (error) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		});
		return;
	}

	for (const [shortcut, binding] of Object.entries(bindings)) {
		pi.registerShortcut(shortcut as KeyId, {
			description: `Switch to ${binding.label ?? `${binding.provider}/${binding.model}`}`,
			handler: async (ctx) => activateBinding(pi, ctx, shortcut, binding),
		});
	}

	pi.registerCommand("model-hotkeys", {
		description: "Show configured model hotkeys",
		handler: async (_args, ctx) => {
			const entries = Object.entries(bindings);
			if (entries.length === 0) {
				ctx.ui.notify(`No model hotkeys configured in ${CONFIG_FILE}`, "warning");
				return;
			}
			ctx.ui.notify(
				entries.map(([key, value]) => `${key}: ${value.label ?? `${value.provider}/${value.model}`}`).join("\n"),
				"info",
			);
		},
	});
}
