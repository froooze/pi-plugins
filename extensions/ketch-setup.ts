/**
 * ketch-setup — install, verify, and configure the ketch research CLI.
 *
 * ketch (https://ketch.run, 1broseidon/ketch, MIT) is the stateless research
 * binary the bundled `skills/ketch` playbook drives through bash: web search,
 * OSS code search, library docs, page scraping. Pi has no built-in web tool,
 * so ketch is the research surface — this extension owns its operator side:
 *
 * - `/ketch` (or `/ketch status`) — resolved binary path, `ketch version
 *   --json`, effective backend + key presence (`ketch config`), and a
 *   `ketch doctor --json` summary: counts, every non-ok row with its reason,
 *   and the blocking (exit 5) marker. Pure rendering: `buildStatusLines`.
 * - `/ketch setup` — guided bootstrap, mutate only after `ctx.ui.confirm`
 *   (ketch's own "propose, then mutate" discipline):
 *     1. install when missing — default channel downloads the release asset
 *        and verifies SHA-256 against the release `checksums.txt` (no shell
 *        piping, no Go toolchain); Homebrew and npm channels available.
 *     2. crash-test the binary with a *raw* spawn (no GOMAXPROCS injected).
 *        Hosts whose cgroup reports cpu quota 0/0 make Go 1.25's
 *        container-aware GOMAXPROCS compute 0 and abort at startup
 *        (`fatal error: procresize: invalid arg`). An observed crash installs
 *        the 3-line `~/.local/bin/ketch` wrapper (real binary parked at
 *        `~/.local/libexec/ketch-bin`); a healthy raw run changes nothing.
 *        Windows is skipped: no wrapper (shebang), zip extraction manual.
 *     3. optional API-key entry for a short curated list — the key goes from
 *        `ctx.ui.input` straight into a spawned `ketch config set` argv. It
 *        never passes through the model context or the session transcript;
 *        only the child process argv (brief, single-user host) sees it.
 *     4. final `ketch doctor --json` — upstream's own step 5: confirm the
 *        config resolves after every mutation.
 * - `session_start` — filesystem-only PATH probe (no spawn, no network).
 *   Missing binary → one warning per install: `missingNotified` latches until
 *   `/ketch setup` succeeds, so a dismissal is not a per-session nag.
 *
 * Every ketch spawn from this extension injects `GOMAXPROCS` (visible CPU
 * count) when the environment does not set it, so status/setup work even
 * before the wrapper exists. Commands run while pi is idle — `ctx.signal` is
 * typically undefined there — so child timeouts are the actual guard: 20s
 * default, 60s for `doctor` (21 concurrent probes), 120s for installs.
 *
 * Config (optional), `<agentDir>/ketch-setup.json`:
 * {
 *   "enabled": true          // false = no session_start check (commands stay)
 * }
 * `PI_KETCH_SETUP=off` disables the session_start check via env as well.
 *
 * Version pin: RELEASE_VERSION matches `skills/ketch` (vendored from
 * v0.18.0) — bump the installer, the vendored skill, and this comment
 * together. Rule 6 of the skill still governs: the binary outranks the file.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Installer pin — keep aligned with skills/ketch (vendored from the same line). */
export const RELEASE_VERSION = "v0.18.0";
const RELEASE_BASE = `https://github.com/1broseidon/ketch/releases/download/${RELEASE_VERSION}`;
const CONFIG_FILE_NAME = "ketch-setup.json";
const ENV_OFF = "PI_KETCH_SETUP";
const IS_WINDOWS = process.platform === "win32";
const BIN_NAME = IS_WINDOWS ? "ketch.exe" : "ketch";
const DEFAULT_TIMEOUT_MS = 20_000;
const DOCTOR_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
/** Cap captured child output so a runaway binary cannot bloat the session. */
const MAX_OUTPUT_BYTES = 1 << 20;

/* ------------------------------------------------------------------ types */

export type DoctorRow = { surface: string; backend: string; status: string; detail?: string };
export type DoctorSummary = {
	total: number;
	ok: number;
	skipped: number;
	problems: DoctorRow[];
	blocking: number;
};
export type SetupConfig = { enabled: boolean; missingNotified: boolean };
export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type StatusInput = {
	binPath?: string;
	version?: Record<string, unknown>;
	config?: Record<string, unknown>;
	summary?: DoctorSummary;
	doctorExit?: number | null;
};

