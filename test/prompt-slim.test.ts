/**
 * Tests for extensions/shared/prompt-slim.ts pure logic.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/prompt-slim.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	DROPPED_GUIDELINE_SUBSTRINGS,
	applyPromptSlim,
	extractDocsPaths,
	pruneGuidelines,
	resolvePromptSlimMode,
	slimDocsSection,
} from "../extensions/shared/prompt-slim.ts";

test("slimDocsSection keeps the three roots and the resolve rule", () => {
	const text = slimDocsSection({ readme: "/r/README.md", docs: "/d", examples: "/e" });
	assert.match(text, /Main documentation: \/r\/README\.md/);
	assert.match(text, /Additional docs: \/d/);
	assert.match(text, /Examples: \/e/);
	assert.match(text, /Resolve docs\/\.\.\. under Additional docs/);
});

test("slimDocsSection drops the per-topic enumeration", () => {
	const text = slimDocsSection({ readme: "r", docs: "d", examples: "e" });
	assert.doesNotMatch(text, /When asked about:/);
	assert.doesNotMatch(text, /docs\/extensions\.md/);
});

test("extractDocsPaths round-trips through slimDocsSection", () => {
	const paths = { readme: "/pi/README.md", docs: "/pi/docs", examples: "/pi/examples" };
	const rendered = `Guidelines:\n- do things\n\n${slimDocsSection(paths)}\n\nCurrent working directory: /x`;
	assert.deepEqual(extractDocsPaths(rendered), paths);
});

test("extractDocsPaths returns undefined when the section is absent", () => {
	assert.equal(extractDocsPaths("no documentation section here"), undefined);
});

test("pruneGuidelines drops known redundant bullets and keeps the rest", () => {
	const guidelines: Record<string, string[]> = {
		todo: [
			"Use `todo` for complex work with 3+ steps",
			"To change a task's status, call update with the task id",
			"list hides tombstoned (deleted) tasks by default",
			"Subject must be short and imperative",
			"Task status is a 4-state machine: pending → in_progress → completed",
		],
		recall: [
			"Use recall — literal text/regex search across session history",
			"Use recall — when a drill-down path matches multiple files, options are listed",
		],
		fffind: [
			"fffind: matches the WHOLE path, not just the filename",
			"fffind: use for paths, not content. Use ffgrep for content.",
			"fffind: use exclude: 'test/,*.min.js' to cut noise",
		],
		ffgrep: [
			"ffgrep: prefer bare identifiers as patterns. Literal queries are most efficient.",
			"ffgrep: use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').",
			"ffgrep: caseSensitive: true when you need exact case (smart-case otherwise).",
			"ffgrep: after 1-2 greps, read the top match instead of more greps.",
		],
		edit: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied.",
		],
		bash: ["You can inspect PI_* environment variables for current model and session details."],
		read: ["Use read to examine files instead of cat or sed."],
	};

	const removed = pruneGuidelines(guidelines);

	// todo 4/5, recall 2/2, fffind 2/3, ffgrep 2/4, edit 1/2, bash 1/1.
	assert.equal(removed, 4 + 2 + 2 + 2 + 1 + 1);
	assert.deepEqual(guidelines.todo, ["Use `todo` for complex work with 3+ steps"]);
	assert.deepEqual(guidelines.recall, []);
	assert.deepEqual(guidelines.fffind, [
		"fffind: matches the WHOLE path, not just the filename",
	]);
	assert.deepEqual(guidelines.ffgrep, [
		"ffgrep: prefer bare identifiers as patterns. Literal queries are most efficient.",
		"ffgrep: after 1-2 greps, read the top match instead of more greps.",
	]);
	// Only the snippet/description restatement is dropped; the "matched against
	// the original file" semantics bullet survives.
	assert.deepEqual(guidelines.edit, [
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied.",
	]);
	assert.deepEqual(guidelines.bash, []);
	// Untouched tools pass through unchanged.
	assert.deepEqual(guidelines.read, ["Use read to examine files instead of cat or sed."]);
});

test("pruneGuidelines is idempotent", () => {
	const guidelines: Record<string, string[]> = {
		todo: ["keep", "list hides tombstoned (deleted) tasks by default"],
	};
	assert.equal(pruneGuidelines(guidelines), 1);
	assert.equal(pruneGuidelines(guidelines), 0);
	assert.deepEqual(guidelines.todo, ["keep"]);
});

test("pruneGuidelines leaves unknown tools and missing tools alone", () => {
	const guidelines: Record<string, string[]> = { unknown: ["a", "b"] };
	assert.equal(pruneGuidelines(guidelines), 0);
	assert.deepEqual(guidelines, { unknown: ["a", "b"] });
});

test("every drop rule is a non-empty substring list", () => {
	for (const [tool, needles] of Object.entries(DROPPED_GUIDELINE_SUBSTRINGS)) {
		assert.ok(needles.length > 0, `${tool} has no needles`);
		for (const needle of needles) assert.ok(needle.length > 0, `${tool} has an empty needle`);
	}
});

test("resolvePromptSlimMode parses values and defaults to all", () => {
	assert.equal(resolvePromptSlimMode(undefined), "all");
	assert.equal(resolvePromptSlimMode(""), "all");
	assert.equal(resolvePromptSlimMode("  ALL "), "all");
	assert.equal(resolvePromptSlimMode("docs"), "docs");
	assert.equal(resolvePromptSlimMode("guidelines"), "guidelines");
	for (const off of ["off", "0", "false", "none", " OFF "]) {
		assert.equal(resolvePromptSlimMode(off), "off");
	}
});

test("applyPromptSlim compacts docs and drops guidelines", () => {
	const rendered = `Guidelines:\n- x\n\n${slimDocsSection({ readme: "/r", docs: "/d", examples: "/e" })}`;
	const options = {
		sections: {} as Record<string, string>,
		toolGuidelines: { bash: ["keep me", "You can inspect PI_* environment variables"] },
	};
	const removed = applyPromptSlim(options, rendered, "all");
	assert.equal(removed, 1);
	assert.match(options.sections.docs ?? "", /Main documentation: \/r/);
	assert.ok(!/When asked about:/.test(options.sections.docs ?? ""));
	assert.deepEqual(options.toolGuidelines.bash, ["keep me"]);
});

test("applyPromptSlim is a safe no-op on older pi options (no sections/toolGuidelines)", () => {
	const legacy: { customPrompt?: string } = {};
	assert.equal(applyPromptSlim(legacy, "", "all"), 0);
});

test("applyPromptSlim does not touch a custom/replaced system prompt", () => {
	const options = { customPrompt: "custom", sections: {}, toolGuidelines: { bash: ["a"] } };
	assert.equal(applyPromptSlim(options, "", "all"), 0);
	assert.deepEqual(options.sections, {});
	assert.deepEqual(options.toolGuidelines.bash, ["a"]);
});

test("applyPromptSlim respects mode off/docs/guidelines", () => {
	const rendered = slimDocsSection({ readme: "/r", docs: "/d", examples: "/e" });
	const off = { sections: {}, toolGuidelines: { bash: ["You can inspect PI_* environment variables"] } };
	assert.equal(applyPromptSlim(off, rendered, "off"), 0);
	assert.deepEqual(off.sections, {});

	const docsOnly = { sections: {} as Record<string, string>, toolGuidelines: { bash: ["You can inspect PI_* environment variables"] } };
	applyPromptSlim(docsOnly, rendered, "docs");
	assert.ok(docsOnly.sections.docs);
	assert.equal(docsOnly.toolGuidelines.bash.length, 1);

	const guideOnly = { sections: {} as Record<string, string>, toolGuidelines: { bash: ["You can inspect PI_* environment variables"] } };
	assert.equal(applyPromptSlim(guideOnly, rendered, "guidelines"), 1);
	assert.equal(guideOnly.sections.docs, undefined);
});
