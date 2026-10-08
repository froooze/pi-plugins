/**
 * todo-reconcile — nudge the model when a settled turn leaves `rpiv-todo`
 * tasks unfinished.
 *
 * rpiv-todo owns the todo list and its overlay, but nothing forces the model
 * to finish what it planned. When a run settles (`agent_settled`: after
 * retries, auto-compaction, and queued follow-ups — the point where Pi will
 * not continue on its own) this extension inspects the list and, if any
 * task is still open, injects a follow-up user message telling the model to
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
 * Loop safety — nudge only while the model keeps making progress and is not
 * asking for input; there is no per-turn or per-session cap:
 * - Each settle is classified. The model "worked" if the branch gained a tool
 *   call/result (or the todo snapshot changed) since the previous nudge; it
 *   "asked" if the final assistant message carries no tool calls and either
 *   the explicit `Awaiting input:` marker or (when `detectQuestions` is on) a
 *   trailing question / awaiting phrase. A nudged model that stopped without
 *   new work is left alone, and one that asked is not nudged again until a real
 *   user reply arrives.
 * - State is remembered until the next non-extension input (extension-sent
 *   messages, including our own injected nudge, are tagged `source:
 *   "extension"` and do not clear it), the list goes clean, a `/tree`
 *   navigation changes the branch, or the session shuts down. Slash commands
 *   are dispatched before the `input` event, so they do not clear it.
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
 *   "maxTasksShown": 10,
 *   "detectQuestions": true
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

export type TodoSnapshot = { tasks: Task[] };

export type NudgeState = {
	/** Whether a nudge was already sent in the current user turn. */
	nudged: boolean;
	/** Branch length at the last nudge; used to detect work done since. */
	lastNudgeIndex: number;
	/** Todo snapshot key at the last nudge; a change also counts as progress. */
	lastNudgeTodoKey: string;
	/** Latched when the model asked a question — stays silent until real input. */
	awaitingInput: boolean;
};

export function newNudgeState(): NudgeState {
	return { nudged: false, lastNudgeIndex: 0, lastNudgeTodoKey: "", awaitingInput: false };
}

export type AssistantContent = {
	text: string;
	hasToolCalls: boolean;
};

export type AssistantInfo = AssistantContent & { stopReason?: string };

type BranchEntry = {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
		stopReason?: string;
		content?: unknown;
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

/** Explicit marker a blocked model is asked to emit so we never nudge a question. */
const AWAIT_MARKER_RE = /^\s*awaiting input\s*:/im;

/**
 * Conservative awaiting-input phrases. Only consulted on the tail of the
 * final assistant message and only when `detectQuestions` is on.
 */
const AWAIT_PHRASE_RE =
	/\b(?:awaiting (?:your )?input|waiting for (?:your|you)|need (?:your|more) (?:input|info|clarification|decision|approval)|please (?:confirm|clarify|let me know)|let me know (?:how|if|whether|which|what)|which (?:one|option|approach)|should i|do you want me to|would you like me to|can you (?:confirm|clarify|provide|tell me))\b/i;

/** Tail length (chars) inspected for awaiting phrases, to avoid stale matches. */
const AWAIT_TAIL_LEN = 400;

type Config = {
	enabled: boolean;
	maxTasksShown: number;
	detectQuestions: boolean;
};

const DEFAULTS: Config = {
	enabled: true,
	maxTasksShown: DEFAULT_MAX_TASKS_SHOWN,
	detectQuestions: true,
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
	if (typeof raw.detectQuestions === "boolean") cfg.detectQuestions = raw.detectQuestions;
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

/** Stable key of the open/closed state of the list; a change means the model used `todo`. */
export function todoSnapshotKey(snapshot: TodoSnapshot | undefined): string {
	if (!snapshot) return "";
	return snapshot.tasks.map((t) => `${t.id}:${t.status}`).join("|");
}

/** Extract assistant text and whether the message invoked any tool. */
export function readAssistantContent(content: unknown): AssistantContent {
	if (typeof content === "string") return { text: content, hasToolCalls: false };
	if (!Array.isArray(content)) return { text: "", hasToolCalls: false };
	const texts: string[] = [];
	let hasToolCalls = false;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: unknown; text?: unknown };
		if (p.type === "toolCall") hasToolCalls = true;
		else if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
	}
	return { text: texts.join("\n"), hasToolCalls };
}

/** Last assistant message with its text, tool-call flag, and stop reason. */
export function lastAssistantInfo(branch: Iterable<unknown>): AssistantInfo | undefined {
	const entries = Array.from(branch);
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as BranchEntry;
		if (e?.type !== "message" || e.message?.role !== "assistant") continue;
		return { ...readAssistantContent(e.message.content), stopReason: e.message.stopReason };
	}
	return undefined;
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

/** Explicit, deterministic blocked signal requested by the nudge prompt. */
export function hasAwaitMarker(text: string): boolean {
	return AWAIT_MARKER_RE.test(text);
}

