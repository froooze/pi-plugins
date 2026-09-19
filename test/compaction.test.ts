/**
 * Tests for the centralized compaction thresholds in
 * extensions/shared/compaction.ts.
 *
 * These are policy invariants, not behavior: they guard against a future edit
 * raising a per-model threshold past blackhole's global backstop (which would
 * make the two triggers race on the same boundary) or letting the derived
 * retained-output budget drift from the threshold it tracks.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/compaction.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	COMPACT_BACKSTOP_TOKENS,
	COMPACT_PER_MODEL_1M,
	COMPACT_PER_MODEL_DEFAULT,
	COMPACT_PER_MODEL_LUNA,
	KEEP_RECENT_TOKENS,
	RETAINED_TOOL_OUTPUT_MAX_TOKENS,
	RETAINED_TOOL_OUTPUT_RATIO,
} from "../extensions/shared/compaction.ts";

test("every per-model threshold stays strictly below the blackhole backstop", () => {
	const highest = Math.max(COMPACT_PER_MODEL_1M, COMPACT_PER_MODEL_LUNA, COMPACT_PER_MODEL_DEFAULT);
	assert.ok(
		highest < COMPACT_BACKSTOP_TOKENS,
		`highest per-model threshold ${highest} must be < backstop ${COMPACT_BACKSTOP_TOKENS}`,
	);
});

test("retained tool-output budget is derived from the 1M threshold", () => {
	assert.equal(
		RETAINED_TOOL_OUTPUT_MAX_TOKENS,
		Math.round(COMPACT_PER_MODEL_1M * RETAINED_TOOL_OUTPUT_RATIO),
	);
});

test("the Pi kept tail is larger than the retained tool-output budget", () => {
	// Blackhole runs `tailBehavior: pi-default`, so `keepRecentTokens` is the
	// verbatim tail. It must exceed the tool-output sub-budget for that budget to
	// bind inside the tail (otherwise it is silently inert).
	assert.ok(
		KEEP_RECENT_TOKENS > RETAINED_TOOL_OUTPUT_MAX_TOKENS,
		`keepRecentTokens ${KEEP_RECENT_TOKENS} must exceed the tool-output budget ${RETAINED_TOOL_OUTPUT_MAX_TOKENS}`,
	);
});
