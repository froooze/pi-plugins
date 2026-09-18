/**
 * Shared compaction policy constants.
 *
 * Single source of truth for values that more than one extension depends on,
 * so they cannot drift apart when only one side is edited.
 *
 * NOTE: this file lives in a subdirectory without an `index.ts`, so pi's
 * extension discovery does not load it as an extension — it is imported by the
 * extensions that need it.
 */

/**
 * Operative per-model auto-compact threshold (tokens) for 1M-window models and
 * the fallback default. Must stay strictly below blackhole's 299k global
 * backstop (`blackhole-defaults.ts`) so per-model timing always wins and
 * blackhole only fires as the safety net.
 */
export const COMPACT_PER_MODEL_DEFAULT = 249_000;

/**
 * How much recent tool output blackhole may retain in the post-compaction
 * context, as a fraction of the per-model compaction threshold. Tracking the
 * threshold keeps the budget proportional as the policy changes instead of
 * freezing at a number a config file was first written with.
 */
export const RETAINED_TOOL_OUTPUT_RATIO = 0.1;

/** Retained tool-output budget (tokens); 10% of 249k = 24900. */
export const RETAINED_TOOL_OUTPUT_MAX_TOKENS = Math.round(
	COMPACT_PER_MODEL_DEFAULT * RETAINED_TOOL_OUTPUT_RATIO,
);
