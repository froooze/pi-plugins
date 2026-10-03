/**
 * btw — ask a side question in a *forked copy* of the current session, opened
 * in a brand-new terminal window.
 *
 * Why this exists
 * ---------------
 * The bundled `@juicesharp/rpiv-btw` answered via a non-streaming, tool-less
 * `completeSimple` call and rendered the result in a bottom overlay that is not
 * an input box (only Esc/↑/↓/x are bound). That reads as a frozen panel: no
 * prompt entry, no thinking, no streaming, no tools. This extension replaces
 * that UX with a real second Pi session:
 *
 *   /btw <question>
 *
 * forks the current session file (`pi --fork <file> -- "<question>"`) and runs
 * it in a fresh terminal window. The side question therefore gets the whole
 * transcript as context, streams its thinking/output, and can use tools — while
 * the *main* session is never touched (fork copies; it does not share the file).
 *
 * The fork is a point-in-time copy of the session file as it exists on disk;
 * messages added to the main session afterwards are not visible to the side
 * window. The fork is also pinned to this session's provider/model and thinking
 * level (`--provider/--model/--thinking`), so it never silently re-resolves a
 * different default or fails auth in the new environment.
 *
 * Two ways to ask
 * ---------------
 * - `/btw why is X slow?`      — single line, passed straight through.
 * - `/btw` (no argument)       — opens Pi's multi-line editor. The composed
 *   text keeps its newlines and formatting, so long/structured questions work.
 *
 * How the window is opened
 * ------------------------
 * A tiny launcher script is written to a temp dir. The script `cd`s to the
 * session cwd, runs the forked Pi (reading the question from a file, so no
 * shell-quoting of the question is ever needed), then deletes the temp dir. A
 * missing cwd or a non-zero Pi exit pauses with a message instead of closing
 * the window silently.
 *
 * The script invokes Pi as `<node> <cli.js>` using absolute paths captured
 * from the running process, and re-exports this process's **whole environment**
 * (not just `PATH`). This is not paranoia: terminal multiplexers/servers
 * (xfce4-terminal, gnome-terminal) spawn the command from a long-lived server
 * whose environment predates the user's shell, so `pi`/`node` are frequently
 * not on its `PATH`, and settings/auth carried in the environment would be
 * stripped too. The xfce launcher additionally passes `--disable-server`, so
 * its window inherits the client environment directly.
 *
 * A terminal is chosen from the environment, in order:
 *
 *   1. `$PI_BTW_LAUNCH` — a command template containing `{cmd}` (e.g.
 *      `PI_BTW_LAUNCH='kitty --title btw -e {cmd}'`); the rest is appended when
 *      `{cmd}` is absent. Use this for anything not auto-detected.
 *   2. tmux — `tmux new-window` when `$TMUX` is set.
 *   3. the terminal we are running inside, detected from its env markers
 *      (`KITTY_WINDOW_ID`, `WEZTERM_PANE`, `ALACRITTY_WINDOW_ID`,
 *      `GHOSTTY_RESOURCES_DIR`, `KONSOLE_VERSION`, `TERM_PROGRAM`, …).
 *   4. xfce4-terminal, kitty, wezterm, alacritty, ghostty, konsole,
 *      gnome-terminal, x-terminal-emulator, xterm.
 *   5. macOS: `osascript` driving Terminal.app.
 *
 * `$PI_BTW_PI` overrides the `pi` executable to launch (default: `pi` on PATH);
 * a TypeScript self-entry is skipped because `node` cannot run it. Pi's JS entry
 * is launched directly with absolute `node` (bypassing any shell wrapper), which
 * the environment re-export above compensates for.
 *
 * Requirements: interactive TUI mode, a saved session file to fork, and one of
 * the launchers above. Everything is best-effort — a missing launcher or a
 * failed spawn surfaces as a `ctx.ui.notify`, never an unhandled throw.
 */
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Constants
// ============================================================================

export const BTW_COMMAND = "btw";
/** Overrides the Pi executable launched in the new window (default `pi`). */
export const BTW_PI_ENV = "PI_BTW_PI";
/** Terminal command template; `{cmd}` is replaced with the quoted command. */
export const BTW_LAUNCH_ENV = "PI_BTW_LAUNCH";
export const DEFAULT_PI = "pi";
export const TITLE_PREFIX = "btw";
export const MAX_TITLE_LEN = 48;
export const TEMP_PREFIX = "pi-btw-";

