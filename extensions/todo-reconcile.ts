/**
 * todo-reconcile — nudge the model when a settled turn leaves `rpiv-todo`
 * tasks unfinished.
 *
 * rpiv-todo owns the todo list and its overlay, but nothing forces the model
 * to finish what it planned. When a run settles (`agent_settled`: after
 * retries, auto-compaction, and queued follow-ups — the point where Pi will
 * not continue on its own) this extension inspects the list and, if any
 * task is still open, injects one follow-up user message telling the model to
 * reconcile: mark already-done work completed, finish work that is still
 * outstanding, or say what it is blocked on.
 *
 * Why a follow-up instead of an in-package hook: rpiv-todo ships as a pinned
 * tarball and its live store is per-extension-module (Pi loads each extension
 * with `moduleCache: false`), so a sibling extension cannot read that Map.
 * The list is already persisted in the session branch — every successful
 * `todo` tool call returns the full post-mutation snapshot under `details`
 * and rpiv-todo rebuilds from the last one (`state/replay.ts`). This
 * extension replays the same branch, so it needs no shared state, no fork
 * bump, and it survives `/reload` and compaction exactly like the overlay.
 *
 * Loop safety — exactly one nudge per user turn:
 * - A session that has been nudged is remembered until the next non-extension
 *   input (extension-sent messages, including our own injected nudge, are
 *   tagged `source: "extension"` and do not clear it), the list goes clean, a
 *   `/tree` navigation changes the branch, or the session shuts down. Slash
 *   commands are dispatched before the `input` event, so they do not clear it.
 * - A non-voluntary stop never nudges: user abort, exhausted error, or a
 *   deferred operation is not the model choosing to stop.
 * - Interactive TUI only. Headless/print sessions and subagents have nothing
 *   to nudge; RPC/JSON consumers are programmatic and must not receive an
 *   unsolicited user turn.
 *
 * Config (optional), `<agentDir>/todo-reconcile.json` (or
 * `$PI_CODING_AGENT_DIR/todo-reconcile.json`):
 * {
 *   "enabled": true,
 *   "maxTasksShown": 10
 * }
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type Task = {
	id: number;
	subject: string;
	status: TaskStatus;
	activeForm?: string;
};

type TodoSnapshot = { tasks: Task[] };

type BranchEntry = {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
		stopReason?: string;
	};
};

const TOOL_NAME = "todo";
const CONFIG_FILE_NAME = "todo-reconcile.json";
const DEFAULT_MAX_TASKS_SHOWN = 10;
/** Per-field cap for a task line, so one huge subject cannot bloat the nudge. */
const MAX_FIELD_LEN = 200;

/**
 * Stop reasons where Pi stopped for a reason other than the model choosing to:
 * a user abort, an exhausted provider error, or a deferred external operation.
 * Nudging in those cases re-enters the same failure or fights a pending op.
 */
const NON_VOLUNTARY_STOP_REASONS = new Set(["aborted", "error", "deferred"]);

type Config = {
	enabled: boolean;
	maxTasksShown: number;
};

const DEFAULTS: Config = {
	enabled: true,
	maxTasksShown: DEFAULT_MAX_TASKS_SHOWN,
};

function configPath(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return join(override || getAgentDir(), CONFIG_FILE_NAME);
}

function loadConfig(): Config {
	const cfg: Config = { ...DEFAULTS };
	let raw: Record<string, unknown> = {};
	try {
		if (existsSync(configPath())) {
			const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return cfg;
			raw = parsed as Record<string, unknown>;
		}
	} catch {
		return cfg; // Corrupt config: defaults, never break the session.
	}
	if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
	if (typeof raw.maxTasksShown === "number" && Number.isInteger(raw.maxTasksShown) && raw.maxTasksShown > 0) {
		cfg.maxTasksShown = raw.maxTasksShown;
	}
	return cfg;
}

/** Structural guard for a persisted task; skips corrupt/older entries instead of throwing. */
function isTaskLike(value: unknown): value is Task {
	if (!value || typeof value !== "object") return false;
	const t = value as Record<string, unknown>;
	return typeof t.id === "number" && typeof t.subject === "string" && typeof t.status === "string";
}

