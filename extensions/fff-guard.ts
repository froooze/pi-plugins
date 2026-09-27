/**
 * fff-guard - never let FFF index `/` or `$HOME`; only the project cwd.
 *
 * pi-fff indexes `ctx.cwd` on session_start. When pi is launched from the
 * filesystem root or the home directory that means a full `/` or `$HOME`
 * walk (the "(fff): Your cwd (/) is too large" warning), plus aux pickers
 * for absolute `path:` constraints outside the workspace can do the same.
 *
 * Root scanning is already off by default in pi-fff; home scanning defaults
 * to ON, so a bare `pi` from `~` (or a `path: /...` / `path: ~/...` tool
 * call) kicks off the heavy index. Those defaults live in the `pi-fff`
 * target of the repo-versioned `settings-defaults.json`, applied by the
 * `settings-defaults` extension (eagerly at import, before the bundled
 * pi-fff extension snapshots its file, and re-checked on session_start).
 *
 * This extension keeps only the guard behavior: it warns when the current
 * cwd itself is `/` or `$HOME`, where FFF tools fail fast instead of
 * indexing — the fix is to `cd` into the project and run pi there.
 *
 * That fail-fast surfaces twice, and the second one is pure noise: pi-fff
 * catches the thrown picker error and re-reports it as
 * `ctx.ui.notify("FFF init failed: …", "error")` (index.ts:
 * reportInitFailure), on `session_start` and again from its
 * `before_agent_start` fallback. There is no pi event hook for
 * notifications, so the only interception point is the shared `ctx.ui`
 * object itself. fff-guard loads before pi-fff (the `./extensions` entry
 * precedes the pi-fff entry in this package's `pi.extensions` manifest) and
 * runner.emit() walks extensions in load order, so wrapping `notify` in our
 * own `session_start` is in place before pi-fff's handler reaches the same
 * event. The wrapper drops ONLY the known root/home refusal — an FFF init
 * failure with any other cause (corrupt frecency DB, bad native binding) is
 * a real fault and still reaches the user. Set `PI_FFF_GUARD_STRICT=1` to
 * keep the raw error as well.
 *
 * Finally, a `tool_result` hook catches FFF's fail-fast refusal
 * (`Failed to create FFF file picker ... Refusing to index ...`) and
 * appends a retry hint pointing the model at `bash` with `rg`/`fd`
 * (or the builtin `grep`/`find` tools when not in FFF override mode),
 * which handle absolute outside-workspace paths without an index.
 */
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isFsRoot(dir: string): boolean {
	const resolved = resolve(dir);
	return parse(resolved).root === resolved;
}

function isHomeDir(dir: string): boolean {
	return resolve(dir) === resolve(homedir());
}

// Tool names pi-fff registers per mode (index.ts: FFF_TOOL_NAMES vs
// OVERRIDE_TOOL_NAMES). In `override` mode the FFF tools shadow the
// builtins under the same `grep`/`find` names — the refusal text check
// below is what distinguishes an FFF failure from a builtin one.
const FFF_TOOL_NAMES = new Set([
	"ffgrep",
	"fffind",
	"fff-multi-grep",
	"grep",
	"find",
	"multi_grep",
]);

const REFUSAL_RE = /Refusing to index|Failed to create FFF file picker/i;

// pi-fff's own re-report of the refusal: `FFF init failed: Failed to create
// FFF file picker for <cwd>: Failed to init file picker: Can not run certain
// FFF features in a file system root or home directories. …` (or the older
// `Refusing to index` / `too large` wordings). Anchored on the prefix so a
// grep result that merely quotes FFF cannot be mistaken for a notification.
const INIT_FAILURE_RE = /^FFF init failed:/;

// The refusal wording inside it. Every branch means "cwd is `/` or `$HOME`
// and scanning it is disabled" — i.e. exactly the case we already reported
// ourselves in `session_start`, so the red duplicate adds nothing.
const ROOT_HOME_REFUSAL_RE =
	/file system root or home director|Refusing to index|is too large/i;

/** Minimal shape of the shared `ctx.ui` we wrap. */
export type NotifyCapableUi = {
	notify: (message: string, type?: "info" | "warning" | "error") => void;
};

