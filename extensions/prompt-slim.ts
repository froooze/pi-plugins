/**
 * prompt-slim - trim redundant per-request system-prompt overhead.
 *
 * Pi sends the whole system prompt (preamble + tools + rules + docs) on every
 * request. Most of it is load-bearing, but two parts are duplication of text
 * the model already gets elsewhere:
 *
 *   1. The `<docs>` section ends with a long "When asked about: extensions
 *      (docs/extensions.md, ...), themes (...), ..." enumeration that repeats
 *      the file names in docs/. The model can list docs/ when it needs one.
 *
 *   2. Several bundled tools repeat the same instructions in their
 *      `promptGuidelines` (which land in the system prompt's <rules>) and in
 *      their tool description / parameter schema (which is sent separately in
 *      the request's `tools`). The redundant bullets are dropped so the model
 *      still gets each instruction exactly once.
 *
 * Both happen in `before_agent_start` by mutating `systemPromptOptions`, which
 * pi re-renders into the request. The mutations are idempotent, so repeat runs
 * converge.
 *
 * Deliberately conservative: guideline bullets are matched by exact substring
 * (see shared/prompt-slim.ts), so a pinned extension bump that changes wording
 * simply stops matching rather than being silently overridden.
 *
 * This only touches the system prompt. Tool descriptions and parameter schemas
 * are policy owned by the upstream tool packages and are not rewritten here.
 *
 * Config: PI_PROMPT_SLIM = "all" (default) | "docs" | "guidelines" | "off".
 * Command: /prompt-slim - show mode and what was trimmed.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	applyPromptSlim,
	resolvePromptSlimMode,
} from "./shared/prompt-slim.ts";

export default function promptSlim(pi: ExtensionAPI): void {
	const mode = resolvePromptSlimMode(process.env.PI_PROMPT_SLIM);
	if (mode === "off") return;

	const trimDocs = mode === "all" || mode === "docs";
	const trimGuidelines = mode === "all" || mode === "guidelines";

	let droppedTotal = 0;

	pi.on("before_agent_start", (event) => {
		// Older pi builds expose a flat `promptGuidelines` array and no
		// `sections`/`toolGuidelines`; applyPromptSlim degrades to a no-op there.
		droppedTotal += applyPromptSlim(event.systemPromptOptions, event.systemPrompt, mode);
	});

	pi.registerCommand("prompt-slim", {
		description: "Show prompt-slim status (docs + redundant tool guidelines)",
		handler: async (_args, ctx) => {
			const lines = [`mode: ${mode}`];
			lines.push(trimDocs ? "docs: compacted" : "docs: untouched");
			lines.push(
				trimGuidelines
					? `guidelines: ${droppedTotal} redundant bullet(s) dropped this session`
					: "guidelines: untouched",
			);
			if (mode === "all") lines.push("disable with PI_PROMPT_SLIM=off");
			ctx.ui.notify(`prompt-slim\n${lines.join("\n")}`, "info");
		},
	});
}
