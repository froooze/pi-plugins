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
 * Operative auto-compact threshold (tokens) for the listed 1M-window models
 * (muse-spark, glm, deepseek V4) in `compact-per-model.ts`. Must stay strictly
 * below `COMPACT_BACKSTOP_TOKENS` so per-model timing always wins and blackhole
 * only fires as the safety net.
 *
 * DeepSeek is empirically proven to serve ~298k (34 turns >256k, max 297,822,
 * all successful); muse/glm are set to match by choice and are not yet observed
 * that high.
 */
export const COMPACT_PER_MODEL_1M = 295_000;

/**
 * Auto-compact threshold (tokens) for `gpt-5.6-luna`: ~85% of its 272k
 * short-context pricing-tier window (85% of 272k = 231.2k → 230k). Lowered
 * from 90% (245k) to widen headroom to the tier boundary: with the
 * `agent_end`-only trigger, a long tool loop can overshoot 272k before the
 * threshold is evaluated. The short-context tier drives billing, so this must
 * not be raised back toward 272k casually.
 */
export const COMPACT_PER_MODEL_LUNA = 230_000;

/**
 * Fallback auto-compact threshold (tokens) for models not listed in
 * `compact-per-model.ts`. Kept conservative because an unlisted model may have
 * a small window; explicitly listed 1M-window models use
 * `COMPACT_PER_MODEL_1M` instead.
 */
export const COMPACT_PER_MODEL_DEFAULT = 249_000;

/**
 * Blackhole's global backstop (tokens) — the `compactAfterTokens` value pinned
 * by `blackhole-defaults.ts`. Must stay strictly above every per-model value
 * above, so `compact-per-model`'s `agent_end` timing always fires first and
 * blackhole only serves as the safety net (disabled / cooldown / stale-ctx).
 * `test/compaction.test.ts` enforces the invariant.
 */
export const COMPACT_BACKSTOP_TOKENS = 300_000;

/**
 * How much recent tool output blackhole may retain in the post-compaction
 * context, as a fraction of the operative 1M-window compaction threshold.
 * Tracking the threshold keeps the budget proportional as the policy changes
 * instead of freezing at a number a config file was first written with.
 */
export const RETAINED_TOOL_OUTPUT_RATIO = 0.1;

/** Retained tool-output budget (tokens); 10% of 295k = 29500. */
export const RETAINED_TOOL_OUTPUT_MAX_TOKENS = Math.round(
	COMPACT_PER_MODEL_1M * RETAINED_TOOL_OUTPUT_RATIO,
);

/**
 * Pi's recent-context retention after a compaction cut
 * (`compaction.keepRecentTokens` in Pi's global `settings.json`). Blackhole runs
 * with `tailBehavior: "pi-default"`, so it honours Pi's cut and this is the
 * verbatim tail that survives each compaction. Sized at roughly double
 * `RETAINED_TOOL_OUTPUT_MAX_TOKENS` so the kept tail is about half tool output
 * and half conversation; on a 1M-window model a 60k tail is ~6%.
 *
 * `blackhole-defaults.ts` mirrors this into `settings.json`. Pi reads settings
 * once at startup, so the write takes effect after `/reload` or a restart.
 * `test/compaction.test.ts` enforces that it exceeds the tool-output budget.
 */
export const KEEP_RECENT_TOKENS = 60_000;