/**
 * Whether a pi-fff notification is the root/home refusal this extension
 * already explains. Two independent gates: the message must be pi-fff's
 * init-failure report (not some other extension's toast), and it must name
 * the root/home refusal (not a genuine FFF fault).
 */
export function shouldSuppressInitFailure(message: string, cwd: string): boolean {
	if (typeof message !== "string") return false;
	if (!INIT_FAILURE_RE.test(message.trimStart())) return false;
	if (!ROOT_HOME_REFUSAL_RE.test(message)) return false;
	// Belt and braces: the refusal is only ever emitted for a root/home cwd,
	// and only pi-fff's main-finder init reports it. Anything else (an aux
	// picker for an absolute path, a DB problem) must stay visible.
	return isFsRoot(cwd) || isHomeDir(cwd);
}

/** `PI_FFF_GUARD_STRICT=1` keeps the raw error next to our warning. */
export function isStrict(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.PI_FFF_GUARD_STRICT?.trim().toLowerCase();
	return raw === "1" || raw === "on" || raw === "true";
}

// Restore handles of live filters, keyed by the wrapped ui object, so a
// repeated `session_start` (new session, fork, switch) reuses one wrapper
// instead of stacking a second one on top.
const installed = new WeakMap<NotifyCapableUi, () => void>();

/**
 * Wrap `ui.notify` so the redundant FFF init-failure toast is dropped.
 * Returns an idempotent restore function. Never throws: a UI object we
 * cannot patch simply means the error stays visible, which is the old
 * behavior and perfectly survivable.
 */
export function installInitFailureFilter(
	ui: NotifyCapableUi,
	opts: { cwd: string; strict?: boolean; env?: NodeJS.ProcessEnv },
): () => void {
	const noop = () => {};
	try {
		if (opts.strict ?? isStrict(opts.env)) return noop;
		if (!ui || typeof ui.notify !== "function") return noop;
		const existing = installed.get(ui);
		if (existing) return existing;

		const original = ui.notify;
		const restore = () => {
			if (ui.notify === filtered) ui.notify = original;
			installed.delete(ui);
		};
		const filtered = function notify(this: unknown, message: string, type?: "info" | "warning" | "error") {
			if (shouldSuppressInitFailure(message, opts.cwd)) return;
			// Re-entering through the captured reference (not a bound copy) so
			// restore() can hand back the exact original function object.
			original.call(ui, message, type);
		};
		ui.notify = filtered;
		installed.set(ui, restore);
		return restore;
	} catch {
		return noop;
	}
}

function toolResultText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function refusalHint(toolName: string, input: Record<string, unknown>, cwd?: string): string {
	// No `path` param means the main cwd picker refused (pi launched from
	// `/` or `~`), or a multi_grep `constraints`-only call did — show the
	// cwd so the hint names the real directory.
	const rawPath =
		typeof input.path === "string" && input.path.trim() !== ""
			? input.path.trim()
			: (cwd ?? ".");
	const quotedPath = shellQuote(rawPath);
	if (toolName.toLowerCase().includes("grep")) {
		const patterns: string[] = Array.isArray(input.patterns)
			? (input.patterns as unknown[]).filter((p): p is string => typeof p === "string")
			: typeof input.pattern === "string"
				? [input.pattern as string]
				: [];
		const pattern = patterns[0] ?? "<pattern>";
		const more =
			patterns.length > 1 ? ` (all of: ${patterns.map((p) => `"${p}"`).join(", ")})` : "";
		return (
			`[fff-guard: FFF refused to index ${rawPath} — scanning of / and $HOME is disabled, ` +
			`so fffind/ffgrep cannot search there. Retry the same search without the index${more} ` +
			`via \`bash\`: \`rg ${shellQuote(pattern)} ${quotedPath}\` ` +
			`(or the builtin \`grep\` tool with pattern ${JSON.stringify(pattern)} + path ${JSON.stringify(rawPath)} ` +
			`when not in FFF override mode).]`
		);
	}
	if (toolName.toLowerCase().includes("find")) {
		const pattern = typeof input.pattern === "string" ? input.pattern : "<glob>";
		return (
			`[fff-guard: FFF refused to index ${rawPath} — scanning of / and $HOME is disabled, ` +
			`so fffind/ffgrep cannot search there. Retry without the index ` +
			`via \`bash\`: \`fd ${shellQuote(pattern)} ${quotedPath}\` ` +
			`(or the builtin \`find\` tool with pattern ${JSON.stringify(pattern)} + path ${JSON.stringify(rawPath)} ` +
			`when not in FFF override mode).]`
		);
	}
	return (
		`[fff-guard: FFF refused to index ${rawPath} — scanning of / and $HOME is disabled. ` +
		`Retry without the index via \`bash\` (\`rg\`/\`fd\`), \`read\`, \`ls\`, ` +
		`or the builtin \`grep\`/\`find\` tools on path ${JSON.stringify(rawPath)} ` +
		`(when not in FFF override mode).]`
	);
}