export const MSG_REQUIRES_TUI = "/btw requires an interactive terminal";
export const MSG_USAGE =
	"Usage: /btw [question] — a single-line question, or run /btw alone to compose a multi-line one";
export const MSG_NO_SESSION = "/btw needs a saved session with at least one message to fork (this session has none yet)";
export const MSG_NO_PI =
	`btw: could not resolve the pi executable to launch — set ${BTW_PI_ENV} to the pi entry script`;
export const MSG_NO_TERMINAL = `btw: no terminal launcher found — set ${BTW_LAUNCH_ENV} (e.g. 'xfce4-terminal --window -x {cmd}')`;

// ============================================================================
// Pure helpers (exported for tests)
// ============================================================================

/** Normalize line endings and strip surrounding whitespace, preserving internal formatting. */
export function normalizeQuestion(raw: string): string {
	return raw.replace(/\r\n?/g, "\n").trim();
}

/** Window title: first non-blank line, whitespace-collapsed, truncated. */
export function deriveTitle(question: string): string {
	const firstLine = question.split("\n").find((line) => line.trim().length > 0) ?? "";
	const collapsed = firstLine.replace(/\s+/g, " ").trim();
	const snippet = collapsed.length > MAX_TITLE_LEN ? `${collapsed.slice(0, MAX_TITLE_LEN - 1)}…` : collapsed;
	return snippet.length > 0 ? `${TITLE_PREFIX}: ${snippet}` : TITLE_PREFIX;
}

/** POSIX single-quote a value so a shell re-parses it as one literal argument. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Shell variables the launcher must not re-export: positional/shell-internal
 * values that would either be wrong in the new shell or break it.
 */
const ENV_SKIP = new Set(["_", "PWD", "OLDPWD", "SHLVL", "IFS", "PS1", "PS2", "PS4", "BASH_ENV", "ENV"]);

/** Render `export KEY='value'` lines for an environment (shell-quoted, safe names only). */
export function buildEnvExports(env: NodeJS.ProcessEnv): string {
	const lines: string[] = [];
	for (const key of Object.keys(env).sort()) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ENV_SKIP.has(key)) continue;
		const value = env[key];
		if (value === undefined) continue;
		lines.push(`export ${key}=${shellQuote(value)}`);
	}
	return lines.join("\n");
}

export interface LauncherScriptOptions {
	node: string;
	entry: string;
	cwd: string;
	/** Environment to restore inside the new window (defaults to none). */
	env?: NodeJS.ProcessEnv;
	/** Extra Pi CLI flags inserted before `--` (e.g. `--provider P --model M --thinking T`). */
	piFlags?: string[];
}

/**
 * The launcher script dropped into the temp dir. Reads the question from `$2`
 * (a file) so arbitrary multi-line text needs no quoting, re-exports the given
 * environment, runs Pi with absolute `node`/entry paths, and removes its own
 * temp dir once Pi exits. A missing cwd or a failed run pauses so the error is
 * readable in the window rather than vanishing.
 */
export function buildLauncherScript(opts: LauncherScriptOptions): string {
	const lines = [
		"#!/bin/sh",
		"# Generated by the pi-plugins /btw extension; self-deletes when done.",
		'dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
		"pause() {",
		"\tprintf '\\nbtw: %s\\n' \"$1\" >&2",
		"\tprintf 'Press Enter to close…' >&2",
		"\tread -r _ || true",
		"}",
	];
	if (opts.env) {
		const exports = buildEnvExports(opts.env);
		if (exports.length > 0) lines.push(exports);
	}
	const flags = opts.piFlags && opts.piFlags.length > 0 ? ` ${opts.piFlags.map(shellQuote).join(" ")}` : "";
	const cwdError = shellQuote(`working directory not found: ${opts.cwd}`);
	lines.push(
		`cd ${shellQuote(opts.cwd)} || { pause ${cwdError}; rm -rf -- "$dir"; exit 1; }`,
		`${shellQuote(opts.node)} ${shellQuote(opts.entry)} --fork "$1"${flags} -- "$(cat "$2")"`,
		"status=$?",
		'if [ "$status" -ne 0 ]; then',
		'\tpause "pi exited with status $status"',
		"fi",
		'rm -rf -- "$dir"',
		'exit "$status"',
	);
	return `${lines.join("\n")}\n`;
}

