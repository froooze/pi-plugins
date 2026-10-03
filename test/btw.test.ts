/**
 * Tests for extensions/btw.ts — the pure launcher logic behind `/btw`.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/btw.test.ts
 */
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	buildEnvExports,
	buildLauncherScript,
	buildPiFlags,
	deriveTitle,
	detectCurrentTerminal,
	findExecutable,
	launchBtw,
	normalizeQuestion,
	resolvePiLaunch,
	selectLauncher,
	shellQuote,
	MSG_NO_TERMINAL,
} from "../extensions/btw.ts";

// ---------------------------------------------------------------------------
// normalizeQuestion
// ---------------------------------------------------------------------------

test("normalizeQuestion: strips outside whitespace, keeps internal formatting", () => {
	assert.equal(normalizeQuestion("  what is up?  "), "what is up?");
	assert.equal(normalizeQuestion("a\r\nb\r\n"), "a\nb");
	assert.equal(normalizeQuestion("\n\n  line 1\n\n    line 2\n\n"), "line 1\n\n    line 2");
	assert.equal(normalizeQuestion("   "), "");
});

// ---------------------------------------------------------------------------
// deriveTitle
// ---------------------------------------------------------------------------

test("deriveTitle: first non-blank line, collapsed and truncated", () => {
	assert.equal(deriveTitle("why is this slow?"), "btw: why is this slow?");
	assert.equal(deriveTitle("\n\n  spaced   out  \nsecond line"), "btw: spaced out");
	const long = "x".repeat(100);
	const title = deriveTitle(long);
	assert.ok(title.length <= "btw: ".length + 48, `title too long: ${title.length}`);
	assert.ok(title.endsWith("…"));
	assert.equal(deriveTitle("   "), "btw");
});

// ---------------------------------------------------------------------------
// shellQuote
// ---------------------------------------------------------------------------

test("shellQuote: single-quotes and escapes embedded quotes", () => {
	assert.equal(shellQuote("plain"), "'plain'");
	assert.equal(shellQuote("with space"), "'with space'");
	assert.equal(shellQuote("it's"), "'it'\\''s'");
});

// ---------------------------------------------------------------------------
// buildLauncherScript
// ---------------------------------------------------------------------------