/** Latest persisted `todo` snapshot in the branch, or undefined if the tool was never called. */
export function latestTodoSnapshot(branch: Iterable<unknown>): TodoSnapshot | undefined {
	let result: TodoSnapshot | undefined;
	for (const entry of branch) {
		const e = entry as BranchEntry;
		if (e?.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
		const details = msg.details;
		if (!details || typeof details !== "object") continue;
		const tasks = (details as { tasks?: unknown }).tasks;
		if (!Array.isArray(tasks)) continue;
		result = { tasks: tasks.filter(isTaskLike) };
	}
	return result;
}

/** Stop reason of the last assistant message in the branch (scan from the end). */
export function lastAssistantStopReason(branch: Iterable<unknown>): string | undefined {
	const entries = Array.from(branch);
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as BranchEntry;
		if (e?.type === "message" && e.message?.role === "assistant") return e.message.stopReason;
	}
	return undefined;
}

/** Whether the settle was not the model choosing to stop (abort / error / deferred). */
export function isNonVoluntaryStop(stopReason: string | undefined): boolean {
	return stopReason !== undefined && NON_VOLUNTARY_STOP_REASONS.has(stopReason);
}

/**
 * Any status that is not explicitly finished. Blacklist, not whitelist: an
 * unknown/future status counts as open rather than silently reading as done.
 */
export function isActive(task: Task): boolean {
	return task.status !== "completed" && task.status !== "deleted";
}

/** Collapse whitespace/control characters so a task cannot break the nudge structure. */
export function sanitizeText(value: string, max = MAX_FIELD_LEN): string {
	const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function formatTask(task: Task): string {
	const label =
		task.status === "in_progress"
			? `in_progress${task.activeForm ? `: ${sanitizeText(task.activeForm)}` : ""}`
			: sanitizeText(String(task.status));
	return `- #${task.id} ${sanitizeText(task.subject)} — ${label}`;
}

export function buildNudge(active: Task[], maxTasksShown: number): string {
	const shown = active.slice(0, maxTasksShown);
	const lines = shown.map(formatTask);
	const hidden = active.length - shown.length;
	if (hidden > 0) lines.push(`- …and ${hidden} more`);

	return [
		"Your turn ended, but the todo list still has unfinished work. Reconcile it instead of stopping.",
		"",
		"Unfinished tasks:",
		...lines,
		"",
		"For each task: if the work is already done, mark it completed with the todo tool. If it still needs doing, finish it and then mark it completed. If you are blocked or need my input, say so explicitly and leave the task as it is. Do not redo completed work.",
	].join("\n");
}

/** Matches pi-core's invalidated-ctx proxy error; a stale ctx is not a bug to log. */
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export default function (pi: ExtensionAPI) {
	// Sessions nudged during the current user turn — cleared by the next real
	// user input, a clean list, a `/tree` navigation, or session shutdown.
	// In-memory by design: `/reload` recreating it can cost at most one extra
	// nudge per turn, which is harmless.
	const nudged = new Set<string>();

	/** Session id, or undefined when the ctx is stale/unknown. */
	function sessionId(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionId() || undefined;
		} catch {
			return undefined;
		}
	}

	function clearNudge(ctx: ExtensionContext): void {
		const id = sessionId(ctx);
		if (id) nudged.delete(id);
	}

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const cfg = loadConfig();
			if (!cfg.enabled) return;
			// Interactive TUI only: headless/subagent sessions have no UI, and an
			// RPC/JSON consumer must not receive an unsolicited user turn.
			if (ctx.mode !== "tui") return;
			if (!ctx.isIdle()) return; // another extension already started a run

			const id = sessionId(ctx);
			if (!id) return; // cannot key the guard reliably — do not risk cross-session suppression

			const branch = ctx.sessionManager.getBranch() as Iterable<unknown>;
			const snapshot = latestTodoSnapshot(branch);
			if (!snapshot) return;

			const active = snapshot.tasks.filter(isActive);
			if (active.length === 0) {
				nudged.delete(id); // list is clean — arm the next turn
				return;
			}

			// Abort/error/deferred is not the model choosing to stop.
			if (isNonVoluntaryStop(lastAssistantStopReason(branch))) return;
			if (nudged.has(id)) return; // one nudge per user turn
			nudged.add(id);

			pi.sendUserMessage(buildNudge(active, cfg.maxTasksShown));
		} catch (e) {
			// A missed nudge is harmless — never break the settled event. Stale ctx
			// is expected during replacement; anything else is worth surfacing.
			if (!isStaleCtxError(e)) {
				console.warn(`[todo-reconcile] skipped a nudge: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	});

	// A new human/RPC input re-arms the nudge for the coming turn. Our own
	// injected message arrives with `source: "extension"` and must not.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		clearNudge(ctx);
	});

	// `/tree` navigation swaps the branch (same session id, new snapshot), so a
	// flag set on the old branch must not suppress a nudge on the new one.
	pi.on("session_tree", async (_event, ctx) => {
		clearNudge(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearNudge(ctx);
	});
}
