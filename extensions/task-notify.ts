/**
 * task-notify — desktop notification when a run finishes.
 *
 * pi has no reliable out-of-band completion signal beyond a terminal bell:
 * VTE-family terminals (Ptyxis, GNOME Terminal, Tilix, …), Alacritty and bare
 * xterm have no OSC that surfaces an arbitrary toast, so a backgrounded pi
 * tab stays silent when a long task completes. This extension closes that gap
 * by fanning a real desktop notification out through the OS notifier.
 *
 * Trigger: `agent_settled` — the point where the run has fully settled, i.e.
 * after retries, auto-compaction and queued continuations finish. Deliberately
 * NOT `agent_end`, which fires per low-level run inside one prompt and would
 * notify mid-retry as if the task were done.
 *
 * Outcome is read from the last assistant message's `stopReason` in the
 * current branch, the same source `todo-reconcile` uses:
 * - "error"    → "Stopped with error"
 * - "aborted"  → never notified (the user cancelled; no toast)
 * - anything else (stop, length, toolUse, undefined) → "Task complete"
 *
 * Delivery is best-effort and platform-native, tried in order per OS:
 * - Linux:   `notify-send` (libnotify), falling back to `gdbus call` against
 *            org.freedesktop.Notifications when libnotify is absent.
 * - macOS:   `osascript -e 'display notification …'`.
 * - Windows: PowerShell via `-EncodedCommand` (UTF-16LE base64) using the
 *            WinRT Windows.UI.Notifications toast API, so quoting cannot break.
 *
 * Desktop coverage — the Linux path is protocol-level, not X11-specific. It
 * talks the freedesktop `org.freedesktop.Notifications` D-Bus service, which
 * is exactly what KDE Plasma (including Plasma Wayland / KWin), GNOME,
 * XFCE, sway/mako and dunst all expose. So the same `notify-send`/
 * `gdbus` calls deliver a real toast on KDE Wayland with no extra branch. On
 * KDE the app identity comes from `--app-name`; Plasma’s `kded`/`plasmashell`
 * owns the notification. No Wayland display connection is needed because the
 * bytes go over the session bus, not the compositor.
 *
 * Position, transparency and colors are NOT set by this extension: the
 * freedesktop API has no such fields. They are owned by the running
 * notification daemon and configured there — for example KDE
 * System Settings → Notifications (position per-screen, `kwriteconfig`),
 * xfce4-notifyd `notify-location`/theme, or dunst `origin`/`gap_size`.
 *
 * A failed spawn or missing binary is a silent no-op: a completion toast must
 * never throw into the settled event or delay the session.
 *
 * Opt-outs:
 * - `PI_TASK_NOTIFY=off|0|false` (this extension) or `PI_NOTIFICATIONS=off`
 *   (pi-wide convention) disable delivery for the process.
 *
 * Content: the title is the session name when one is set, otherwise the
 * source folder name (basename of the working directory); the body carries
 * the outcome, the duration and the source path, e.g.
 *   pi-plugins
 *   Task complete · 1m 23s · ~/BTS/Git/pi-plugins
 * The path is shortened against `$HOME` where possible and collapsed to one
 * line so a notifier cannot mis-render it. Toasts stay on screen ~5s.
 *
 * Config (optional), `<agentDir>/task-notify.json` (or
 * `$PI_CODING_AGENT_DIR/task-notify.json`):
 * {
 *   "enabled": true,
 *   "notifyOn": "both",        // "both" | "complete" | "error" | "off"
 *   "includeDuration": true,   // append the "· 1m 23s" duration segment
 *   "includeSourcePath": true, // append the "· ~/BTS/Git/pi-plugins" segment
 *   "minDurationMs": 0         // skip runs shorter than this
 * }
 *
 * Command: `/notify [status|test|on|off]` — `status` prints the resolved
 * backend chain, `test` fires a toast so you can confirm delivery (useful on a
 * new KDE Wayland machine) and names the backend that succeeded.
 *
 * TUI-only: headless/print/RPC sessions have no desktop to notify.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ============================================================================
// Pure helpers (exported for tests)
// ============================================================================

export type NotifyOutcome = "complete" | "error" | "aborted";
export type NotifyPlatform = "linux" | "darwin" | "win32";
export type NotifyOn = "both" | "complete" | "error" | "off";

export interface NotifyMessage {
	title: string;
	body: string;
}

export interface NotifyCommand {
	command: string;
	args: string[];
}

export interface NotifyConfig {
	enabled: boolean;
	notifyOn: NotifyOn;
	includeDuration: boolean;
	includeSourcePath: boolean;
	minDurationMs: number;
}

const CONFIG_FILE_NAME = "task-notify.json";
const APP_NAME = "pi";
const MAX_FIELD_LEN = 200;
/** How long the toast stays on screen, in milliseconds. */
export const NOTIFY_EXPIRE_MS = 5000;