test("buildLauncherScript: absolute node/entry, env re-export, pause, self-clean", () => {
	const script = buildLauncherScript({
		node: "/usr/bin/node",
		entry: "/opt/pi/cli.js",
		cwd: "/tmp/my project",
		env: { PATH: "/nvm/bin:/usr/bin", GREETING: "it's here" },
		piFlags: ["--provider", "anthropic", "--model", "claude-x", "--thinking", "high"],
	});
	assert.ok(script.includes("export PATH='/nvm/bin:/usr/bin'"));
	assert.ok(script.includes("export GREETING='it'\\''s here'"));
	assert.match(script, /pause\(\) \{/);
	assert.match(script, /cd '\/tmp\/my project' \|\| \{ pause 'working directory not found: \/tmp\/my project'/);
	assert.match(
		script,
		/'\/usr\/bin\/node' '\/opt\/pi\/cli\.js' --fork "\$1" '--provider' 'anthropic' '--model' 'claude-x' '--thinking' 'high' -- "\$\(cat "\$2"\)"/,
	);
	assert.match(script, /pause "pi exited with status \$status"/);
	assert.match(script, /rm -rf -- "\$dir"/);
});

test("buildEnvExports: shell-quotes values and skips unsafe names", () => {
	const out = buildEnvExports({ GOOD: "a b", "bad-name": "x", IFS: " ", MISSING: undefined } as NodeJS.ProcessEnv);
	assert.equal(out, "export GOOD='a b'");
});

// ---------------------------------------------------------------------------
// resolvePiLaunch
// ---------------------------------------------------------------------------

test("resolvePiLaunch: PI_BTW_PI entry wins; node is this process's executable", () => {
	const dir = mkdtempSync(join(tmpdir(), "btw-pi-"));
	try {
		const entry = join(dir, "cli.js");
		writeFileSync(entry, "// pi entry\n", "utf8");
		const pi = resolvePiLaunch({ PI_BTW_PI: entry, PATH: "" });
		assert.equal(pi?.entry, realpathSync(entry));
		assert.equal(pi?.node, process.execPath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolvePiLaunch: skips a non-runnable TS self entry", () => {
	const pi = resolvePiLaunch({ PATH: process.env.PATH });
	const self = process.argv[1];
	if (self && /\.(ts|tsx|mts|cts)$/i.test(self)) {
		assert.notEqual(pi?.entry, realpathSync(self));
	} else {
		assert.equal(pi?.entry, realpathSync(self!));
	}
});

// ---------------------------------------------------------------------------
// findExecutable
// ---------------------------------------------------------------------------

test("findExecutable: finds on PATH and honours absolute paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "btw-find-"));
	try {
		const bin = join(dir, "my-terminal");
		writeFileSync(bin, "#!/bin/sh\n", "utf8");
		chmodSync(bin, 0o755);
		assert.equal(findExecutable("my-terminal", { PATH: dir }), bin);
		assert.equal(findExecutable("definitely-not-here", { PATH: dir }), undefined);
		assert.equal(findExecutable(bin, { PATH: "" }), bin);
		assert.equal(findExecutable(join(dir, "nope"), { PATH: "" }), undefined);

		// Present but not executable: must not be selected.
		const plain = join(dir, "not-executable");
		writeFileSync(plain, "#!/bin/sh\n", "utf8");
		assert.equal(findExecutable("not-executable", { PATH: dir }), undefined);
		assert.equal(findExecutable(plain, { PATH: "" }), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// selectLauncher
// ---------------------------------------------------------------------------

test("selectLauncher: PI_BTW_LAUNCH wins and renders {cmd}", () => {
	const launcher = selectLauncher({ PI_BTW_LAUNCH: "myterm --new {cmd}" }, () => true);
	assert.ok(launcher);
	assert.equal(launcher.id, "configured");
	const built = launcher.build({ script: "/s.sh", session: "/s.jsonl", question: "/q.txt", cwd: "/c", title: "btw" });
	assert.equal(built.command, "sh");
	assert.equal(built.args[0], "-c");
	assert.equal(built.args[1], "myterm --new '/s.sh' '/s.jsonl' '/q.txt'");
});

test("selectLauncher: PI_BTW_LAUNCH without {cmd} appends the command", () => {
	const launcher = selectLauncher({ PI_BTW_LAUNCH: "myterm" }, () => true);
	assert.equal(launcher?.build({ script: "/s.sh", session: "/s", question: "/q", cwd: "/c", title: "t" }).args[1], "myterm '/s.sh' '/s' '/q'");
});

test("selectLauncher: tmux beats terminal candidates only inside tmux", () => {
	const has = (bin: string) => bin === "tmux" || bin === "xfce4-terminal";
	assert.equal(selectLauncher({ TMUX: "/tmp/tmux-1000/default,1,0" }, has)?.id, "tmux");
	assert.equal(selectLauncher({}, has)?.id, "xfce4-terminal");
});

test("selectLauncher: xfce4-terminal disables its server and passes argv verbatim", () => {
	const launcher = selectLauncher({}, (bin) => bin === "xfce4-terminal");
	assert.ok(launcher);
	const args = launcher.build({
		script: "/s.sh",
		session: "/s.jsonl",
		question: "/q.txt",
		cwd: "/proj",
		title: "btw: hi",
	}).args;
	assert.ok(args.includes("--disable-server"));
	// `--window` alongside `--disable-server` opens a second, empty window.
	assert.ok(!args.includes("--window"));
	assert.deepEqual(args.slice(-3), ["/s.sh", "/s.jsonl", "/q.txt"]);
});

test("selectLauncher: detects is done by the has() predicate", () => {
	const seen: string[] = [];
	selectLauncher({}, (bin) => {
		seen.push(bin);
		return false;
	});
	assert.ok(seen.includes("xfce4-terminal"));
	assert.ok(seen.includes("kitty"));
	assert.equal(selectLauncher({}, () => false), undefined);
});

test("selectLauncher: macOS falls back to osascript", () => {
	const launcher = selectLauncher({}, (bin) => bin === "osascript", "darwin");
	assert.equal(launcher?.id, "macos-terminal");
});

test("detectCurrentTerminal: reads emulator env markers", () => {
	assert.equal(detectCurrentTerminal({ KITTY_WINDOW_ID: "1" }), "kitty");
	assert.equal(detectCurrentTerminal({ TERM: "xterm-kitty" }), "kitty");
	assert.equal(detectCurrentTerminal({ TERM_PROGRAM: "WezTerm" }), "wezterm");
	assert.equal(detectCurrentTerminal({ TERM: "xterm-ghostty" }), "ghostty");
	assert.equal(detectCurrentTerminal({ GNOME_TERMINAL_SERVICE: "x" }), "gnome-terminal");
	assert.equal(detectCurrentTerminal({}), undefined);
});

test("selectLauncher: prefers the terminal we are running inside", () => {
	const has = () => true; // xfce4-terminal and kitty both installed
	assert.equal(selectLauncher({ KITTY_WINDOW_ID: "1" }, has)?.id, "kitty");
	assert.equal(selectLauncher({}, has)?.id, "xfce4-terminal");
});

// ---------------------------------------------------------------------------
// launchBtw
// ---------------------------------------------------------------------------

/** Single-quoted substrings from a rendered shell command, in order. */
function quotedParts(command: string): string[] {
	return [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1]!.replace(/'\\''/g, "'"));
}

function fakeSpawn(calls: { command: string; args: string[] }[]) {
	return ((command: string, args: string[]) => {
		calls.push({ command, args });
		return { pid: 1234, on() {}, unref() {} } as never;
	}) as never;
}

test("launchBtw: no launcher reports the configured-hint error", () => {
	const outcome = launchBtw({ sessionFile: "/s.jsonl", question: "hi", cwd: "/tmp", env: { PATH: "" } });
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.equal(outcome.error, MSG_NO_TERMINAL);
});

test("launchBtw: empty question is rejected before any launch", () => {
	const calls: { command: string; args: string[] }[] = [];
	const outcome = launchBtw({
		sessionFile: "/s.jsonl",
		question: "   \n  ",
		cwd: "/tmp",
		env: { PI_BTW_LAUNCH: "myterm {cmd}" },
		spawnImpl: fakeSpawn(calls),
	});
	assert.equal(outcome.ok, false);
	assert.equal(calls.length, 0);
});

test("launchBtw: reports a failed spawn instead of claiming success", () => {
	const calls: { command: string; args: string[] }[] = [];
	const outcome = launchBtw({
		sessionFile: "/sessions/copy.jsonl",
		question: "hi",
		cwd: "/tmp/project",
		env: { PI_BTW_LAUNCH: "myterm {cmd}", PATH: process.env.PATH },
		spawnImpl: ((command: string, args: string[]) => {
			calls.push({ command, args });
			return { pid: undefined, on() {}, unref() {} } as never;
		}) as never,
	});
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.match(outcome.error, /could not start/);
	assert.equal(calls.length, 1);
});

test("buildPiFlags: pins provider/model and thinking", () => {
	assert.deepEqual(
		buildPiFlags({ model: { provider: "anthropic", id: "claude-x" }, thinkingLevel: "high" } as never),
		["--provider", "anthropic", "--model", "claude-x", "--thinking", "high"],
	);
	assert.deepEqual(buildPiFlags({ model: undefined, thinkingLevel: undefined } as never), []);
});

test("launchBtw: writes a multi-line question and spawns the configured terminal", () => {
	const calls: { command: string; args: string[] }[] = [];
	const question = "line 1\n\n  indented line 2\nline 3";
	const outcome = launchBtw({
		sessionFile: "/sessions/copy.jsonl",
		question,
		cwd: "/tmp/project",
		env: { PI_BTW_LAUNCH: "myterm --flag {cmd}", PATH: process.env.PATH },
		spawnImpl: fakeSpawn(calls),
	});
	assert.equal(outcome.ok, true);
	if (outcome.ok) assert.equal(outcome.launcher, "configured");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.command, "sh");

	const parts = quotedParts(calls[0]!.args[1]!);
	// Order: script, session, question.
	assert.deepEqual(parts.slice(1, 3), ["/sessions/copy.jsonl", parts[2]!]);
	const [scriptPath, sessionPath, questionPath] = parts;
	assert.equal(sessionPath, "/sessions/copy.jsonl");
	assert.match(readFileSync(scriptPath!, "utf8"), /--fork "\$1" -- "\$\(cat "\$2"\)"/);
	assert.equal(readFileSync(questionPath!, "utf8"), `${question}\n`);

	rmSync(join(questionPath!, ".."), { recursive: true, force: true });
});