/* ------------------------------------------------------------------ pure */

/**
 * Structural parse of `ketch doctor --json` (an array of check objects).
 * Corrupt/foreign entries are skipped, never thrown — a doctor schema change
 * degrades the status view instead of breaking the command.
 */
export function summarizeDoctor(raw: unknown): DoctorSummary {
	const rows: DoctorRow[] = [];
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			if (typeof e.status !== "string") continue;
			rows.push({
				surface: typeof e.surface === "string" ? e.surface : "?",
				backend: typeof e.backend === "string" ? e.backend : "?",
				status: e.status,
				detail: typeof e.detail === "string" ? e.detail : undefined,
			});
		}
	}
	const isOk = (r: DoctorRow) => r.status === "ok";
	const isSkipped = (r: DoctorRow) => r.status === "skipped";
	return {
		total: rows.length,
		ok: rows.filter(isOk).length,
		skipped: rows.filter(isSkipped).length,
		problems: rows.filter((r) => !isOk(r) && !isSkipped(r)),
		// v0.18.0: `misconfigured` is the class doctor exits 5 on; no_key /
		// unreachable / skipped stay informational. The exit code is read
		// separately for the headline — this count only ranks severity.
		blocking: rows.filter((r) => r.status === "misconfigured").length,
	};
}

/** goreleaser asset name: ketch_0.18.0_linux_x86_64.tar.gz (x64 → x86_64!). */
export function assetName(version: string, nodePlatform: string, nodeArch: string): string | undefined {
	const goos =
		nodePlatform === "darwin" ? "darwin" : nodePlatform === "linux" ? "linux" : nodePlatform === "win32" ? "windows" : undefined;
	const goarch = nodeArch === "x64" ? "x86_64" : nodeArch === "arm64" ? "arm64" : undefined;
	if (!goos || !goarch) return undefined;
	return `ketch_${version.replace(/^v/, "")}_${goos}_${goarch}${goos === "windows" ? ".zip" : ".tar.gz"}`;
}

/** Parse `<sha256>  <filename>` lines from a release checksums.txt. */
export function parseChecksums(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+?)\s*$/.exec(line);
		if (m) out[m[2]] = m[1].toLowerCase();
	}
	return out;
}

/** Startup abort of any go1.25 binary on a 0/0 cgroup quota. */
export function isProcresize(stderr: string): boolean {
	return stderr.includes("procresize: invalid arg");
}

/**
 * The GOMAXPROCS wrapper. `GOMAXPROCS="${GOMAXPROCS:-$(nproc …)}"` keeps an
 * operator's explicit export winning while defaulting to visible CPUs.
 */
export function wrapperScript(home: string): string {
	return [
		"#!/bin/sh",
		"# ketch-setup: host cgroup reports cpu quota 0/0; Go 1.25 container-aware",
		"# GOMAXPROCS computes 0 procs and aborts (procresize: invalid arg).",
		"# Revert: mv ~/.local/libexec/ketch-bin ~/.local/bin/ketch",
		'export GOMAXPROCS="${GOMAXPROCS:-$(nproc 2>/dev/null || echo 4)}"',
		`exec "${join(home, ".local", "libexec", "ketch-bin")}" "$@"`,
		"",
	].join("\n");
}

/** Spawn env: keep the caller's GOMAXPROCS when set, otherwise pin CPUs. */
export function spawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, GOMAXPROCS: base.GOMAXPROCS || String(Math.max(1, cpus().length)) };
}