/** True when `path` exists and is executable by this process. */
function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Locate an executable on `PATH` (or an explicit path). */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (name.includes("/") || isAbsolute(name)) return isExecutable(name) ? name : undefined;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

export interface PiLaunch {
	/** Absolute `node` binary that runs Pi's entry script. */
	node: string;
	/** Absolute Pi entry script (`cli.js` / bundle). */
	entry: string;
}

/** Resolve a bare name or path to an existing file, following symlinks. */
function resolveExisting(spec: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	if (!spec) return undefined;
	const direct = existsSync(spec) ? spec : findExecutable(spec, env);
	if (!direct || !existsSync(direct)) return undefined;
	try {
		return realpathSync(direct);
	} catch {
		return direct;
	}
}

/** Extensions `node` cannot execute directly; skip such a self-entry. */
const NON_RUNNABLE_ENTRY = /\.(ts|tsx|mts|cts)$/i;

/** This process's own entry, unless it is TypeScript or missing. */
function resolveSelfEntry(env: NodeJS.ProcessEnv): string | undefined {
	const self = process.argv[1];
	if (!self || NON_RUNNABLE_ENTRY.test(self)) return undefined;
	return resolveExisting(self, env);
}

/**
 * Absolute node + Pi entry paths for the launcher script. `$PI_BTW_PI` wins,
 * then this process's own entry (`process.argv[1]`, skipped when TypeScript),
 * then `pi` on `PATH`. Absolute paths are required because terminal servers
 * often spawn commands with a `PATH` that lacks nvm/bun-installed binaries.
 */
export function resolvePiLaunch(env: NodeJS.ProcessEnv = process.env): PiLaunch | undefined {
	const node = process.execPath;
	if (!node || !existsSync(node)) return undefined;
	const entry =
		resolveExisting(env[BTW_PI_ENV]?.trim(), env) ?? resolveSelfEntry(env) ?? resolveExisting(DEFAULT_PI, env);
	if (!entry) return undefined;
	return { node, entry };
}

// ============================================================================
// Terminal launchers
// ============================================================================

export interface LaunchPaths {
	script: string;
	session: string;
	question: string;
	cwd: string;
	title: string;
}

export interface Command {
	command: string;
	args: string[];
}

export interface Launcher {
	id: string;
	bin: string;
	build: (paths: LaunchPaths) => Command;
}

/** macOS Terminal.app via osascript; the command runs through a shell. */
const MACOS_LAUNCHER: Launcher = {
	id: "macos-terminal",
	bin: "osascript",
	build: (p) => {
		const shellCommand = `cd ${shellQuote(p.cwd)}; ${[p.script, p.session, p.question]
			.map(shellQuote)
			.join(" ")}`;
		const escaped = shellCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return {
			command: "osascript",
			args: ["-e", `tell application "Terminal" to do script "${escaped}"`, "-e", 'tell application "Terminal" to activate'],
		};
	},
};

const TMUX_LAUNCHER: Launcher = {
	id: "tmux",
	bin: "tmux",
	build: (p) => ({
		command: "tmux",
		args: [
			"new-window",
			"-c",
			p.cwd,
			"-n",
			p.title,
			[p.script, p.session, p.question].map(shellQuote).join(" "),
		],
	}),
};