export const DEFAULTS: NotifyConfig = {
	enabled: true,
	notifyOn: "both",
	includeDuration: true,
	includeSourcePath: true,
	minDurationMs: 0,
};

/** Outcome of a settled run from its final assistant `stopReason`. */
export function classifyStopReason(stopReason: string | undefined): NotifyOutcome {
	if (stopReason === "error") return "error";
	if (stopReason === "aborted") return "aborted";
	return "complete";
}

/** Stop reason of the last assistant message in the branch (scan from the end). */
export function lastAssistantStopReason(branch: Iterable<unknown>): string | undefined {
	const entries = Array.from(branch);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as {
			type?: string;
			message?: { role?: string; stopReason?: string };
		};
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			return entry.message.stopReason;
		}
	}
	return undefined;
}

/** Whether the configured policy wants a toast for this outcome. */
export function shouldNotifyOutcome(config: NotifyConfig, outcome: NotifyOutcome): boolean {
	if (!config.enabled) return false;
	if (config.notifyOn === "off") return false;
	if (outcome === "aborted") return false;
	if (config.notifyOn === "both") return true;
	return config.notifyOn === outcome;
}

/** Human duration: "820ms", "12s", "1m 23s", "1h 02m". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** Collapse control characters/whitespace so a session name cannot break a notifier. */
export function sanitizeText(value: string, max = MAX_FIELD_LEN): string {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** Shorten an absolute path against the home directory, e.g. `~/BTS/Git/pi-plugins`. */
export function formatSourcePath(path: string | undefined, home?: string): string | undefined {
	if (!path || !path.trim()) return undefined; // empty/whitespace-only: no segment
	const trimmed = path.replace(/[\\/]+$/, "");
	if (!trimmed) return undefined;
	const normalizedHome = home?.replace(/[\\/]+$/, "");
	if (normalizedHome) {
		if (trimmed === normalizedHome) return "~";
		if (trimmed.startsWith(`${normalizedHome}/`) || trimmed.startsWith(`${normalizedHome}\\`)) {
			return `~${trimmed.slice(normalizedHome.length)}`;
		}
	}
	return trimmed;
}

/**
 * Notification title: the session name when set, else the source folder name,
 * else the bare app name. Always non-empty.
 */
export function buildTitle(
	sessionName: string | undefined,
	sourcePath?: string,
	appName = APP_NAME,
): string {
	// sanitizeText can collapse a control-only string to "", so re-check the
	// cleaned value before accepting it; never return an empty title.
	const name = sessionName ? sanitizeText(sessionName) : "";
	if (name) return name;
	if (sourcePath) {
		const folder = sanitizeText(basename(sourcePath.replace(/[\\/]+$/, "")));
		if (folder) return folder;
	}
	return appName;
}

/**
 * Multi-segment body: outcome, optional duration, optional source path —
 * joined with " · " so each fact is scannable at a glance.
 */
/**
 * Multi-segment body: outcome, optional duration, optional source path —
 * joined with " · " so each fact is scannable at a glance. `sourcePath` is
 * the raw working directory; pass `home` to shorten it to `~/…`.
 */
export function buildBody(
	config: NotifyConfig,
	outcome: NotifyOutcome,
	elapsedMs: number | undefined,
	sourcePath?: string,
	home?: string,
): string {
	const headline = outcome === "error" ? "Stopped with error" : "Task complete";
	const parts = [headline];
	if (config.includeDuration && elapsedMs !== undefined) parts.push(formatDuration(elapsedMs));
	const path = config.includeSourcePath ? formatSourcePath(sourcePath, home) : undefined;
	if (path) parts.push(path);
	return parts.join(" · ");
}

/** XML-escape for the Windows toast template. */
export function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** AppleScript string literal (double-quoted) with backslash/quote escaping. */
function appleScriptString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** PowerShell script using the WinRT toast API; returned base64 is UTF-16LE. */
export function powershellNotifyCommand(message: NotifyMessage, appName = APP_NAME): NotifyCommand {
	const title = xmlEscape(sanitizeText(message.title));
	const body = xmlEscape(sanitizeText(message.body));
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
		"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
		`$template = "<toast><visual><binding template=\\"ToastGeneric\\"><text>${title}</text><text>${body}</text></binding></visual></toast>"`,
		"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
		"$xml.LoadXml($template)",
		"$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appName.replace(/'/g, "''")}').Show($toast)`,
	].join("; ");
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] };
}