export default function fffGuard(pi: ExtensionAPI) {
	/** Undoes this session's `notify` wrap, if any. */
	let restoreNotify: (() => void) | undefined;

	// Fail-fast refusal -> self-correcting retry hint. Partial patch:
	// only `content` is returned, `details`/`isError`/`usage` pass through.
	// The isError gate matters: pi-fff's refusal is a thrown execute()
	// error (isError true), while a successful builtin grep match whose
	// file contents happen to contain "Refusing to index" arrives with
	// isError false — without the gate we'd misfire on the latter.
	pi.on("tool_result", async (event, ctx) => {
		try {
			if (!FFF_TOOL_NAMES.has(event.toolName)) return;
			if (!event.isError) return;
			const text = toolResultText(
				event.content as Array<{ type: string; text?: string }>,
			);
			if (!REFUSAL_RE.test(text)) return;
			if (/fff-guard: FFF refused to index/.test(text)) return; // already hinted
			const hint = refusalHint(
				event.toolName,
				event.input as Record<string, unknown>,
				(ctx as { cwd?: string } | undefined)?.cwd,
			);
			const first = (event.content as Array<{ type: string; text?: string }>).find(
				(c) => c.type === "text",
			);
			if (!first) return { content: [{ type: "text", text: hint }] };
			return {
				content: [
					...event.content,
					{ type: "text", text: `\n\n${hint}` },
				],
			};
		} catch {
			// Never break tool results; the raw FFF error is still usable.
			return;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Friendly diagnosis: with scanning disabled, launching pi from `/`
		// or `~` makes FFF fail fast ("Refusing to index ..."). Tell the
		// user the actual fix instead of leaving them with a raw init error.
		try {
			if (isFsRoot(ctx.cwd) || isHomeDir(ctx.cwd)) {
				// pi-fff turns that same refusal into an `error` toast right
				// after this handler; it only repeats what we just said, so
				// drop it and keep exactly one message. Installed here — not
				// at import time — because ctx.ui is only bound by then, and
				// before pi-fff's handler because extensions load in order.
				const strict = isStrict();
				restoreNotify = installInitFailureFilter(ctx.ui, { cwd: ctx.cwd, strict });
				ctx.ui.notify(
					`fff-guard: running from ${ctx.cwd} — FFF indexing of / and $HOME is disabled, so file search is limited here. cd into your project and run pi there for full results.` +
						(strict ? "" : " (pi-fff's duplicate init error is suppressed.)"),
					"warning",
				);
			} else {
				// Not a root/home cwd: a real FFF fault (corrupt DB, broken
				// native binding) must stay visible, so drop the filter.
				restoreNotify?.();
				restoreNotify = undefined;
			}
		} catch {
			// Non-fatal; ignore.
		}
	});

	// Keep the patch scoped to a session: on `/reload` the runner (and with
	// it the wrapped ui object) is rebuilt anyway, and a replacement session
	// re-installs on its own `session_start`.
	pi.on("session_shutdown", async () => {
		try {
			restoreNotify?.();
		} catch {
			// Non-fatal; ignore.
		} finally {
			restoreNotify = undefined;
		}
	});
}
