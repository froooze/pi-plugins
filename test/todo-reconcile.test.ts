/**
 * Tests for extensions/todo-reconcile.ts pure logic.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/todo-reconcile.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	buildNudge,
	evaluateSettle,
	hasAwaitMarker,
	hasProgressSince,
	isActive,
	isAwaitingInput,
	isNonVoluntaryStop,
	lastAssistantInfo,
	lastAssistantStopReason,
	latestTodoSnapshot,
	newNudgeState,
	readAssistantContent,
	type Task,
	type TaskStatus,
	todoSnapshotKey,
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

function assistantEntry(content: unknown, stopReason = "stop") {
	return { type: "message", message: { role: "assistant", content, stopReason } };
}

function textMsg(role: string, text: string) {
	return { type: "message", message: { role, content: [{ type: "text", text }] } };
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

test("buildNudge: asks for the explicit Awaiting input marker", () => {
	const message = buildNudge([task(1, "a", "pending")], 10);
	assert.match(message, /`Awaiting input:`/);
});

test("readAssistantContent: joins text, flags tool calls", () => {
	assert.deepEqual(readAssistantContent("plain"), { text: "plain", hasToolCalls: false });
	assert.deepEqual(
		readAssistantContent([
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "1", name: "bash" },
			{ type: "text", text: "world" },
		]),
		{ text: "hello\nworld", hasToolCalls: true },
	);
	assert.deepEqual(readAssistantContent(undefined), { text: "", hasToolCalls: false });
});

test("lastAssistantInfo: last assistant wins, carries stopReason and text", () => {
	const info = lastAssistantInfo([
		assistantEntry([{ type: "text", text: "first" }], "toolUse"),
		{ type: "message", message: { role: "toolResult", toolName: "bash" } },
		assistantEntry([{ type: "text", text: "final" }], "stop"),
	]);
	assert.equal(info?.text, "final");
	assert.equal(info?.stopReason, "stop");
	assert.equal(info?.hasToolCalls, false);
	assert.equal(lastAssistantInfo([]), undefined);
});

test("hasAwaitMarker: detects the explicit marker line", () => {
	assert.equal(hasAwaitMarker("Done.\nAwaiting input: which branch?"), true);
	assert.equal(hasAwaitMarker("awaiting input: need a key"), true);
	assert.equal(hasAwaitMarker("All finished, no marker here."), false);
});

test("isAwaitingInput: marker wins even with heuristics off; questions only when on", () => {
	const marker = { text: "x\nAwaiting input: please advise", hasToolCalls: false };
	assert.equal(isAwaitingInput(marker, false), true);

	const question = { text: "Should I proceed?", hasToolCalls: false };
	assert.equal(isAwaitingInput(question, true), true);
	assert.equal(isAwaitingInput(question, false), false);

	const phrase = { text: "Let me know which option you prefer.", hasToolCalls: false };
	assert.equal(isAwaitingInput(phrase, true), true);

	const working = { text: "Running the suite now", hasToolCalls: true };
	assert.equal(isAwaitingInput(working, true), false);

	const summary = { text: "Reconciled and committed. No commits made.", hasToolCalls: false };
	assert.equal(isAwaitingInput(summary, true), false);
});

test("todoSnapshotKey: changes when a status changes, not on order", () => {
	const before = { tasks: [task(1, "a", "pending"), task(2, "b", "in_progress")] };
	const after = { tasks: [task(1, "a", "completed"), task(2, "b", "in_progress")] };
	assert.equal(todoSnapshotKey(before), "1:pending|2:in_progress");
	assert.notEqual(todoSnapshotKey(before), todoSnapshotKey(after));
	assert.equal(todoSnapshotKey(undefined), "");
});

test("hasProgressSince: tool results and assistant tool calls count, user text does not", () => {
	const branch = [
		textMsg("assistant", "doing it"),
		{ type: "message", message: { role: "toolResult", toolName: "bash" } },
	];
	assert.equal(hasProgressSince(branch, 1), true);
	assert.equal(hasProgressSince(branch, 2), false);
	assert.equal(hasProgressSince(branch, 0), true);
	assert.equal(hasProgressSince(branch, 99), true); // branch changed underneath

	const onlyUser = [
		textMsg("assistant", "done"),
		textMsg("user", "Your turn ended, but the todo list still has unfinished work."),
	];
	assert.equal(hasProgressSince(onlyUser, 1), false);

	const toolCallOnly = [assistantEntry([{ type: "toolCall", id: "1", name: "bash" }])];
	assert.equal(hasProgressSince(toolCallOnly, 0), true);
});

test("evaluateSettle: full decision table", () => {
	const base = { detectQuestions: true };
	const worked = { text: "Ran the tests, all green.", hasToolCalls: false };
	const asked = { text: "Should I apply option A?", hasToolCalls: false };

	// first settle of a turn, model stopped without asking -> nudge
	assert.equal(
		evaluateSettle({ state: newNudgeState(), assistant: worked, progressed: false, ...base }),
		"nudge",
	);
	// first settle but the model asked -> awaiting, no nudge
	assert.equal(
		evaluateSettle({ state: newNudgeState(), assistant: asked, progressed: false, ...base }),
		"awaiting",
	);
	// already latched awaiting -> stay silent regardless of progress
	assert.equal(
		evaluateSettle({ state: { ...newNudgeState(), nudged: true, awaitingInput: true }, assistant: worked, progressed: true, ...base }),
		"latched",
	);
	// nudged already, no new work -> anti-loop
	assert.equal(
		evaluateSettle({ state: { ...newNudgeState(), nudged: true }, assistant: worked, progressed: false, ...base }),
		"no-progress",
	);
	// nudged, made progress, did not ask -> nudge again (no cap)
	for (let i = 0; i < 10; i++) {
		assert.equal(
			evaluateSettle({ state: { ...newNudgeState(), nudged: true }, assistant: worked, progressed: true, ...base }),
			"nudge",
		);
	}
	// nudged, made progress, then asked -> awaiting
	assert.equal(
		evaluateSettle({ state: { ...newNudgeState(), nudged: true }, assistant: asked, progressed: true, ...base }),
		"awaiting",
	);
});