/**
 * Ordered delivery attempts for a platform. The caller tries each in turn and
 * stops at the first successful one.
 */
export function buildNotifyCommands(
	platform: NotifyPlatform,
	message: NotifyMessage,
	appName = APP_NAME,
): NotifyCommand[] {
	const title = sanitizeText(message.title);
	const body = sanitizeText(message.body);
	switch (platform) {
		case "darwin":
			return [
				{
					command: "osascript",
					args: ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`],
				},
			];
		case "win32":
			return [powershellNotifyCommand({ title, body }, appName)];
		default:
			return [
				{
					command: "notify-send",
					args: ["--app-name", appName, "--urgency=normal", `--expire-time=${NOTIFY_EXPIRE_MS}`, title, body],
				},
				{
					command: "gdbus",
					args: [
						"call",
						"--session",
						"--dest",
						"org.freedesktop.Notifications",
						"--object-path",
						"/org/freedesktop/Notifications",
						"--method",
						"org.freedesktop.Notifications.Notify",
						appName,
						"0",
						"",
						title,
						body,
						"[]",
						"{}",
						String(NOTIFY_EXPIRE_MS),
					],
				},
			];
	}
}

/**
 * Human-readable backend chain for the current platform, e.g.
 * "notify-send → gdbus" on Linux (X11 *and* Wayland, incl. KDE Plasma).
 * Used by `/notify status` so delivery can be confirmed on an unfamiliar box.
 */
export function describeNotifyBackends(platform: NotifyPlatform = process.platform as NotifyPlatform): string {
	return buildNotifyCommands(platform, { title: "probe", body: "probe" })
		.map((candidate) => candidate.command)
		.join(" → ");
}

/** Normalize a parsed JSON value into a config; corrupt input yields defaults. */
export function parseConfig(raw: unknown): NotifyConfig {
	const config: NotifyConfig = { ...DEFAULTS };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return config;
	const record = raw as Record<string, unknown>;
	if (typeof record.enabled === "boolean") config.enabled = record.enabled;
	if (
		record.notifyOn === "both" ||
		record.notifyOn === "complete" ||
		record.notifyOn === "error" ||
		record.notifyOn === "off"
	) {
		config.notifyOn = record.notifyOn;
	}
	if (typeof record.includeDuration === "boolean") config.includeDuration = record.includeDuration;
	if (typeof record.includeSourcePath === "boolean") config.includeSourcePath = record.includeSourcePath;
	if (typeof record.minDurationMs === "number" && Number.isInteger(record.minDurationMs) && record.minDurationMs >= 0) {
		config.minDurationMs = record.minDurationMs;
	}
	return config;
}

/** Whether the process opted out, either per-extension or pi-wide. */
export function isNotificationSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
	const local = env.PI_TASK_NOTIFY?.trim().toLowerCase();
	if (local === "off" || local === "0" || local === "false") return true;
	const global = env.PI_NOTIFICATIONS?.trim().toLowerCase();
	return global === "off" || global === "0" || global === "false";
}

// ============================================================================
// Config I/O
// ============================================================================

function configPath(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return join(override || getAgentDir(), CONFIG_FILE_NAME);
}

export function loadConfig(): NotifyConfig {
	try {
		if (!existsSync(configPath())) return { ...DEFAULTS };
		return parseConfig(JSON.parse(readFileSync(configPath(), "utf8")));
	} catch {
		return { ...DEFAULTS }; // Corrupt config: defaults, never break the session.
	}
}

function saveConfig(config: NotifyConfig): void {
	try {
		writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch {
		// Persistence is best effort; the in-memory value still applies.
	}
}

// ============================================================================
// Delivery
// ============================================================================

/**
 * Fire the first notifier that succeeds and report its command name, or null
 * when none is available. Every failure is swallowed — a completion toast is
 * best-effort and must not surface into the session.
 */
async function deliver(pi: ExtensionAPI, ctx: ExtensionContext, message: NotifyMessage): Promise<string | null> {
	if (isNotificationSuppressed()) return null;
	const platform = process.platform as NotifyPlatform;
	for (const candidate of buildNotifyCommands(platform, message)) {
		try {
			const result = await pi.exec(candidate.command, candidate.args, { cwd: ctx.cwd, timeout: 5000 });
			if (result.code === 0) return candidate.command;
		} catch {
			// Missing binary or spawn failure: try the next candidate.
		}
	}
	return null;
}

function sessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId() || undefined;
	} catch {
		return undefined; // stale ctx after session replacement
	}
}

function sessionName(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionName();
	} catch {
		return undefined; // stale ctx after session replacement
	}
}

export default function taskNotify(pi: ExtensionAPI) {
	/** Run start time per session, for the duration suffix. */
	const startedAt = new Map<string, number>();

	pi.on("agent_start", (_event, ctx) => {
		const id = sessionId(ctx);
		if (id) startedAt.set(id, Date.now());
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			if (ctx.mode !== "tui") return; // headless/RPC has no desktop to notify
			const config = loadConfig();
			if (!config.enabled || config.notifyOn === "off") return;

			const id = sessionId(ctx);
			const branch = ctx.sessionManager.getBranch() as Iterable<unknown>;
			const outcome = classifyStopReason(lastAssistantStopReason(branch));
			if (!shouldNotifyOutcome(config, outcome)) return;

			const started = id ? startedAt.get(id) : undefined;
			const elapsedMs = started === undefined ? undefined : Date.now() - started;
			if (elapsedMs !== undefined && elapsedMs < config.minDurationMs) return;

			await deliver(pi, ctx, {
				title: buildTitle(sessionName(ctx), ctx.cwd),
				body: buildBody(config, outcome, elapsedMs, ctx.cwd, homedir()),
			});
		} catch {
			// A missed notification is harmless; never break the settled event.
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const id = sessionId(ctx);
		if (id) startedAt.delete(id);
	});

	pi.registerCommand("notify", {
		description: "Desktop completion notifications: /notify [status|test|on|off]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();
			const config = loadConfig();

			if (sub === "on" || sub === "off") {
				saveConfig({ ...config, enabled: sub === "on" });
				ctx.ui.notify(`task-notify: ${sub === "on" ? "enabled" : "disabled"}.`, "info");
				return;
			}

			if (sub === "test") {
				const sourcePath = config.includeSourcePath ? formatSourcePath(ctx.cwd, homedir()) : undefined;
				const used = await deliver(pi, ctx, {
					title: buildTitle(sessionName(ctx), ctx.cwd),
					body: ["Test notification", sourcePath].filter(Boolean).join(" · "),
				});
				ctx.ui.notify(
					used
						? `task-notify: test notification sent via ${used}.`
						: `task-notify: no notifier available (tried ${describeNotifyBackends()}).`,
					used ? "info" : "warning",
				);
				return;
			}

			const suppressed = isNotificationSuppressed()
				? ` (suppressed by ${process.env.PI_TASK_NOTIFY ? "PI_TASK_NOTIFY" : "PI_NOTIFICATIONS"})`
				: "";
			ctx.ui.notify(
				`task-notify: ${config.enabled ? "enabled" : "disabled"}, notifyOn=${config.notifyOn}, ` +
					`duration=${config.includeDuration ? "on" : "off"}, ` +
					`source=${config.includeSourcePath ? "on" : "off"}, min=${config.minDurationMs}ms${suppressed}. ` +
					`Backends: ${describeNotifyBackends()}. Config: ${configPath()}. TUI-only.`,
				"info",
			);
		},
	});
}
