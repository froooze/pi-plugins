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
 * shell-quoting of the question is ever needed), then deletes the temp dir.
 *
 * The script invokes Pi as `<node> <cli.js>` using absolute paths captured
 * from the running process, and exports this process's `PATH`. This is not
 * paranoia: terminal multiplexers/servers (xfce4-terminal, gnome-terminal)
 * spawn the command from a long-lived server whose environment predates the
 * user's shell, so `pi`/`node` are frequently not on its `PATH` and tools run
 * by the forked session would otherwise see a stripped `PATH`. The xfce
 * launcher additionally passes `--disable-server`, so its window inherits the
 * client environment directly.
 *
 * A terminal is chosen from the environment, in order:
 *
 *   1. `$PI_BTW_LAUNCH` — a command template containing `{cmd}` (e.g.
 *      `PI_BTW_LAUNCH='kitty --title btw -e {cmd}'`); the rest is appended when
 *      `{cmd}` is absent. Use this for anything not auto-detected.
 *   2. tmux — `tmux new-window` when `$TMUX` is set.
 *   3. xfce4-terminal, kitty, wezterm, alacritty, ghostty, konsole,
 *      gnome-terminal, x-terminal-emulator, xterm.
 *   4. macOS: `osascript` driving Terminal.app.
 *
 * `$PI_BTW_PI` overrides the `pi` executable to launch (default: `pi` on PATH).
 *
 * Requirements: interactive TUI mode, a saved session file to fork, and one of
 * the launchers above. Everything is best-effort — a missing launcher or a
 * failed spawn surfaces as a `ctx.ui.notify`, never an unhandled throw.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
export const MSG_NO_SESSION = "/btw needs a saved session to fork (this session is ephemeral)";
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
 * The launcher script dropped into the temp dir. Reads the question from `$2`
 * (a file) so arbitrary multi-line text needs no quoting, runs Pi with absolute
 * `node`/entry paths plus the captured `PATH`, and removes its own temp dir
 * once Pi exits. A failed run pauses so the error is readable in the window.
 */
export function buildLauncherScript(opts: { node: string; entry: string; cwd: string; path?: string }): string {
	const lines = [
		"#!/bin/sh",
		"# Generated by the pi-plugins /btw extension; self-deletes when done.",
		'dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
		`cd ${shellQuote(opts.cwd)} || exit 1`,
	];
	if (opts.path) lines.push(`export PATH=${shellQuote(opts.path)}:"$PATH"`);
	lines.push(
		`${shellQuote(opts.node)} ${shellQuote(opts.entry)} --fork "$1" -- "$(cat "$2")"`,
		"status=$?",
		'if [ "$status" -ne 0 ]; then',
		`\tprintf '\\nbtw: pi exited with status %s\\n' "$status" >&2`,
		"\tprintf 'Press Enter to close…' >&2",
		"\tread -r _ || true",
		"fi",
		'rm -rf -- "$dir"',
		'exit "$status"',
	);
	return `${lines.join("\n")}\n`;
}

/** Locate an executable on `PATH` (or an explicit path). */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (name.includes("/") || isAbsolute(name)) return existsSync(name) ? name : undefined;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
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

/**
 * Absolute node + Pi entry paths for the launcher script. `$PI_BTW_PI` wins,
 * then this process's own entry (`process.argv[1]`), then `pi` on `PATH`.
 * Absolute paths are required because terminal servers often spawn commands
 * with a `PATH` that lacks nvm/bun-installed binaries.
 */
export function resolvePiLaunch(env: NodeJS.ProcessEnv = process.env): PiLaunch | undefined {
	const node = process.execPath;
	if (!node || !existsSync(node)) return undefined;
	const entry =
		resolveExisting(env[BTW_PI_ENV]?.trim(), env) ??
		resolveExisting(process.argv[1], env) ??
		resolveExisting(DEFAULT_PI, env);
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
 * Pick a launcher: explicit `$PI_BTW_LAUNCH`, then tmux, then the first
 * detected terminal candidate, then macOS Terminal.app.
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
	/** Injectable for tests; defaults to `node:child_process.spawn`. */
	spawnImpl?: typeof spawn;
}

export type LaunchOutcome = { ok: true; launcher: string } | { ok: false; error: string };

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
			buildLauncherScript({ node: pi.node, entry: pi.entry, cwd: request.cwd, path: env.PATH }),
			"utf8",
		);
		chmodSync(scriptFile, 0o755);

		const { command, args } = launcher.build({
			script: scriptFile,
			session: request.sessionFile,
			question: questionFile,
			cwd: request.cwd,
			title: deriveTitle(question),
		});
		const child = spawnFn(command, args, { detached: true, stdio: "ignore", cwd: request.cwd });
		child.on("error", () => {
			// Best-effort: the terminal binary vanished between detection and spawn.
		});
		child.unref();
		return { ok: true, launcher: launcher.id };
	} catch (err) {
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
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
	if (!sessionFile) {
		ctx.ui.notify(MSG_NO_SESSION, "error");
		return;
	}

	const result = launchBtw({ sessionFile, question, cwd: ctx.cwd });
	if (result.ok) {
		ctx.ui.notify(`btw: forked session opened in a new window (${result.launcher})`, "info");
	} else {
		ctx.ui.notify(result.error, "error");
	}
}

export default function btwExtension(pi: ExtensionAPI): void {
	registerBtw(pi);
}