/** Terminal candidates, tried in order. Each receives script/session/question as plain argv. */
export const TERMINAL_LAUNCHERS: Launcher[] = [
	{
		id: "xfce4-terminal",
		bin: "xfce4-terminal",
		build: (p) => ({
			command: "xfce4-terminal",
			// NOTE: no `--window` here. With `--disable-server`, `--window` opens an
			// extra default window alongside the command one; the server-disabled
			// process already creates exactly one window.
			args: [
				"--disable-server",
				"--title",
				p.title,
				"--working-directory",
				p.cwd,
				"-x",
				p.script,
				p.session,
				p.question,
			],
		}),
	},
	{
		id: "kitty",
		bin: "kitty",
		build: (p) => ({
			command: "kitty",
			args: ["--title", p.title, "--directory", p.cwd, p.script, p.session, p.question],
		}),
	},
	{
		id: "wezterm",
		bin: "wezterm",
		build: (p) => ({ command: "wezterm", args: ["start", "--cwd", p.cwd, "--", p.script, p.session, p.question] }),
	},
	{
		id: "alacritty",
		bin: "alacritty",
		build: (p) => ({
			command: "alacritty",
			args: ["--title", p.title, "--working-directory", p.cwd, "-e", p.script, p.session, p.question],
		}),
	},
	{
		id: "ghostty",
		bin: "ghostty",
		build: (p) => ({
			command: "ghostty",
			args: [`--title=${p.title}`, `--working-directory=${p.cwd}`, "-e", p.script, p.session, p.question],
		}),
	},
	{
		id: "konsole",
		bin: "konsole",
		build: (p) => ({
			command: "konsole",
			args: ["--workdir", p.cwd, "-p", `tabtitle=${p.title}`, "-e", p.script, p.session, p.question],
		}),
	},
	{
		id: "gnome-terminal",
		bin: "gnome-terminal",
		build: (p) => ({
			command: "gnome-terminal",
			args: [
				"--window",
				`--title=${p.title}`,
				`--working-directory=${p.cwd}`,
				"--",
				p.script,
				p.session,
				p.question,
			],
		}),
	},
	{
		id: "x-terminal-emulator",
		bin: "x-terminal-emulator",
		build: (p) => ({ command: "x-terminal-emulator", args: ["-e", p.script, p.session, p.question] }),
	},
	{
		id: "xterm",
		bin: "xterm",
		build: (p) => ({ command: "xterm", args: ["-T", p.title, "-e", p.script, p.session, p.question] }),
	},
];

/**
 * Best-effort id of the terminal this process runs inside, from markers the
 * popular emulators export. Preferring "open a window in *this* terminal"
 * avoids surprising the user by hijacking an unrelated emulator, and sidesteps
 * the long-lived terminal-server environment on machines with many terminals.
 */
export function detectCurrentTerminal(env: NodeJS.ProcessEnv): string | undefined {
	if (env.KITTY_WINDOW_ID || env.KITTY_PID || env.TERM === "xterm-kitty") return "kitty";
	if (env.WEZTERM_PANE || env.WEZTERM_EXECUTABLE || env.TERM_PROGRAM === "WezTerm") return "wezterm";
	if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_LOG) return "alacritty";
	if (env.GHOSTTY_RESOURCES_DIR || env.TERM_PROGRAM === "ghostty" || env.TERM === "xterm-ghostty") return "ghostty";
	if (env.KONSOLE_VERSION) return "konsole";
	if (env.GNOME_TERMINAL_SERVICE || env.GNOME_TERMINAL_SCREEN) return "gnome-terminal";
	if (env.TERM_PROGRAM === "Apple_Terminal" || env.TERM_PROGRAM === "iTerm.app") return "macos-terminal";
	return undefined;
}

/**
 * Pick a launcher: explicit `$PI_BTW_LAUNCH`, then tmux, then the terminal we
 * are running inside, then the first detected candidate, then macOS Terminal.app.
 */
export function selectLauncher(
	env: NodeJS.ProcessEnv,
	has: (bin: string) => boolean,
	platform: NodeJS.Platform = process.platform,
): Launcher | undefined {
	const configured = env[BTW_LAUNCH_ENV]?.trim();
	if (configured) {
		return {
			id: "configured",
			bin: "sh",
			build: (p) => {
				const cmd = [p.script, p.session, p.question].map(shellQuote).join(" ");
				const rendered = configured.includes("{cmd}") ? configured.replaceAll("{cmd}", cmd) : `${configured} ${cmd}`;
				return { command: "sh", args: ["-c", rendered] };
			},
		};
	}
	if (env.TMUX && has("tmux")) return TMUX_LAUNCHER;
	const current = detectCurrentTerminal(env);
	if (current === "macos-terminal") {
		if (platform === "darwin" && has("osascript")) return MACOS_LAUNCHER;
	}
	if (current) {
		const preferred = TERMINAL_LAUNCHERS.find((launcher) => launcher.id === current);
		if (preferred && has(preferred.bin)) return preferred;
	}
	for (const launcher of TERMINAL_LAUNCHERS) {
		if (has(launcher.bin)) return launcher;
	}
	if (platform === "darwin" && has("osascript")) return MACOS_LAUNCHER;
	return undefined;
}

// ============================================================================
// Launch
// ============================================================================

export interface LaunchRequest {
	sessionFile: string;
	question: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Pi CLI flags pinning the fork (e.g. `--provider/--model/--thinking`). */
	piFlags?: string[];
	/** Injectable for tests; defaults to `node:child_process.spawn`. */
	spawnImpl?: typeof spawn;
}

