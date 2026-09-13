import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const userConfigFile = join(process.env.HOME ?? "", ".pi", "agent", "model-hotkeys.json");
const bundledConfigFile = join(dirname(fileURLToPath(import.meta.url)), "..", "model-hotkeys.json");
const CONFIG_FILE = existsSync(userConfigFile) ? userConfigFile : bundledConfigFile;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type ModelBinding = {
	provider: string;
	model: string;
	thinking?: ThinkingLevel;
	label?: string;
};

function loadBindings(): Record<string, ModelBinding> {
	if (!existsSync(CONFIG_FILE)) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	} catch (error) {
		throw new Error(`Could not parse ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${CONFIG_FILE} must contain an object of shortcut bindings`);
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
		if (binding.thinking !== undefined &&
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(binding.thinking as string)) {
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
		pi.registerShortcut(shortcut, {
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
