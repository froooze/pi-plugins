/**
 * Tests for extensions/task-notify.ts pure logic.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/task-notify.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	buildBody,
	buildNotifyCommands,
	buildTitle,
	classifyStopReason,
	DEFAULTS,
	describeNotifyBackends,
	formatDuration,
	formatSourcePath,
	isNotificationSuppressed,
	lastAssistantStopReason,
	NOTIFY_EXPIRE_MS,
	parseConfig,
	powershellNotifyCommand,
	sanitizeText,
	shouldNotifyOutcome,
	xmlEscape,
	type NotifyConfig,
} from "../extensions/task-notify.ts";

// ---------------------------------------------------------------------------
// classifyStopReason / lastAssistantStopReason
// ---------------------------------------------------------------------------

test("classifyStopReason: error/aborted are distinct, everything else completes", () => {
	assert.equal(classifyStopReason("error"), "error");
	assert.equal(classifyStopReason("aborted"), "aborted");
	for (const reason of ["stop", "length", "toolUse", undefined, "weird"]) {
		assert.equal(classifyStopReason(reason), "complete");
	}
});

test("lastAssistantStopReason: last assistant wins, toolResults are skipped", () => {
	const branch = [
		{ type: "message", message: { role: "assistant", stopReason: "toolUse" } },
		{ type: "message", message: { role: "toolResult", toolName: "read" } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant", stopReason: "error" } },
	];
	assert.equal(lastAssistantStopReason(branch), "error");
});

test("lastAssistantStopReason: undefined with no assistant message", () => {
	assert.equal(lastAssistantStopReason([]), undefined);
	assert.equal(lastAssistantStopReason([{ type: "message", message: { role: "user" } }]), undefined);
});

// ---------------------------------------------------------------------------
// shouldNotifyOutcome
// ---------------------------------------------------------------------------

function config(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
	return { ...DEFAULTS, ...overrides };
}

test("shouldNotifyOutcome: 'both' notifies complete and error, never aborted", () => {
	const cfg = config({ notifyOn: "both" });
	assert.equal(shouldNotifyOutcome(cfg, "complete"), true);
	assert.equal(shouldNotifyOutcome(cfg, "error"), true);
	assert.equal(shouldNotifyOutcome(cfg, "aborted"), false);
});

test("shouldNotifyOutcome: targeted policies notify only their outcome", () => {
	assert.equal(shouldNotifyOutcome(config({ notifyOn: "complete" }), "complete"), true);
	assert.equal(shouldNotifyOutcome(config({ notifyOn: "complete" }), "error"), false);
	assert.equal(shouldNotifyOutcome(config({ notifyOn: "error" }), "error"), true);
	assert.equal(shouldNotifyOutcome(config({ notifyOn: "error" }), "complete"), false);
});

test("shouldNotifyOutcome: off and disabled gate everything out", () => {
	assert.equal(shouldNotifyOutcome(config({ notifyOn: "off" }), "complete"), false);
	assert.equal(shouldNotifyOutcome(config({ enabled: false }), "error"), false);
});

// ---------------------------------------------------------------------------
// formatDuration / buildBody / sanitize
// ---------------------------------------------------------------------------

test("formatDuration: scales from ms to hours", () => {
	assert.equal(formatDuration(0), "0ms");
	assert.equal(formatDuration(820), "820ms");
	assert.equal(formatDuration(12_000), "12s");
	assert.equal(formatDuration(83_000), "1m 23s");
	assert.equal(formatDuration(3_720_000), "1h 02m");
	assert.equal(formatDuration(-5), "0ms");
});

test("buildBody: headline, optional duration suffix", () => {
	assert.equal(buildBody(config(), "complete", undefined), "Task complete");
	assert.equal(buildBody(config(), "error", undefined), "Stopped with error");
	assert.equal(buildBody(config(), "complete", 83_000), "Task complete · 1m 23s");
	assert.equal(buildBody(config({ includeDuration: false }), "complete", 83_000), "Task complete");
});

test("buildBody: appends source path, gated by includeSourcePath", () => {
	assert.equal(
		buildBody(config(), "complete", 83_000, "/home/alex/BTS/Git/pi-plugins"),
		"Task complete · 1m 23s · /home/alex/BTS/Git/pi-plugins",
	);
	assert.equal(
		buildBody(config({ includeSourcePath: false }), "complete", 83_000, "/home/alex/BTS/Git/pi-plugins"),
		"Task complete · 1m 23s",
	);
	assert.equal(buildBody(config(), "complete", undefined, "/tmp/x"), "Task complete · /tmp/x");
	// home shortens the path once, in buildBody itself
	assert.equal(
		buildBody(config(), "complete", 83_000, "/home/alex/BTS/Git/pi-plugins", "/home/alex"),
		"Task complete · 1m 23s · ~/BTS/Git/pi-plugins",
	);
	// a whitespace-only path adds no trailing segment
	assert.equal(buildBody(config(), "complete", 83_000, "   "), "Task complete · 1m 23s");
});

test("formatSourcePath: collapses trailing slashes and shortens against home", () => {
	assert.equal(formatSourcePath(undefined), undefined);
	assert.equal(formatSourcePath("/"), undefined);
	assert.equal(formatSourcePath("   "), undefined);
	assert.equal(formatSourcePath("/tmp/x/"), "/tmp/x");
	assert.equal(formatSourcePath("/home/alex/BTS/Git/pi-plugins", "/home/alex"), "~/BTS/Git/pi-plugins");
	assert.equal(formatSourcePath("/home/alex", "/home/alex"), "~");
	assert.equal(formatSourcePath("/home/alexander/x", "/home/alex"), "/home/alexander/x");
});

test("buildTitle: session name wins, then project folder, then app name", () => {
	assert.equal(buildTitle("my session", "/home/alex/BTS/Git/pi-plugins"), "my session");
	assert.equal(buildTitle("  ", "/home/alex/BTS/Git/pi-plugins"), "pi-plugins");
	assert.equal(buildTitle(undefined, "/home/alex/BTS/Git/pi-plugins/"), "pi-plugins");
	assert.equal(buildTitle(undefined, undefined), "pi");
	// control-only names sanitize to "" and must fall through, never emit an empty title
	assert.equal(buildTitle("\u0001\u0002", "/x/y"), "y");
	assert.equal(buildTitle(undefined, "/\u0001\u0002"), "pi");
});

test("sanitizeText: strips control chars, collapses whitespace, caps length", () => {
	assert.equal(sanitizeText("  a\u0000b\n\tc  "), "a b c");
	const long = sanitizeText("x".repeat(500));
	assert.equal(long.length, 201); // 200 + ellipsis
	assert.ok(long.endsWith("…"));
});

// ---------------------------------------------------------------------------
// Platform command builders
// ---------------------------------------------------------------------------

test("buildNotifyCommands: linux prefers notify-send then gdbus", () => {
	const cmds = buildNotifyCommands("linux", { title: "t", body: "b" });
	assert.equal(cmds.length, 2);
	assert.equal(cmds[0].command, "notify-send");
	assert.deepEqual(cmds[0].args.slice(-2), ["t", "b"]);
	assert.equal(cmds[1].command, "gdbus");
	assert.ok(cmds[1].args.includes("org.freedesktop.Notifications.Notify"));
	assert.ok(cmds[1].args.includes("t"));
	assert.ok(cmds[1].args.includes("b"));
});

test("buildNotifyCommands: toasts request the shared expire time on Linux", () => {
	const cmds = buildNotifyCommands("linux", { title: "t", body: "b" });
	assert.equal(NOTIFY_EXPIRE_MS, 5000);
	assert.ok(cmds[0].args.includes(`--expire-time=${NOTIFY_EXPIRE_MS}`));
	assert.equal(cmds[1].args[cmds[1].args.length - 1], String(NOTIFY_EXPIRE_MS));
});

test("buildNotifyCommands: darwin uses osascript display notification", () => {
	const cmds = buildNotifyCommands("darwin", { title: "Ti", body: "Bo" });
	assert.equal(cmds.length, 1);
	assert.equal(cmds[0].command, "osascript");
	assert.equal(cmds[0].args[0], "-e");
	assert.match(cmds[0].args[1], /display notification "Bo" with title "Ti"/);
});

test("buildNotifyCommands: darwin escapes quotes/backslashes in AppleScript", () => {
	const cmds = buildNotifyCommands("darwin", { title: 'a"b', body: "c\\d" });
	assert.match(cmds[0].args[1], /\\"b/);
	assert.match(cmds[0].args[1], /c\\\\d/);
});

test("buildNotifyCommands: win32 uses powershell -EncodedCommand with UTF-16LE base64", () => {
	const cmds = buildNotifyCommands("win32", { title: "Ti", body: "Bo" });
	assert.equal(cmds.length, 1);
	assert.equal(cmds[0].command, "powershell");
	assert.ok(cmds[0].args.includes("-EncodedCommand"));
	const b64 = cmds[0].args[cmds[0].args.length - 1];
	const decoded = Buffer.from(b64, "base64").toString("utf16le");
	assert.match(decoded, /ToastNotificationManager/);
	assert.match(decoded, /<text>Ti<\/text>/);
	assert.match(decoded, /<text>Bo<\/text>/);
});

test("powershellNotifyCommand: XML-escapes title/body and single quotes in app name", () => {
	const cmd = powershellNotifyCommand({ title: "a<b&c", body: "d\"e" }, "pi's app");
	const decoded = Buffer.from(cmd.args[cmd.args.length - 1], "base64").toString("utf16le");
	assert.match(decoded, /a&lt;b&amp;c/);
	assert.match(decoded, /d&quot;e/);
	assert.match(decoded, /pi''s app/);
});

test("xmlEscape: escapes all five XML entities", () => {
	assert.equal(xmlEscape(`<&>"'`), "&lt;&amp;&gt;&quot;&apos;");
});

test("describeNotifyBackends: names the per-platform chain", () => {
	assert.equal(describeNotifyBackends("linux"), "notify-send → gdbus");
	assert.equal(describeNotifyBackends("darwin"), "osascript");
	assert.equal(describeNotifyBackends("win32"), "powershell");
});

test("linux backend is the freedesktop D-Bus service (works on X11 and Wayland/KDE)", () => {
	// Both candidates target org.freedesktop.Notifications, which is what KDE
	// Plasma (incl. Plasma Wayland/KWin), GNOME, XFCE, sway and dunst expose.
	const cmds = buildNotifyCommands("linux", { title: "t", body: "b" });
	const gdbus = cmds.find((c) => c.command === "gdbus");
	assert.ok(gdbus);
	assert.ok(gdbus.args.includes("org.freedesktop.Notifications"));
	assert.ok(gdbus.args.includes("org.freedesktop.Notifications.Notify"));
	// No Wayland/X11-specific flag: delivery is over the session bus only.
	assert.ok(!cmds.some((c) => c.args.some((a) => a.includes("WAYLAND_DISPLAY") || a.includes("DISPLAY="))));
});

// ---------------------------------------------------------------------------
// parseConfig / suppression
// ---------------------------------------------------------------------------

test("parseConfig: defaults for non-objects and corrupt shapes", () => {
	assert.deepEqual(parseConfig(null), DEFAULTS);
	assert.deepEqual(parseConfig("nope"), DEFAULTS);
	assert.deepEqual(parseConfig([1, 2]), DEFAULTS);
});

test("parseConfig: applies valid fields and rejects invalid ones", () => {
	assert.deepEqual(
		parseConfig({
			enabled: false,
			notifyOn: "error",
			includeDuration: false,
			includeSourcePath: false,
			minDurationMs: 5000,
		}),
		{
			enabled: false,
			notifyOn: "error",
			includeDuration: false,
			includeSourcePath: false,
			minDurationMs: 5000,
		},
	);
	assert.deepEqual(parseConfig({ notifyOn: "bogus" }), DEFAULTS);
	assert.deepEqual(parseConfig({ minDurationMs: -1 }), DEFAULTS);
	assert.deepEqual(parseConfig({ minDurationMs: 1.5 }), DEFAULTS);
	assert.deepEqual(parseConfig({ enabled: "yes" }), DEFAULTS);
});

test("isNotificationSuppressed: PI_TASK_NOTIFY and PI_NOTIFICATIONS opt-outs", () => {
	assert.equal(isNotificationSuppressed({}), false);
	assert.equal(isNotificationSuppressed({ PI_TASK_NOTIFY: "off" }), true);
	assert.equal(isNotificationSuppressed({ PI_TASK_NOTIFY: "0" }), true);
	assert.equal(isNotificationSuppressed({ PI_NOTIFICATIONS: "false" }), true);
	assert.equal(isNotificationSuppressed({ PI_TASK_NOTIFY: "on" }), false);
});
