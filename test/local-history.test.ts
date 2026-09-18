/**
 * Tests for extensions/local-history.ts pure + filesystem logic.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/local-history.test.ts
 * (strip-types handles the single-file TS import; no build step needed.)
 */
import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	SessionHistory,
	applyStoredFiles,
	emptyIndex,
	findLastNonPromptId,
	findNextPromptId,
	findPrevPromptId,
	isPromptEntry,
	isSkippedPath,
	parseIndex,
	pruneOrphans,
	readCurrentFile,
	resolveBackstopAnchor,
	resolveToolPath,
	sessionDirFor,
	snapshotCurrentFile,
	sweepUnreferencedBackups,
} from "../extensions/local-history.ts";

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "local-history-test-"));
}

test("isPromptEntry: user + custom_message count, assistant does not", () => {
	assert.equal(isPromptEntry({ id: "a", type: "message", message: { role: "user" } }), true);
	assert.equal(isPromptEntry({ id: "b", type: "custom_message" }), true);
	assert.equal(isPromptEntry({ id: "c", type: "message", message: { role: "assistant" } }), false);
	assert.equal(isPromptEntry({ id: "d", type: "compaction" }), false);
});

test("findPrevPromptId: nearest prompt at/before id, root->leaf order", () => {
	const branch = [
		{ id: "u1", type: "message", message: { role: "user" } },
		{ id: "a1", type: "message", message: { role: "assistant" } },
		{ id: "u2", type: "message", message: { role: "user" } },
		{ id: "a2", type: "message", message: { role: "assistant" } },
	];
	assert.equal(findPrevPromptId(branch), "u2");
	assert.equal(findPrevPromptId(branch, "a1"), "u1");
	assert.equal(findPrevPromptId(branch, "u1"), "u1");
	assert.equal(findPrevPromptId(branch, "nope"), null);
	assert.equal(findPrevPromptId([]), null);
});

test("findNextPromptId / resolveBackstopAnchor: backstop avoids the new prompt", () => {
	const branch = [
		{ id: "u1", type: "message", message: { role: "user" } },
		{ id: "a1", type: "message", message: { role: "assistant" } },
		{ id: "u2", type: "message", message: { role: "user" } },
	];
	assert.equal(findNextPromptId(branch, "a1"), "u2");
	assert.equal(findNextPromptId(branch, "u2"), null);
	assert.equal(findNextPromptId(branch, "nope"), null);
	// Leftover captures belong to the run after the last sealed leaf.
	assert.equal(resolveBackstopAnchor(branch, "a1"), "u2");
	// No seal yet (or sealed leaf outside the branch): newest prompt wins.
	assert.equal(resolveBackstopAnchor(branch, null), "u2");
	assert.equal(resolveBackstopAnchor(branch, "gone"), "u2");
});

test("resolveToolPath / isSkippedPath", () => {
	assert.equal(resolveToolPath("/w", ""), null);
	assert.equal(resolveToolPath("/w", undefined), null);
	assert.equal(resolveToolPath("/w", "a/b.txt"), join("/w", "a/b.txt"));
	assert.equal(isSkippedPath("/w", "/w/node_modules/x.js"), true);
	assert.equal(isSkippedPath("/w", "/w/.git/refs"), true);
	assert.equal(isSkippedPath("/w", "/w/src/a.ts"), false);
	assert.equal(isSkippedPath("/w", "/elsewhere/a.ts"), false);
});

test("parseIndex: corruption and version mismatch yield empty index", () => {
	assert.deepEqual(parseIndex("not json"), emptyIndex());
	assert.deepEqual(parseIndex('{"version":999,"undo":[],"redo":[]}'), emptyIndex());
	assert.deepEqual(parseIndex('{"version":1}'), emptyIndex());
	const good = parseIndex(
		JSON.stringify({
			version: 1,
			undo: [{ id: "t", files: [{ path: "/a", backup: null, existed: false, bytes: 0 }] }],
			redo: "nope",
		}),
	);
	assert.equal(good.undo.length, 0);
	const ok = parseIndex(
		JSON.stringify({
			version: 1,
			undo: [
				{
					id: "t1",
					userMsgId: "u",
					endLeafId: "e",
					sealedAt: "s",
					files: [{ path: "/a", backup: "b.bak", existed: true, bytes: 3 }],
					skipped: ["/big"],
				},
			],
			redo: [],
		}),
	);
	assert.equal(ok.undo.length, 1);
	assert.deepEqual(ok.undo[0].skipped, ["/big"]);
});