/** First `ketch` on PATH (fs probe only — used at session_start). */
export function resolveKetchPath(pathEnv: string | undefined = process.env.PATH, binName: string = BIN_NAME): string | undefined {
	if (!pathEnv) return undefined;
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, binName);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Config merge: corrupt/absent file → defaults, explicit values win. */
export function mergeConfig(raw: unknown): SetupConfig {
	const cfg: SetupConfig = { enabled: true, missingNotified: false };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cfg;
	const r = raw as Record<string, unknown>;
	if (typeof r.enabled === "boolean") cfg.enabled = r.enabled;
	if (typeof r.missingNotified === "boolean") cfg.missingNotified = r.missingNotified;
	return cfg;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * `/ketch` status body — pure so the test pins the rendering: version line,
 * binary, backend/keys, doctor counts + problem rows, contextual hints.
 */
export function buildStatusLines(i: StatusInput): string[] {
	if (!i.binPath) return ["not installed — run /ketch setup"];
	const lines: string[] = [];
	const ver = i.version;
	if (ver) {
		const meta = [str(ver.version), str(ver.commit) ? `(${str(ver.commit)})` : undefined]
			.filter(Boolean)
			.join(" ");
		const env = [str(ver.go), str(ver.os) && str(ver.arch) ? `${str(ver.os)}/${str(ver.arch)}` : undefined]
			.filter(Boolean)
			.join(" ");
		lines.push(env ? `${meta} · ${env}` : meta);
		const upd = ver.update as Record<string, unknown> | undefined;
		if (upd && upd.available === true && typeof upd.latest_version === "string" && upd.latest_version !== str(ver.version)) {
			lines.push(`update available: ${upd.latest_version}`);
		}
	} else {
		lines.push("version: unavailable (ketch version --json failed)");
	}
	lines.push(`binary: ${i.binPath}`);

	const cfg = i.config;
	if (cfg) {
		lines.push(`backend: ${str(cfg.backend) ?? "?"} · config: ${str(cfg.config_path) ?? "?"}`);
		// Presence flags are `*_key_set`, but github ships `github_token_set`.
		const isFlag = (k: string) => k.endsWith("_key_set") || k.endsWith("_token_set");
		const set = Object.entries(cfg)
			.filter(([k, v]) => isFlag(k) && v === true)
			.map(([k]) => k.replace(/_(key|token)_set$/, ""));
		lines.push(set.length > 0 ? `keys set: ${set.join(", ")}` : "keys set: none (keyless auto chain active)");
	}

	const s = i.summary;
	if (s) {
		const exit5 = i.doctorExit === 5;
		lines.push(
			`doctor: ${s.ok}/${s.total} ok · ${s.skipped} skipped · ${s.problems.length} problems` + (exit5 ? " — EXIT 5" : ""),
		);
		for (const p of s.problems) {
			lines.push(`- ${p.surface}/${p.backend}: ${p.status}${p.detail ? ` — ${truncate(p.detail, 90)}` : ""}`);
		}
		const ctx7 = s.problems.find((p) => p.backend === "context7" && p.status === "no_key");
		if (ctx7) lines.push("hint: docs surface needs a free context7 key — /ketch setup");
		if (s.blocking > 0) {
			lines.push('note: "misconfigured" rows are what doctor counts as blocking (exit 5);');
			lines.push("self-hosted backends you do not run can be ignored");
		}
	} else {
		lines.push("doctor: unavailable (ketch doctor --json failed)");
	}
	return lines;
}

/* --------------------------------------------------------------- config */

function configPath(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return join(override || getAgentDir(), CONFIG_FILE_NAME);
}

function loadConfig(): SetupConfig {
	try {
		if (existsSync(configPath())) return mergeConfig(JSON.parse(readFileSync(configPath(), "utf8")));
	} catch {
		// Corrupt config: defaults, never break the session.
	}
	return mergeConfig(undefined);
}

function saveConfig(cfg: SetupConfig): void {
	try {
		writeFileSync(configPath(), `${JSON.stringify(cfg, null, "\t")}\n`, { mode: 0o600 });
	} catch (e) {
		console.warn(`[ketch-setup] could not persist config: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/* ---------------------------------------------------------------- spawn */

/**
 * Run a binary, capture capped stdout/stderr, resolve instead of throw.
 * `rawEnv` skips the GOMAXPROCS injection — reserved for the crash test,
 * where the point is to observe what a bare invocation does.
 */
function run(bin: string, args: string[], opts: { rawEnv?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const finish = (result: RunResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(bin, args, { env: opts.rawEnv ? { ...process.env } : spawnEnv(), stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			finish({ code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e), timedOut: false });
			return;
		}
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const sink =
			(acc: "stdout" | "stderr") =>
			(chunk: Buffer): void => {
				if (acc === "stdout") {
					if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
				} else if (stderr.length < MAX_OUTPUT_BYTES) {
					stderr += chunk.toString("utf8");
				}
			};
		child.stdout?.on("data", sink("stdout"));
		child.stderr?.on("data", sink("stderr"));
		child.on("error", (e) => {
			clearTimeout(timer);
			finish({ code: null, stdout, stderr: e.message, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish({ code, stdout, stderr, timedOut });
		});
	});
}

/** Spawn ketch with a parsed JSON reply, or undefined on any failure. */
async function ketchJson(bin: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown> | undefined> {
	const r = await run(bin, args, { timeoutMs });
	try {
		const parsed: unknown = JSON.parse(r.stdout);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

async function ketchDoctor(bin: string): Promise<{ summary: DoctorSummary; exit: number | null }> {
	const r = await run(bin, ["doctor", "--json"], { timeoutMs: DOCTOR_TIMEOUT_MS });
	let parsed: unknown;
	try {
		parsed = JSON.parse(r.stdout);
	} catch {
		parsed = undefined;
	}
	return { summary: summarizeDoctor(parsed), exit: r.code };
}

function writableDir(dir: string): boolean {
	try {
		accessSync(dir, fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/* ------------------------------------------------------------- install */

/**
 * Verified release install: fetch asset + checksums.txt, SHA-256 compare,
 * untar to a staging dir, copy (cross-fs safe — renameSync would EXDEV from
 * /tmp) into the target with 0755. Returns the installed path or undefined.
 */
async function installRelease(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const asset = assetName(RELEASE_VERSION, process.platform, process.arch);
	if (!asset) {
		ctx.ui.notify(`ketch setup: unsupported platform ${process.platform}/${process.arch} — install from ${RELEASE_BASE}`, "error");
		return undefined;
	}
	if (IS_WINDOWS) {
		// Zip extraction needs PowerShell Expand-Archive; keep the flow honest
		// instead of half-shipping it. Revisit if a Windows machine shows up.
		ctx.ui.notify(`ketch setup: download ${RELEASE_BASE}/${asset} manually (zip), or use the npm channel`, "warning");
		return undefined;
	}
	const targetDir = writableDir("/usr/local/bin") ? "/usr/local/bin" : join(homedir(), ".local", "bin");
	const proceed = await ctx.ui.confirm(
		"ketch setup",
		`Download ${asset}\nfrom ${RELEASE_BASE}\nverify SHA-256 against checksums.txt,\ninstall to ${targetDir}?\n(no shell piping, no Go toolchain)`,
	);
	if (!proceed) return undefined;

	try {
		const [assetRes, sumsRes] = await Promise.all([
			fetch(`${RELEASE_BASE}/${asset}`),
			fetch(`${RELEASE_BASE}/checksums.txt`),
		]);
		if (!assetRes.ok || !sumsRes.ok) {
			ctx.ui.notify(`ketch setup: download failed (HTTP ${assetRes.status}/${sumsRes.status})`, "error");
			return undefined;
		}
		const body = Buffer.from(await assetRes.arrayBuffer());
		const expected = parseChecksums(await sumsRes.text())[asset];
		const actual = createHash("sha256").update(body).digest("hex");
		if (!expected) {
			ctx.ui.notify("ketch setup: checksums.txt lists no entry for this asset — refusing to install", "error");
			return undefined;
		}
		if (actual !== expected) {
			ctx.ui.notify(`ketch setup: SHA-256 mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — refusing`, "error");
			return undefined;
		}

		const tmpFile = join(tmpdir(), asset);
		const stage = join(tmpdir(), `ketch-stage-${Date.now()}`);
		writeFileSync(tmpFile, body);
		mkdirSync(stage, { recursive: true });
		try {
			const untar = await run("tar", ["-xzf", tmpFile, "-C", stage], { timeoutMs: INSTALL_TIMEOUT_MS });
			const staged = join(stage, "ketch");
			if (untar.code !== 0 || !existsSync(staged)) {
				ctx.ui.notify(`ketch setup: extraction failed — ${untar.stderr.trim().slice(0, 200) || "ketch binary missing from archive"}`, "error");
				return undefined;
			}
			mkdirSync(targetDir, { recursive: true });
			const dest = join(targetDir, "ketch");
			writeFileSync(dest, readFileSync(staged), { mode: 0o755 });
			ctx.ui.notify(`ketch setup: installed ${dest} (SHA-256 verified)`, "info");
			return dest;
		} finally {
			rmSync(tmpFile, { force: true });
			rmSync(stage, { recursive: true, force: true });
		}
	} catch (e) {
		ctx.ui.notify(`ketch setup: install failed — ${e instanceof Error ? e.message : String(e)}`, "error");
		return undefined;
	}
}

/**
 * Repair path for the 0/0-cgroup crash: park the real binary at
 * ~/.local/libexec/ketch-bin, put `wrapperScript` at its PATH location.
 * A permission failure (e.g. /usr/local/bin) prints the exact manual fix
 * instead of half-moving files.
 */
function installWrapper(ctx: ExtensionCommandContext, plainBin: string): boolean {
	const libexec = join(homedir(), ".local", "libexec");
	const parked = join(libexec, "ketch-bin");
	if (plainBin === parked) return false;
	try {
		mkdirSync(libexec, { recursive: true });
		renameSync(plainBin, parked);
	} catch (e) {
		ctx.ui.notify(
			`ketch setup: cannot move ${plainBin} (${e instanceof Error ? e.message : String(e)})\nmanual fix:\n  mv ${plainBin} ${parked}\n  (then re-run /ketch setup)`,
			"warning",
		);
		return false;
	}
	try {
		writeFileSync(plainBin, wrapperScript(homedir()), { mode: 0o755 });
	} catch (e) {
		// Never leave PATH without an entry: roll the parked binary back.
		try {
			renameSync(parked, plainBin);
		} catch {
			// restore failed too — the manual hint below covers both files
		}
		ctx.ui.notify(
			`ketch setup: cannot write wrapper at ${plainBin} (${e instanceof Error ? e.message : String(e)})\nrecovery:\n  mv ${parked} ${plainBin}`,
			"warning",
		);
		return false;
	}
	ctx.ui.notify(`ketch setup: GOMAXPROCS wrapper installed at ${plainBin}\n(real binary: ${parked})`, "info");
	return true;
}

/** Curated key menu — other providers stay manual (`ketch config set …`). */
const KEY_CANDIDATES: { key: string; label: string }[] = [
	{ key: "context7", label: "context7 — docs surface (free)" },
	{ key: "brave", label: "brave — web search (free)" },
	{ key: "tavily", label: "tavily — web search (free)" },
];

async function keyEntryLoop(ctx: ExtensionCommandContext, bin: string): Promise<void> {
	let cfg = await ketchJson(bin, ["config"]);
	for (;;) {
		if (!cfg) return;
		const missing = KEY_CANDIDATES.filter((c) => cfg?.[`${c.key}_api_key_set`] === false);
		if (missing.length === 0) return;
		const choice = await ctx.ui.select("ketch API keys (optional — the keyless auto chain already works)", [
			...missing.map((m) => `Set ${m.label}`),
			"Done",
		]);
		if (!choice || choice === "Done") return;
		const pick = missing.find((m) => choice.includes(m.key));
		if (!pick) continue;
		const secret = (await ctx.ui.input(`${pick.key} API key`, "paste the key — stored by ketch, never shown to the model"))?.trim();
		if (!secret) continue;
		const r = await run(bin, ["config", "set", `${pick.key}_api_key`, secret]);
		if (r.code === 0) {
			ctx.ui.notify(`ketch setup: ${pick.key} stored`, "info");
			cfg = await ketchJson(bin, ["config"]); // refresh *_key_set
		} else {
			ctx.ui.notify(`ketch setup: ${pick.key} failed — ${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}`, "error");
		}
	}
}

/* ------------------------------------------------------------ commands */

async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
	const bin = resolveKetchPath();
	if (!bin) {
		ctx.ui.notify("ketch not installed — run /ketch setup", "warning");
		return;
	}
	const [version, config, doctor] = await Promise.all([
		ketchJson(bin, ["version", "--json"]),
		ketchJson(bin, ["config"]),
		ketchDoctor(bin),
	]);
	const lines = buildStatusLines({ binPath: bin, version, config, summary: doctor.summary, doctorExit: doctor.exit });
	const warn = doctor.exit === 5 || doctor.summary.blocking > 0;
	ctx.ui.notify(`ketch\n${lines.join("\n")}`, warn ? "warning" : "info");
}

async function cmdSetup(ctx: ExtensionCommandContext): Promise<void> {
	let bin = resolveKetchPath();

	// 1. Install when missing — propose the exact action, wait for consent.
	if (!bin) {
		const channel = await ctx.ui.select("ketch is not installed — install via", [
			"Download verified release (SHA-256, no Go, recommended)",
			"Homebrew: brew install ketch",
			"npm: npm install -g ketch-cli",
			"Cancel",
		]);
		if (!channel || channel === "Cancel") return;
		if (channel.startsWith("Download")) {
			await installRelease(ctx);
		} else {
			const useBrew = channel.startsWith("Homebrew");
			const cmd = useBrew ? "brew" : "npm";
			const cmdArgs = useBrew ? ["install", "ketch"] : ["install", "-g", "ketch-cli"];
			const label = useBrew ? "brew install ketch" : "npm install -g ketch-cli";
			if (await ctx.ui.confirm("ketch setup", `Run:\n  ${label}`)) {
				const r = await run(cmd, cmdArgs, { timeoutMs: INSTALL_TIMEOUT_MS });
				ctx.ui.notify(
					r.code === 0 ? `ketch setup: ${label} ok` : `ketch setup: ${label} failed (exit ${r.code}) — ${r.stderr.trim().slice(0, 200)}`,
					r.code === 0 ? "info" : "error",
				);
			}
		}
		bin = resolveKetchPath();
		if (!bin) {
			ctx.ui.notify("ketch setup: no ketch on PATH after install — nothing else to configure", "warning");
			return;
		}
	}

	// 2. Raw crash test (no GOMAXPROCS injected) → wrapper repair if needed.
	const raw = await run(bin, ["version"], { rawEnv: true, timeoutMs: DEFAULT_TIMEOUT_MS });
	if (isProcresize(raw.stderr)) {
		const fix = await ctx.ui.confirm(
			"ketch setup — GOMAXPROCS",
			"ketch aborts on this host's cgroup (cpu quota 0/0 → Go 1.25\ncontainer GOMAXPROCS computes 0).\nInstall the ~/.local/bin/ketch wrapper that pins GOMAXPROCS?",
		);
		if (fix && installWrapper(ctx, bin)) bin = resolveKetchPath() ?? bin;
	} else if (raw.code !== 0 && !raw.stderr.includes("procresize")) {
		// Genuine failure unrelated to the cgroup quirk — surface it, keep going.
		ctx.ui.notify(`ketch setup: ketch version failed — ${(raw.stderr || `exit ${raw.code}`).trim().slice(0, 200)}`, "warning");
	}

	// 3. Optional keys (propose → consent → mutate; secrets bypass the model).
	await keyEntryLoop(ctx, bin);

	// 4. Confirm everything resolves — upstream's step 5.
	ctx.ui.notify("ketch setup: running ketch doctor (up to a minute)…", "info");
	const doctor = await ketchDoctor(bin);
	const config = await ketchJson(bin, ["config"]);
	const lines = buildStatusLines({ binPath: bin, config, summary: doctor.summary, doctorExit: doctor.exit });
	ctx.ui.notify(`ketch setup done\n${lines.join("\n")}`, doctor.exit === 5 ? "warning" : "info");

	const cfg = loadConfig();
	cfg.missingNotified = false; // armed again: a future removal may warn once
	saveConfig(cfg);
}

/* ------------------------------------------------------------ wiring */

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ketch", {
		description: "ketch research CLI — /ketch [status|setup]",
		getArgumentCompletions: (prefix: string) => {
			const options = ["status", "setup"];
			const matches = options.filter((o) => o.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
			try {
				if (sub === "setup") await cmdSetup(ctx);
				else if (sub === "status") await cmdStatus(ctx);
				else ctx.ui.notify(`usage: /ketch [status|setup]  (got: "${sub}")`, "warning");
			} catch (e) {
				// A failed command reports; it never breaks the dispatch path.
				ctx.ui.notify(`ketch: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	// Passive presence check: fs-only PATH probe, no spawn, no network.
	// `missingNotified` latches until setup succeeds → one warning per install.
	pi.on("session_start", async (_event, ctx) => {
		try {
			if (process.env[ENV_OFF] === "off") return;
			const cfg = loadConfig();
			if (!cfg.enabled || cfg.missingNotified) return;
			if (resolveKetchPath()) return;
			cfg.missingNotified = true;
			saveConfig(cfg);
			ctx.ui.notify(
				"ketch (research CLI) not installed — run /ketch setup\n(verified release download, no Go toolchain needed)",
				"warning",
			);
		} catch (e) {
			console.warn(`[ketch-setup] session check skipped: ${e instanceof Error ? e.message : String(e)}`);
		}
	});
}