export type LaunchOutcome = { ok: true; launcher: string } | { ok: false; error: string };

/** Best-effort recursive removal of a temp dir (the launcher self-deletes on success). */
function removeDir(dir: string | undefined): void {
	if (!dir) return;
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/** Write the temp launcher, choose a terminal, and spawn the forked Pi window. */
export function launchBtw(request: LaunchRequest): LaunchOutcome {
	const env = request.env ?? process.env;
	const question = normalizeQuestion(request.question);
	if (question.length === 0) return { ok: false, error: MSG_USAGE };

	const launcher = selectLauncher(env, (bin) => Boolean(findExecutable(bin, env)));
	if (!launcher) return { ok: false, error: MSG_NO_TERMINAL };

	const pi = resolvePiLaunch(env);
	if (!pi) return { ok: false, error: MSG_NO_PI };
	const spawnFn = request.spawnImpl ?? spawn;
	let dir: string | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
		const scriptFile = join(dir, "launch.sh");
		const questionFile = join(dir, "question.txt");
		writeFileSync(questionFile, `${question}\n`, "utf8");
		writeFileSync(
			scriptFile,
			buildLauncherScript({
				node: pi.node,
				entry: pi.entry,
				cwd: request.cwd,
				env,
				piFlags: request.piFlags,
			}),
			"utf8",
		);
		// Owner-only: the script re-exports the full environment (API keys included).
		chmodSync(scriptFile, 0o700);

		const { command, args } = launcher.build({
			script: scriptFile,
			session: request.sessionFile,
			question: questionFile,
			cwd: request.cwd,
			title: deriveTitle(question),
		});
		const child = spawnFn(command, args, { detached: true, stdio: "ignore", cwd: request.cwd });
		// Attach first: an unhandled 'error' event would crash Pi, and a failed spawn
		// emits it asynchronously with no pid.
		child.on("error", () => {
			// Async failure (e.g. the terminal binary vanished): reclaim the dir, since
			// the launcher script will never run to self-delete it.
			removeDir(dir);
		});
		if (child.pid === undefined) {
			removeDir(dir);
			return {
				ok: false,
				error: `btw: could not start "${command}" — check ${BTW_LAUNCH_ENV} and that the terminal is installed`,
			};
		}
		child.unref();
		return { ok: true, launcher: launcher.id };
	} catch (err) {
		removeDir(dir);
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ============================================================================
// Command
// ============================================================================

export function registerBtw(pi: ExtensionAPI): void {
	pi.registerCommand(BTW_COMMAND, {
		description: "Ask a side question in a forked copy of this session, opened in a new window",
		handler: (args: string, ctx: ExtensionCommandContext) => handleBtw(args, ctx),
	});
}

/** Flags that pin the forked Pi to this session's model and thinking level. */
export function buildPiFlags(ctx: Pick<ExtensionCommandContext, "model" | "thinkingLevel">): string[] {
	const flags: string[] = [];
	if (ctx.model) flags.push("--provider", ctx.model.provider, "--model", ctx.model.id);
	if (ctx.thinkingLevel) flags.push("--thinking", ctx.thinkingLevel);
	return flags;
}

export async function handleBtw(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify(MSG_REQUIRES_TUI, "error");
		return;
	}

	let question = normalizeQuestion(args ?? "");
	if (question.length === 0) {
		const edited = await ctx.ui.editor(
			"btw — side question (Enter to submit · Shift+Enter for a new line · Esc to cancel)",
			"",
		);
		question = edited === undefined ? "" : normalizeQuestion(edited);
	}
	if (question.length === 0) {
		ctx.ui.notify(MSG_USAGE, "warning");
		return;
	}

	let sessionFile: string | undefined;
	try {
		sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	} catch {
		sessionFile = undefined; // stale ctx after session replacement
	}
	// The path is assigned before the first message is written, so check the file too.
	if (!sessionFile || !existsSync(sessionFile)) {
		ctx.ui.notify(MSG_NO_SESSION, "error");
		return;
	}

	const result = launchBtw({ sessionFile, question, cwd: ctx.cwd, piFlags: buildPiFlags(ctx) });
	if (result.ok) {
		ctx.ui.notify(`btw: forked session opened in a new window (${result.launcher})`, "info");
	} else {
		ctx.ui.notify(result.error, "error");
	}
}

export default function btwExtension(pi: ExtensionAPI): void {
	registerBtw(pi);
}