/** Last non-empty line ends with a question mark (ASCII or fullwidth). */
function lastLineEndsWithQuestion(text: string): boolean {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		return /[?？]["'”’)\]]*\s*$/.test(line);
	}
	return false;
}

/**
 * Whether the final assistant message is addressed to the user rather than a
 * stopped worker. A message with tool calls is mid-work by definition.
 */
export function isAwaitingInput(info: AssistantInfo, detectQuestions: boolean): boolean {
	if (info.hasToolCalls) return false;
	if (hasAwaitMarker(info.text)) return true;
	if (!detectQuestions) return false;
	if (lastLineEndsWithQuestion(info.text)) return true;
	return AWAIT_PHRASE_RE.test(info.text.slice(-AWAIT_TAIL_LEN));
}

/**
 * Whether the model did anything since `index`: a new tool call/result, or the
 * branch changed underneath us (compaction/tree). User messages — including
 * our own injected nudge — do not count.
 */
export function hasProgressSince(entries: readonly unknown[], index: number): boolean {
	if (index < 0 || index > entries.length) return true;
	for (let i = index; i < entries.length; i++) {
		const e = entries[i] as BranchEntry;
		if (e?.type !== "message") continue;
		const msg = e.message;
		if (msg?.role === "toolResult") return true;
		if (msg?.role === "assistant" && readAssistantContent(msg.content).hasToolCalls) return true;
	}
	return false;
}

export type SettleAction = "nudge" | "awaiting" | "latched" | "no-progress";

/**
 * The decision table: nudge while the model keeps working; stay silent once it
 * asks (latched until real input) or when a nudged model stopped without new
 * progress. There is no cap — a model that keeps working keeps being nudged.
 */
export function evaluateSettle(opts: {
	state: NudgeState;
	assistant: AssistantInfo | undefined;
	progressed: boolean;
	detectQuestions: boolean;
}): SettleAction {
	const { state } = opts;
	if (state.awaitingInput) return "latched";
	if (opts.assistant && isAwaitingInput(opts.assistant, opts.detectQuestions)) return "awaiting";
	if (state.nudged && !opts.progressed) return "no-progress";
	return "nudge";
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
		"Your turn ended with unfinished work — reconcile it before stopping.",
		"",
		"Unfinished tasks:",
		...lines,
		"",
		"Mark already-done work completed with the todo tool; finish the rest, then mark each completed. If you need my input, end with `Awaiting input:` and a short reason, leaving the task open.",
	].join("\n");
}

/** Matches pi-core's invalidated-ctx proxy error; a stale ctx is not a bug to log. */
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export default function (pi: ExtensionAPI) {
	// Per-session nudge state for the current user turn — cleared by the next
	// real user input, a clean list, a `/tree` navigation, or session shutdown.
	// In-memory by design: `/reload` recreating it can cost at most one extra
	// nudge per turn, which is harmless.
	const states = new Map<string, NudgeState>();

	/** Session id, or undefined when the ctx is stale/unknown. */
	function sessionId(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionId() || undefined;
		} catch {
			return undefined;
		}
	}

	function clearState(ctx: ExtensionContext): void {
		const id = sessionId(ctx);
		if (id) states.delete(id);
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

			const entries = Array.from(ctx.sessionManager.getBranch() as Iterable<unknown>);
			const snapshot = latestTodoSnapshot(entries);
			if (!snapshot) {
				states.delete(id);
				return;
			}

			const active = snapshot.tasks.filter(isActive);
			if (active.length === 0) {
				states.delete(id); // list is clean — arm the next turn
				return;
			}

			// Abort/error/deferred is not the model choosing to stop.
			if (isNonVoluntaryStop(lastAssistantStopReason(entries))) return;

			const state = states.get(id) ?? newNudgeState();
			const todoKey = todoSnapshotKey(snapshot);
			const progressed =
				state.nudged && (hasProgressSince(entries, state.lastNudgeIndex) || todoKey !== state.lastNudgeTodoKey);

			const action = evaluateSettle({
				state,
				assistant: lastAssistantInfo(entries),
				progressed,
				detectQuestions: cfg.detectQuestions,
			});

			if (action === "nudge") {
				pi.sendUserMessage(buildNudge(active, cfg.maxTasksShown));
				state.nudged = true;
				state.lastNudgeIndex = entries.length;
				state.lastNudgeTodoKey = todoKey;
				state.awaitingInput = false;
			} else if (action === "awaiting") {
				state.awaitingInput = true; // latch: no more nudges until the user replies
			}
			states.set(id, state);
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
		clearState(ctx);
	});

	// `/tree` navigation swaps the branch (same session id, new snapshot), so
	// state set on the old branch must not suppress a nudge on the new one.
	pi.on("session_tree", async (_event, ctx) => {
		clearState(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearState(ctx);
	});
}