test("capture/seal/apply round-trip restores before-image", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "a.txt");
		await writeFile(file, "v1");
		const h = new SessionHistory(join(root, "side"));
		assert.equal(await h.captureBefore(file), "captured");
		assert.equal(await h.captureBefore(file), "captured"); // first wins
		await writeFile(file, "v2");
		h.markDirty(file);
		const turn = await h.seal("u1", "e1");
		assert.equal(turn.files.length, 1);
		assert.equal(turn.files[0].existed, true);
		const res = await applyStoredFiles(h, turn.files);
		assert.deepEqual(res, { restored: 1, missing: 0, skipped: 0 });
		assert.equal(await readFile(file, "utf8"), "v1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("created-file undo deletes the file", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "new.txt");
		const h = new SessionHistory(join(root, "side"));
		assert.equal(await h.captureBefore(file), "created");
		await writeFile(file, "hello");
		h.markDirty(file);
		const turn = await h.seal("u", "e");
		const res = await applyStoredFiles(h, turn.files);
		assert.equal(res.restored, 1);
		await assert.rejects(readFile(file));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("errored tool drops pending capture, clean turn seals empty", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "a.txt");
		await writeFile(file, "v1");
		const h = new SessionHistory(join(root, "side"));
		await h.captureBefore(file);
		await h.dropPending(file);
		const turn = await h.seal("u", "e");
		assert.equal(turn.files.length, 0);
		assert.equal(await readFile(file, "utf8"), "v1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("oversized file is reported as skipped, never snapshotted", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "big.bin");
		await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 7));
		const h = new SessionHistory(join(root, "side"));
		assert.equal(await h.captureBefore(file), "skipped");
		await writeFile(file, Buffer.alloc(1024 * 1024 + 2, 8));
		h.markDirty(file);
		const turn = await h.seal("u", "e");
		assert.deepEqual(turn.skipped, [file]);
		const res = await applyStoredFiles(h, turn.files);
		assert.equal(res.skipped, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("binary before-image round-trips byte-identical", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "a.bin");
		const before = Buffer.from([0, 1, 2, 255, 254, 0, 13, 10]);
		await writeFile(file, before);
		const h = new SessionHistory(join(root, "side"));
		await h.captureBefore(file);
		await writeFile(file, Buffer.from([9, 9, 9]));
		h.markDirty(file);
		const turn = await h.seal("u", "e");
		await applyStoredFiles(h, turn.files);
		assert.deepEqual(await readFile(file), before);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("two files in one run seal into one step", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const a = join(ws, "a.txt");
		const b = join(ws, "b.txt");
		await writeFile(a, "a1");
		await writeFile(b, "b1");
		const h = new SessionHistory(join(root, "side"));
		await h.captureBefore(a);
		await h.captureBefore(b);
		await writeFile(a, "a2");
		await writeFile(b, "b2");
		h.markDirty(a);
		h.markDirty(b);
		const turn = await h.seal("u", "e");
		assert.equal(turn.files.length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("findLastNonPromptId: pins the backstop seal to a redo-navigable leaf", () => {
	const branch = [
		{ id: "u1", type: "message", message: { role: "user" } },
		{ id: "a1", type: "message", message: { role: "assistant" } },
		{ id: "u2", type: "message", message: { role: "user" } },
	];
	assert.equal(findLastNonPromptId(branch), "a1");
	assert.equal(
		findLastNonPromptId([{ id: "u1", type: "message", message: { role: "user" } }]),
		null,
	);
	assert.equal(findLastNonPromptId([]), null);
});

test("isSkippedPath matches dependency/VCS dirs at any depth", () => {
	assert.equal(isSkippedPath("/w", "/w/src/node_modules/x.js"), true);
	assert.equal(isSkippedPath("/w", "/w/a/.git/config"), true);
	assert.equal(isSkippedPath("/w", "/w/src/a.ts"), false);
});

test("enforceCaps evicts oldest-first and deletes their backups", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "a.txt");
		await writeFile(file, "v0");
		const h = new SessionHistory(join(root, "side"), { maxTurns: 3, maxBytes: 1024 * 1024 });
		for (let i = 1; i <= 5; i++) {
			await h.captureBefore(file);
			await writeFile(file, `v${i}`);
			h.markDirty(file);
			await h.seal(`u${i}`, `e${i}`);
		}
		assert.equal(h.undo.length, 3);
		assert.equal(h.undo[0].userMsgId, "u3");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("atomic restore: no truncated file on write failure", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "a.txt");
		await writeFile(file, "v1");
		const h = new SessionHistory(join(root, "side"));
		await h.captureBefore(file);
		await writeFile(file, "v2");
		h.markDirty(file);
		const turn = await h.seal("u", "e");
		await applyStoredFiles(h, turn.files);
		assert.equal(await readFile(file, "utf8"), "v1");
		// tmp+rename leaves no stray tmp files behind on success.
		const leftovers = (await readdir(join(root, "side"))).filter((n) => n.includes(".tmp"));
		assert.deepEqual(leftovers, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sweepUnreferencedBackups: crash orphans removed, referenced kept", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "a.txt");
		await writeFile(file, "v1");
		const dir = join(root, "side");
		// Crash before seal: a bk-*.bak with no owner in memory (fresh instance).
		const crashed = new SessionHistory(dir);
		await crashed.captureBefore(file);
		const h = new SessionHistory(dir);
		await writeFile(join(dir, "notes.bak"), "keep me"); // foreign name: untouched
		await sweepUnreferencedBackups(h);
		const names = await readdir(dir);
		assert.ok(!names.some((n) => n.startsWith("bk-")), `orphan swept: ${names}`);
		assert.ok(names.includes("notes.bak"));
		// A pending backup is live work: the sweep keeps it, and the later
		// seal still finds it on disk.
		await h.captureBefore(file);
		await writeFile(file, "v2");
		h.markDirty(file);
		await sweepUnreferencedBackups(h);
		assert.equal((await readdir(dir)).filter((n) => n.startsWith("bk-")).length, 1);
		const turn = await h.seal("u", "e");
		assert.equal(turn.files.length, 1);
		await sweepUnreferencedBackups(h);
		assert.equal((await readdir(dir)).filter((n) => n.startsWith("bk-")).length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("missing backup is counted, not thrown", async () => {
	const root = await tempRoot();
	try {
		const h = new SessionHistory(join(root, "side"));
		const res = await applyStoredFiles(h, [
			{ path: join(root, "x.txt"), backup: "gone.bak", existed: true, bytes: 3 },
		]);
		assert.deepEqual(res, { restored: 0, missing: 1, skipped: 0 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("snapshotCurrentFile captures present state for redo", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "a.txt");
		await writeFile(file, "now");
		const h = new SessionHistory(join(root, "side"));
		const snap = await snapshotCurrentFile(h, file);
		assert.equal(snap.existed, true);
		assert.ok(snap.backup);
		const gone = await snapshotCurrentFile(h, join(ws, "missing.txt"));
		assert.deepEqual([gone.existed, gone.backup], [false, null]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("readCurrentFile distinguishes missing from present", async () => {
	const root = await tempRoot();
	try {
		const file = join(root, "a.txt");
		await writeFile(file, "x");
		assert.equal((await readCurrentFile(file)).existed, true);
		assert.equal((await readCurrentFile(join(root, "nope"))).existed, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("load/persist round-trip keeps stacks", async () => {
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "a.txt");
		await writeFile(file, "v1");
		const dir = sessionDirFor("sess-1", root);
		const h = new SessionHistory(dir);
		await h.captureBefore(file);
		await writeFile(file, "v2");
		h.markDirty(file);
		await h.seal("u", "e");
		const h2 = new SessionHistory(dir);
		await h2.load();
		assert.equal(h2.undo.length, 1);
		assert.equal(h2.undo[0].files[0].path, file);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("event wiring: tool_call -> tool_result -> settled seals one step with anchors", async () => {
	const { default: localHistory } = await import("../extensions/local-history.ts");
	const root = await tempRoot();
	try {
		const ws = join(root, "ws");
		await mkdir(ws, { recursive: true });
		const file = join(ws, "a.txt");
		await writeFile(file, "v1");
		const handlers = new Map<string, Array<(event: never, ctx: never) => Promise<unknown>>>();
		const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
		const pi = {
			on: (event: string, handler: (event: never, ctx: never) => Promise<unknown>) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand: (
				name: string,
				opts: { handler: (args: string, ctx: never) => Promise<void> },
			) => commands.set(name, opts),
		};
		localHistory(pi as never);
		const run = async (event: string, payload: unknown, ctx: unknown) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx as never);
		};
		const branch = [
			{ id: "u1", type: "message", message: { role: "user" }, parentId: null },
			{ id: "a1", type: "message", message: { role: "assistant" }, parentId: "u1" },
		];
		const sessionId = "sess-wiring";
		const sessionDir = root;
		const eventCtx = {
			cwd: ws,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionDir: () => sessionDir,
				getBranch: () => branch,
				getLeafId: () => "a1",
				getEntry: (id: string) => branch.find((e) => e.id === id),
			},
		} as never;
		await run("session_start", { type: "session_start" }, eventCtx);
		// Failed tool: capture dropped, nothing dirty.
		await run("tool_call", { toolName: "edit", input: { path: "a.txt" } }, eventCtx);
		await run(
			"tool_result",
			{ toolName: "edit", input: { path: "a.txt" }, isError: true, content: [] },
			eventCtx,
		);
		// Successful edit, then settled seals exactly one step.
		await run("tool_call", { toolName: "edit", input: { path: "a.txt" } }, eventCtx);
		await writeFile(file, "v2");
		await run(
			"tool_result",
			{ toolName: "edit", input: { path: "a.txt" }, isError: false, content: [] },
			eventCtx,
		);
		// Settling twice without new writes seals a second (conversation-only) step.
		await run("agent_settled", { type: "agent_settled" }, eventCtx);
		await run("agent_settled", { type: "agent_settled" }, eventCtx);
		const notifies: string[] = [];
		const navTargets: string[] = [];
		const cmdCtx = {
			...(eventCtx as object),
			waitForIdle: async () => undefined,
			isIdle: () => true,
			navigateTree: async (targetId: string) => {
				navTargets.push(targetId);
				// Mirror real pi: user-message targets emit their parent leaf
				// (agent-session navigateTree retargets prompts to parentId).
				const target = branch.find((e) => e.id === targetId) as { parentId?: string } | undefined;
				const emitted = target?.parentId !== undefined ? (target.parentId as string | null) : targetId;
				await run("session_tree", { type: "session_tree", newLeafId: emitted, oldLeafId: "a1" }, eventCtx);
				return { cancelled: false };
			},
			ui: { notify: (msg: string) => void notifies.push(msg) },
		} as never;
		// Undo the empty step first (conversation-only), then the file step.
		await commands.get("undo")!.handler("", cmdCtx);
		assert.equal(navTargets.pop(), "u1");
		await commands.get("undo")!.handler("", cmdCtx);
		assert.equal(await readFile(file, "utf8"), "v1");
		// Redo restores v2.
		await commands.get("redo")!.handler("", cmdCtx);
		assert.equal(await readFile(file, "utf8"), "v2");
		// Foreign tree navigation clears the redo stack.
		await commands.get("undo")!.handler("", cmdCtx);
		assert.equal(await readFile(file, "utf8"), "v1");
		await run("session_tree", { type: "session_tree", newLeafId: "u1", oldLeafId: "a1" }, eventCtx);
		const before = notifies.length;
		await commands.get("redo")!.handler("", cmdCtx);
		assert.equal(notifies.length, before + 1);
		assert.match(notifies[notifies.length - 1], /Nothing to redo/);
		// Cancelled navigation warns instead of claiming a move; files stay restored.
		// Seed a fresh file step so the undo stack is non-empty.
		await run("tool_call", { toolName: "edit", input: { path: "a.txt" } }, eventCtx);
		await writeFile(file, "v3");
		await run(
			"tool_result",
			{ toolName: "edit", input: { path: "a.txt" }, isError: false, content: [] },
			eventCtx,
		);
		await run("agent_settled", { type: "agent_settled" }, eventCtx);
		const cancelledCtx = {
			...(cmdCtx as object),
			navigateTree: async () => ({ cancelled: true }),
		} as never;
		const warnCount = notifies.length;
		await commands.get("undo")!.handler("", cancelledCtx);
		assert.match(notifies[notifies.length - 1], /navigation was cancelled/);
		assert.equal(notifies.length, warnCount + 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("pruneOrphans removes only old unowned sidecars", async () => {
	const root = await tempRoot();
	try {
		const live = sessionDirFor("live", root);
		const orphan = sessionDirFor("orphan", root);
		await mkdir(live, { recursive: true });
		await mkdir(orphan, { recursive: true });
		await writeFile(join(root, "2026-01-01T00-00-00-000Z_live.jsonl"), "{}\n");
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await utimes(orphan, old, old);
		await utimes(live, old, old);
		await pruneOrphans(root);
		await assert.rejects(readFile(join(orphan, "index.json")));
		assert.ok(await readFile(join(root, "2026-01-01T00-00-00-000Z_live.jsonl")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
