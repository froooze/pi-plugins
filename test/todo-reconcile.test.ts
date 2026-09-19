/**
 * Tests for extensions/todo-reconcile.ts pure logic.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/todo-reconcile.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	buildNudge,
	isActive,
	isNonVoluntaryStop,
	lastAssistantStopReason,
	latestTodoSnapshot,
	type Task,
	type TaskStatus,
	sanitizeText,
} from "../extensions/todo-reconcile.ts";

function todoEntry(tasks: unknown[]) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: 99 } },
	};
}

function task(id: number, subject: string, status: TaskStatus): Task {
	return { id, subject, status };
}

test("latestTodoSnapshot: picks the last todo toolResult, ignores others", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "hi" } },
		todoEntry([task(1, "first", "completed")]),
		{ type: "message", message: { role: "toolResult", toolName: "read", details: { junk: true } } },
		todoEntry([task(1, "first", "in_progress"), task(2, "second", "pending")]),
		{ type: "message", message: { role: "assistant", stopReason: "stop" } },
	];
	const snapshot = latestTodoSnapshot(branch);
	assert.equal(snapshot?.tasks.length, 2);
	assert.equal(snapshot?.tasks[0].status, "in_progress");
});

test("latestTodoSnapshot: undefined when the tool was never called or malformed", () => {
	assert.equal(latestTodoSnapshot([]), undefined);
	assert.equal(
		latestTodoSnapshot([{ type: "message", message: { role: "toolResult", toolName: "todo", details: {} } }]),
		undefined,
	);
	assert.equal(
		latestTodoSnapshot([{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: "x" } } }]),
		undefined,
	);
});

test("latestTodoSnapshot: drops corrupt task elements instead of throwing", () => {
	const snapshot = latestTodoSnapshot([
		todoEntry([null, 42, {}, { id: 1, subject: "kept", status: "pending" }, { id: 2, status: "pending" }]),
	]);
	assert.equal(snapshot?.tasks.length, 1);
	assert.equal(snapshot?.tasks[0].subject, "kept");
});

test("latestTodoSnapshot: a clear leaves an empty snapshot, not undefined", () => {
	const snapshot = latestTodoSnapshot([todoEntry([])]);
	assert.deepEqual(snapshot?.tasks, []);
});

test("lastAssistantStopReason: last assistant message wins, scanning backwards", () => {
	const branch = [
		{ type: "message", message: { role: "assistant", stopReason: "toolUse" } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [] } } },
		{ type: "message", message: { role: "assistant", stopReason: "aborted" } },
	];
	assert.equal(lastAssistantStopReason(branch), "aborted");
	assert.equal(lastAssistantStopReason([]), undefined);
});

test("isNonVoluntaryStop: abort/error/deferred are not the model stopping", () => {
	assert.equal(isNonVoluntaryStop("aborted"), true);
	assert.equal(isNonVoluntaryStop("error"), true);
	assert.equal(isNonVoluntaryStop("deferred"), true);
	assert.equal(isNonVoluntaryStop("stop"), false);
	assert.equal(isNonVoluntaryStop("toolUse"), false);
	assert.equal(isNonVoluntaryStop(undefined), false);
});

test("isActive: blacklist — unknown statuses count as open", () => {
	assert.equal(isActive(task(1, "a", "pending")), true);
	assert.equal(isActive(task(2, "b", "in_progress")), true);
	assert.equal(isActive(task(3, "c", "completed")), false);
	assert.equal(isActive(task(4, "d", "deleted")), false);
	// A future/unknown status must not read as finished.
	assert.equal(isActive({ id: 5, subject: "e", status: "blocked" as TaskStatus }), true);
});

test("sanitizeText: strips control characters, collapses whitespace, caps length", () => {
	assert.equal(sanitizeText("a\n\nb\t c"), "a b c");
	assert.equal(sanitizeText("run \u001b[31mred\u001b[0m now"), "run [31mred [0m now");
	assert.equal(sanitizeText("  padded  "), "padded");
	assert.equal(sanitizeText("x".repeat(10), 4), "xxxx…");
});

test("buildNudge: lists tasks, notes activeForm, truncates overflow", () => {
	const tasks: Task[] = [
		{ id: 1, subject: "Implement parser", status: "pending" },
		{ id: 2, subject: "Add tests", status: "in_progress", activeForm: "writing tests" },
	];
	const message = buildNudge(tasks, 10);
	assert.match(message, /Unfinished tasks:/);
	assert.match(message, /- #1 Implement parser — pending/);
	assert.match(message, /- #2 Add tests — in_progress: writing tests/);
	assert.doesNotMatch(message, /more/);

	const many = Array.from({ length: 5 }, (_, i) => task(i + 1, `task ${i + 1}`, "pending"));
	const truncated = buildNudge(many, 2);
	assert.match(truncated, /- #1 task 1/);
	assert.match(truncated, /- #2 task 2/);
	assert.match(truncated, /…and 3 more/);
	assert.doesNotMatch(truncated, /#3 task 3/);
});

test("buildNudge: a newline in a subject cannot break the bullet list", () => {
	const message = buildNudge([task(1, "line one\nline two", "pending")], 10);
	assert.match(message, /- #1 line one line two — pending/);
	assert.doesNotMatch(message, /line one\nline two/);
});
