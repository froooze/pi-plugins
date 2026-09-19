/**
 * Shared prompt-slim policy: the parts of the per-request system prompt that
 * are safe to compact because the model already receives the same information
 * elsewhere (tool description / parameter schema, or the docs/ directory).
 *
 * Pure data + functions only — no pi imports — so the extension and its unit
 * tests can share one source of truth.
 *
 * NOTE: this file lives in a subdirectory without an `index.ts`, so pi's
 * extension discovery does not load it as an extension.
 */

/** Root paths substituted into the compact docs section. */
export interface DocsPaths {
	readme: string;
	docs: string;
	examples: string;
}

/**
 * Compact replacement for pi's built-in `<docs>` section. Keeps the three
 * documentation roots and the rules that matter, and drops the long
 * "When asked about: extensions (docs/extensions.md, ...), themes (...), ..."
 * enumeration — the model can list `docs/` when it actually needs a file.
 */
export function slimDocsSection({ readme, docs, examples }: DocsPaths): string {
	return [
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
		`- Main documentation: ${readme}`,
		`- Additional docs: ${docs}`,
		`- Examples: ${examples} (extensions, custom tools, SDK)`,
		"- Resolve docs/... under Additional docs and examples/... under Examples; read pi .md files completely and follow their cross-references.",
	].join("\n");
}

/**
 * Pull the three doc roots out of the already-rendered system prompt. The
 * running pi renders these with the correct install paths; importing
 * `getReadmePath()` from an extension would instead resolve the host package
 * via the extension's own `node_modules`, which can be a different copy.
 * Returns undefined when the expected lines are absent (custom prompt, another
 * extension rewrote the section, …) so the caller can leave docs untouched.
 */
export function extractDocsPaths(systemPrompt: string): DocsPaths | undefined {
	const match = systemPrompt.match(
		/- Main documentation: (.+)\n- Additional docs: (.+)\n- Examples: (.+?) \(/,
	);
	if (!match) return undefined;
	return { readme: match[1].trim(), docs: match[2].trim(), examples: match[3].trim() };
}

/**
 * Tool `promptGuidelines` bullets that only restate text already present in
 * the tool's description or parameter schema. Matched by exact substring so a
 * pinned extension bump that changes its wording stops matching (and therefore
 * stops being dropped) instead of being silently overridden.
 */
export const DROPPED_GUIDELINE_SUBSTRINGS: Readonly<Record<string, readonly string[]>> = {
	// `update` action + its example are documented by the tool description and
	// TodoParamsSchema; `includeDeleted`/`status` are schema fields; the subject
	// rule is a soft preference.
	todo: [
		"To change a task's status",
		"list hides tombstoned",
		"Subject must be short and imperative",
	],
	// "Only full-file writes are indexed" is repeated in recall's `query`
	// parameter description.
	recall: ["when a drill-down path matches multiple files"],
	// Redundant cross-reference / niche alternative to a plain glob.
	fffind: ["use for paths, not content", "to list everything inside a directory"],
	// Niche; PI_* env vars are discoverable when needed.
	bash: ["inspect PI_* environment variables"],
};

/**
 * Remove the redundant bullets above from the tool-guideline map, in place.
 * Returns how many bullets were dropped this call (0 once already slimmed, so
 * repeated `before_agent_start` runs are idempotent).
 */
export function pruneGuidelines(toolGuidelines: Record<string, string[]>): number {
	let removed = 0;
	for (const [tool, needles] of Object.entries(DROPPED_GUIDELINE_SUBSTRINGS)) {
		const lines = toolGuidelines[tool];
		if (!lines?.length) continue;
		const kept = lines.filter((line) => !needles.some((needle) => line.includes(needle)));
		if (kept.length !== lines.length) {
			toolGuidelines[tool] = kept;
			removed += lines.length - kept.length;
		}
	}
	return removed;
}

export type PromptSlimMode = "all" | "docs" | "guidelines" | "off";

/** Shape of the prompt options prompt-slim touches (subset of pi's). */
export interface SlimmablePromptOptions {
	customPrompt?: string;
	forceSystemPrompt?: unknown;
	sections?: Record<string, string>;
	toolGuidelines?: Record<string, string[]>;
}

/**
 * Apply the prompt-slim transforms to `options` in place and return how many
 * guideline bullets were removed. A safe no-op on older pi builds that expose
 * neither `sections` nor `toolGuidelines` (flat `promptGuidelines` only), and
 * when a custom/replaced system prompt means pi's built-in sections are absent.
 */
export function applyPromptSlim(
	options: SlimmablePromptOptions,
	systemPrompt: string,
	mode: PromptSlimMode,
): number {
	if (mode === "off") return 0;
	if (options.customPrompt || options.forceSystemPrompt !== undefined) return 0;

	const trimDocs = mode === "all" || mode === "docs";
	const trimGuidelines = mode === "all" || mode === "guidelines";

	if (trimDocs && options.sections) {
		const paths = extractDocsPaths(systemPrompt);
		if (paths) options.sections.docs = slimDocsSection(paths);
	}

	if (trimGuidelines && options.toolGuidelines) {
		return pruneGuidelines(options.toolGuidelines);
	}
	return 0;
}

/** Parse `PI_PROMPT_SLIM`; anything unrecognized (or unset) means "all". */
export function resolvePromptSlimMode(raw: string | undefined): PromptSlimMode {
	const value = raw?.trim().toLowerCase();
	if (value === "off" || value === "0" || value === "false" || value === "none") return "off";
	if (value === "docs") return "docs";
	if (value === "guidelines") return "guidelines";
	return "all";
}
