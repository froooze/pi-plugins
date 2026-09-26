/**
 * pi-upgrade - sync and rebuild the local pi source checkout from inside pi,
 * then update the installed extension packages.
 *
 * Registers `/pi-upgrade` (with `--check`, `--offline`, `--force`,
 * `--no-extensions`, `--no-pins`, `--no-models`), the in-pi counterpart of the
 * `pi-upgrade` shell command.
 * It syncs the fork (default `froooze/pi`) and rebuilds, so the npm-linked `pi`
 * picks up the new build on the next launch. Afterwards it checks for and
 * updates installed extension packages, the in-process equivalent of
 * `pi update --extensions` (updated extensions likewise load on the next
 * launch). Finally it advances the bundled-extension fork pins to their fork
 * branch heads, because `pi update --extensions` only ever installs the exact
 * pinned commit and never discovers newer fork commits, and refreshes the
 * agent's provider model catalogs (the in-process equivalent of
 * `pi update --models`).
 *
 * Implementation notes (ported from DEXBot2/scripts/update.ts):
 * - fetch + count before mutating, so "already up to date" is a clean no-op;
 * - fail-open dependency detection (node_modules / manifest diff / dirty);
 * - a post-build guard (artifact exists, was refreshed, and runs) so a silent
 *   compiler no-op cannot masquerade as a successful upgrade;
 * - `GODEBUG=containermaxprocs=0` for tsgo, whose Go runtime mis-detects CPUs
 *   on hosts with a malformed /sys/fs/cgroup/cpu.max.
 *
 * Checkout resolution (most specific first):
 *   1. `PI_UPGRADE_REPO` environment variable
 *   2. `<agentDir>/pi-upgrade.json`  { "repo": "/abs/path/to/pi" }
 *   3. derived from the running pi install
 *      (`<root>/packages/coding-agent` -> `<root>`; no machine-specific path)
 *
 * Other configuration (environment variables):
 *   PI_UPGRADE_REMOTE           git remote   (default origin)
 *   PI_UPGRADE_BRANCH           git branch   (default main)
 *   PI_UPGRADE_EXPECTED_REMOTE  substring the remote URL should contain
 *                               (default froooze/pi; mismatch only warns)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	getPackageDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUNDLED_FORKS, type PinBump, planPinBumps } from "./shared/bundle-pins.ts";

const REMOTE = process.env.PI_UPGRADE_REMOTE?.trim() || "origin";
const BRANCH = process.env.PI_UPGRADE_BRANCH?.trim() || "main";
const EXPECTED_REMOTE = process.env.PI_UPGRADE_EXPECTED_REMOTE?.trim() || "froooze/pi";
const CONFIG_FILE_NAME = "pi-upgrade.json";

function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

function readConfiguredRepo(): string | undefined {
	const path = configPath();
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const repo = (parsed as { repo?: unknown }).repo;
		return typeof repo === "string" && repo.trim() ? repo.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Locate the pi source checkout, most specific first:
 *   1. `PI_UPGRADE_REPO`
 *   2. `<agentDir>/pi-upgrade.json` `{ "repo": "/abs/path" }`
 *   3. derived from the running pi package dir (`<root>/packages/coding-agent` -> `<root>`)
 *
 * No machine-specific path is baked in: a from-source (npm-linked) pi is
 * self-locating, and anything else opts in via env or config.
 */
export function resolveRepo(): string | undefined {
	const fromEnv = process.env.PI_UPGRADE_REPO?.trim();
	if (fromEnv) return fromEnv;

	const configured = readConfiguredRepo();
	if (configured) return configured;

	const packageDir = getPackageDir();
	const root = dirname(dirname(packageDir));
	if (basename(dirname(packageDir)) === "packages" && existsSync(join(root, ".git"))) {
		return root;
	}
	return undefined;
}

function helpText(repo: string): string {
	return [
		"Usage: /pi-upgrade [--check] [--offline] [--force] [--no-extensions] [--no-pins] [--no-models]",
		"",
		"  --check          report whether the fork, extensions, bundled pins have updates, then exit (read-only)",
		"  --offline        skip the optional network halves (model-data, extensions, pins, models); the pi fetch/pull still runs",
		"  --force          rebuild even if the checkout is already up to date",
		"  --no-extensions  skip the installed-extension check/update",
		"  --no-pins        skip advancing the bundled-extension fork pins",
		"  --no-models      skip refreshing the agent model catalogs",
		"",
		`Repo:   ${repo} (${REMOTE}/${BRANCH})`,
	].join("\n");
}

export interface UpgradeOptions {
	check?: boolean;
	offline?: boolean;
	force?: boolean;
	/** Check and update installed extension packages (default true). */
	extensions?: boolean;
	/** Advance the bundled-extension fork pins to their fork branch heads (default true). */
	pins?: boolean;
	/** Refresh the agent's provider model catalogs (default true). */
	models?: boolean;
	/** Configured npm runner (settings `npmCommand`, argv-style); defaults to `npm`. */
	npmCommand?: string[];
	/** Checkout to sync; resolved outside the pure upgrade routine. */
	repo?: string;
}

export interface UpgradeResult {
	ok: boolean;
	message: string;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

type Logger = (line: string) => void;

/** tsgo's Go runtime cannot read this host's cgroup CPU limit; disable it. */
function withGodebug(value: string | undefined): string {
	if (!value) return "containermaxprocs=0";
	return value.includes("containermaxprocs=") ? value : `containermaxprocs=0,${value}`;
}

function run(
	command: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string>; onLog?: Logger; signal?: AbortSignal } = {},
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, GODEBUG: withGodebug(process.env.GODEBUG), ...(options.env ?? {}) },
			signal: options.signal,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		const forward = (stream: NodeJS.ReadableStream | null, sink: "out" | "err"): void => {
			if (!stream) return;
			let pending = "";
			stream.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				if (sink === "out") stdout += text;
				else stderr += text;
				if (!options.onLog) return;
				pending += text;
				const parts = pending.split(/\r?\n/);
				pending = parts.pop() ?? "";
				for (const line of parts) {
					if (line.trim()) options.onLog(line);
				}
			});
		};
		forward(child.stdout, "out");
		forward(child.stderr, "err");

		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
	});
}

function lastLines(result: RunResult, count = 8): string {
	const text = `${result.stdout}\n${result.stderr}`.trim();
	const lines = text.split(/\r?\n/).filter((line) => line.trim());
	return lines.slice(-count).join("\n");
}

export function parseOptions(input: string): UpgradeOptions & { help?: boolean } {
	const options: UpgradeOptions & { help?: boolean } = {};
	for (const token of input.trim().split(/\s+/).filter(Boolean)) {
		switch (token) {
			case "--check":
				options.check = true;
				break;
			case "--offline":
				options.offline = true;
				break;
			case "--force":
				options.force = true;
				break;
			case "--extensions":
				options.extensions = true;
				break;
			case "--no-extensions":
				options.extensions = false;
				break;
			case "--no-pins":
				options.pins = false;
				break;
			case "--no-models":
				options.models = false;
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				throw new Error(`unknown option: ${token}`);
		}
	}
	return options;
}

/**
 * Split a configured `npmCommand` (settings `npmCommand`, argv-style, e.g.
 * `["mise", "exec", "node@20", "--", "npm"]`) into the binary plus leading
 * args. Falls back to plain `npm` when unset, empty, or malformed.
 */
export function npmInvocation(configured: string[] | undefined): { command: string; args: string[] } {
	if (!configured || configured.length === 0 || !configured[0]?.trim()) {
		return { command: "npm", args: [] };
	}
	const [command, ...args] = configured;
	return { command, args };
}

/**
 * Sync + rebuild the checkout. Pure of pi APIs: only node built-ins and the
 * git/npm CLIs, so it can be exercised from a plain Node script.
 */
export async function runPiUpgrade(options: UpgradeOptions, log: Logger = () => {}): Promise<UpgradeResult> {
	const repo = options.repo?.trim();
	if (!repo) {
		return {
			ok: false,
			message: `No pi source checkout configured. Set PI_UPGRADE_REPO or write ${configPath()} with {"repo": "/path/to/pi"}.`,
		};
	}
	if (!existsSync(join(repo, ".git"))) {
		return { ok: false, message: `${repo} is not a git checkout (no .git found).` };
	}
	const bundle = join(repo, "packages", "coding-agent", "dist", "bundle", "cli.js");

	// Only stream the long-running steps; git plumbing would flood the widget.
	const exec = (command: string, args: string[], stream = false): Promise<RunResult> =>
		run(command, args, stream ? { cwd: repo, onLog: log } : { cwd: repo });

	// Honor the package manager's configured npm runner (settings `npmCommand`),
	// so /pi-upgrade and `pi update --extensions` install with the same toolchain.
	const npm = npmInvocation(options.npmCommand);
	const npmExec = (args: string[], stream = false): Promise<RunResult> =>
		exec(npm.command, [...npm.args, ...args], stream);

	// Discard npm's harmless `"peer": true` lockfile rewrite so it cannot block
	// the pull. Other local edits are intentionally left alone.
	const lockDirty = await exec("git", ["diff", "--quiet", "--", "package-lock.json"]);
	if (lockDirty.code === 1) {
		log("restoring npm-generated package-lock.json churn");
		await exec("git", ["checkout", "--", "package-lock.json"]);
	}

	const remote = await exec("git", ["remote", "get-url", REMOTE]);
	if (remote.code !== 0) {
		return { ok: false, message: `remote '${REMOTE}' is not configured in ${repo}.` };
	}
	const remoteUrl = remote.stdout.trim();
	if (!remoteUrl.includes(EXPECTED_REMOTE)) {
		log(`warning: ${REMOTE} is '${remoteUrl}' (expected to contain '${EXPECTED_REMOTE}')`);
	}

	log(`git fetch ${REMOTE} ${BRANCH}`);
	const fetch = await exec("git", ["fetch", "--quiet", REMOTE, BRANCH]);
	if (fetch.code !== 0) {
		return { ok: false, message: `git fetch failed:\n${lastLines(fetch)}` };
	}

	const upstream = `${REMOTE}/${BRANCH}`;
	const count = async (range: string): Promise<number> => {
		const result = await exec("git", ["rev-list", "--count", range]);
		return Number.parseInt(result.stdout.trim(), 10) || 0;
	};
	const incoming = await count(`HEAD..${upstream}`);
	const outgoing = await count(`${upstream}..HEAD`);
	const head = (await exec("git", ["log", "--oneline", "-1"])).stdout.trim();

	if (options.check) {
		const upstreamHead = (await exec("git", ["log", "--oneline", "-1", upstream])).stdout.trim();
		const lines = [
			`local:    ${head}`,
			`upstream: ${upstreamHead}`,
			`behind:   ${incoming} commit(s)`,
			`ahead:    ${outgoing} local commit(s)`,
		];
		if (incoming > 0) {
			const diff = await exec("git", ["--no-pager", "log", "--oneline", "--graph", "--decorate", `HEAD..${upstream}`]);
			lines.push("", diff.stdout.trim(), "", "Run /pi-upgrade to sync.");
		} else {
			lines.push("", "up to date.");
		}
		return { ok: true, message: lines.join("\n") };
	}

	const dirty = (await exec("git", ["status", "--porcelain"])).stdout.trim().length > 0;
	if (incoming === 0 && !options.force && !dirty && existsSync(bundle)) {
		const ahead = outgoing > 0 ? ` (${outgoing} local commit(s) ahead)` : "";
		return { ok: true, message: `pi is already up to date: ${head}${ahead}` };
	}

	const before = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
	if (incoming > 0) {
		log(`${incoming} update(s) available`);
		const diff = await exec("git", ["--no-pager", "log", "--oneline", "--graph", "--decorate", `HEAD..${upstream}`]);
		for (const line of diff.stdout.trim().split("\n")) log(line);
	}
	if (outgoing > 0 && incoming > 0) {
		log(`warning: local branch is ${outgoing} ahead and ${incoming} behind; git pull --ff-only may refuse`);
	}

	log(`git pull --ff-only ${REMOTE} ${BRANCH}`);
	const pull = await exec("git", ["pull", "--ff-only", REMOTE, BRANCH]);
	if (pull.code !== 0) {
		return { ok: false, message: `git pull failed:\n${lastLines(pull)}` };
	}

	// Fail-open dependency check: install when node_modules is missing or
	// incomplete, when the manifest changed across the pull, or when it is dirty.
	const depsNeeded = async (): Promise<boolean> => {
		if (!existsSync(join(repo, "node_modules", ".package-lock.json"))) return true;
		const changed = await exec("git", ["diff", "--name-only", before, "HEAD", "--", "package.json", "package-lock.json"]);
		if (changed.code !== 0 || changed.stdout.trim()) return true;
		const manifestDirty = await exec("git", ["status", "--porcelain", "--", "package.json", "package-lock.json"]);
		if (manifestDirty.code !== 0 || manifestDirty.stdout.trim()) return true;
		return false;
	};

	if (await depsNeeded()) {
		log("npm ci --ignore-scripts --prefer-offline");
		const ci = await npmExec(["ci", "--ignore-scripts", "--prefer-offline"], true);
		if (ci.code !== 0) {
			return { ok: false, message: `npm ci failed:\n${lastLines(ci)}` };
		}
	} else {
		log("dependencies unchanged, skipping npm ci");
	}

	if (!options.offline) {
		log("npm run hydrate:model-data");
		const hydrate = await npmExec(["run", "hydrate:model-data"], true);
		if (hydrate.code !== 0) {
			return { ok: false, message: `model-data refresh failed:\n${lastLines(hydrate)}` };
		}
	}

	const buildStart = Date.now();
	log("npm run build:offline");
	const build = await npmExec(["run", "build:offline"], true);
	if (build.code !== 0) {
		return { ok: false, message: `build failed:\n${lastLines(build)}` };
	}

	// Post-build guard: the artifact must exist, have been refreshed, and run.
	if (!existsSync(bundle)) {
		return { ok: false, message: `build did not produce ${bundle}.` };
	}
	if (statSync(bundle).mtimeMs < buildStart - 2000) {
		return { ok: false, message: `${bundle} was not refreshed by the build (tsgo may have no-op'd).` };
	}
	const version = await run(process.execPath, [bundle, "--version"], { cwd: repo });
	if (version.code !== 0) {
		return { ok: false, message: `${bundle} exists but does not run.` };
	}

	const newHead = (await exec("git", ["log", "--oneline", "-1"])).stdout.trim();
	return { ok: true, message: `pi upgraded to ${version.stdout.trim().split("\n")[0]} (${newHead}).` };
}

function createPackageManager(cwd: string, agentDir: string, projectTrusted: boolean): DefaultPackageManager {
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

/** The npm runner pi's package manager resolves (settings `npmCommand`, else `npm`). */
function configuredNpmCommand(ctx: ExtensionCommandContext): string[] | undefined {
	try {
		const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
		return settingsManager.getNpmCommand();
	} catch {
		return undefined;
	}
}

/** Read-only: installed extension packages that have a newer revision available. */
export async function checkExtensionUpdates(
	cwd: string,
	agentDir: string,
	projectTrusted = false,
): Promise<string[]> {
	const updates = await createPackageManager(cwd, agentDir, projectTrusted).checkForAvailableUpdates();
	return updates.map((update) => update.displayName);
}

/**
 * Update installed extension packages (the in-process equivalent of
 * `pi update --extensions`). Returns the display names that were updated.
 */
export async function updateExtensions(
	cwd: string,
	agentDir: string,
	projectTrusted: boolean,
	log: Logger = () => {},
): Promise<string[]> {
	const available = await checkExtensionUpdates(cwd, agentDir, projectTrusted);
	if (available.length === 0) {
		log("extensions are up to date");
		return [];
	}

	log(`updating ${available.length} extension package(s): ${available.join(", ")}`);
	const manager = createPackageManager(cwd, agentDir, projectTrusted);
	manager.setProgressCallback((event) => {
		if (event.type === "start" && event.message) log(event.message);
	});
	await manager.update();
	return available;
}

/** The installed package directory (this extension lives in `<root>/extensions`). */
function packageRoot(): string {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readDependencies(packageDir: string): Record<string, string> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		return parsed.dependencies;
	} catch {
		return undefined;
	}
}

/** Resolve a fork branch head, or undefined when git/network fails. */
async function resolveRemoteHead(repo: string, branch: string): Promise<string | undefined> {
	try {
		const result = await run("git", ["ls-remote", repo, branch]);
		if (result.code !== 0) return undefined;
		const match = result.stdout.match(/^([0-9a-f]{40})\s+/m);
		return match?.[1];
	} catch {
		return undefined;
	}
}

/** Read-only: bundled forks whose configured pin lags the fork branch head. */
export async function checkBundledPins(packageDir: string): Promise<PinBump[]> {
	const dependencies = readDependencies(packageDir);
	if (!dependencies) return [];

	const remoteHeads: Record<string, string | undefined> = {};
	await Promise.all(
		BUNDLED_FORKS.map(async (fork) => {
			if (!dependencies[fork.name]) return;
			remoteHeads[fork.name] = await resolveRemoteHead(fork.repo, fork.branch);
		}),
	);
	return planPinBumps(dependencies, remoteHeads);
}

/** Keep the installed version's `allowScripts` entry in sync; best-effort, never fatal. */
function syncAllowScripts(packageDir: string, name: string): void {
	try {
		const installed = JSON.parse(readFileSync(join(packageDir, "node_modules", name, "package.json"), "utf8")) as {
			version?: string;
		};
		if (typeof installed.version !== "string") return;

		const packagePath = join(packageDir, "package.json");
		const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { allowScripts?: Record<string, unknown> };
		const allow = pkg.allowScripts && typeof pkg.allowScripts === "object" ? pkg.allowScripts : {};
		for (const key of Object.keys(allow)) {
			if (key === name || key.startsWith(`${name}@`)) delete allow[key];
		}
		allow[`${name}@${installed.version}`] = true;
		pkg.allowScripts = allow;
		writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
	} catch {
		// allowScripts sync is cosmetic; the package is already installed.
	}
}

/**
 * Advance the bundled-extension fork pins to their fork branch heads and
 * reinstall them. The repo pins are the source of truth for other machines;
 * this keeps the running install from lagging until a maintainer pushes a bump.
 * Fail-open per fork: a failed fork is logged and skipped.
 */
export async function updateBundledPins(
	packageDir: string,
	log: Logger = () => {},
	npmCommand?: string[],
): Promise<string[]> {
	const npm = npmInvocation(npmCommand);
	const bumps = await checkBundledPins(packageDir);
	if (bumps.length === 0) {
		log("bundled forks are at their latest commits");
		return [];
	}

	const updated: string[] = [];
	for (const bump of bumps) {
		log(`bundled fork ${bump.name}: ${bump.from.slice(0, 7)} -> ${bump.to.slice(0, 7)}`);
		const install = await run(npm.command, [...npm.args, "install", bump.url], { cwd: packageDir, onLog: log });
		if (install.code !== 0) {
			log(`warning: failed to update ${bump.name}:\n${lastLines(install)}`);
			continue;
		}
		syncAllowScripts(packageDir, bump.name);
		updated.push(bump.name);
	}
	return updated;
}

/**
 * Fold the extension check/update into the pi result, so `/pi-upgrade` reports
 * (and, unless `--no-extensions`, applies) both halves in one run.
 */
async function withExtensions(
	piResult: UpgradeResult,
	options: UpgradeOptions,
	ctx: ExtensionCommandContext,
	log: Logger,
): Promise<UpgradeResult> {
	const cwd = ctx.cwd;
	const agentDir = getAgentDir();
	const projectTrusted = ctx.isProjectTrusted();

	try {
		if (options.check) {
			if (options.offline) {
				return { ...piResult, message: `${piResult.message}\n\nextensions: skipped (offline)` };
			}
			const available = await checkExtensionUpdates(cwd, agentDir, projectTrusted);
			const section = available.length
				? ["", "Extensions with updates:", ...available.map((name) => `  - ${name}`), "", "Run /pi-upgrade to update."]
				: ["", "extensions are up to date."];
			return { ...piResult, message: `${piResult.message}\n${section.join("\n")}` };
		}

		if (options.offline) {
			log("extensions: skipped (offline)");
			return piResult;
		}

		const updated = await updateExtensions(cwd, agentDir, projectTrusted, log);
		const note = updated.length ? `Updated extensions: ${updated.join(", ")}.` : "Extensions already up to date.";
		return { ok: piResult.ok, message: `${piResult.message}\n${note}` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`extension update failed: ${message}`);
		return { ok: false, message: `${piResult.message}\n\nextension check/update failed: ${message}` };
	}
}

/**
 * Fold the bundled-fork pin check/bump into the result. `pi update --extensions`
 * installs only the pinned commit, so this is what actually advances the
 * bundled forks on this machine; pushing a bumped pin is a separate maintainer
 * step handled by the repo (README + `test/pins.test.ts`).
 */
async function withPins(piResult: UpgradeResult, options: UpgradeOptions, log: Logger): Promise<UpgradeResult> {
	try {
		if (options.offline) {
			log("bundled forks: skipped (offline)");
			return piResult;
		}

		if (options.check) {
			const bumps = await checkBundledPins(packageRoot());
			const section = bumps.length
				? [
						"",
						"Bundled forks with updates:",
						...bumps.map((bump) => `  - ${bump.name}: ${bump.from.slice(0, 7)} -> ${bump.to.slice(0, 7)}`),
					]
				: ["", "bundled forks are up to date."];
			return { ...piResult, message: `${piResult.message}\n${section.join("\n")}` };
		}

		const updated = await updateBundledPins(packageRoot(), log, options.npmCommand);
		const note = updated.length
			? `Updated bundled forks: ${updated.join(", ")} (reload to load them).`
			: "Bundled forks already up to date.";
		return { ok: piResult.ok, message: `${piResult.message}\n${note}` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`bundled-fork update failed: ${message}`);
		return { ...piResult, message: `${piResult.message}\n\nbundled-fork update failed: ${message}` };
	}
}

/**
 * Refresh the agent's provider model catalogs (the in-process equivalent of
 * `pi update --models`). Fail-open: errors are reported, never thrown.
 */
async function withModels(
	piResult: UpgradeResult,
	options: UpgradeOptions,
	ctx: ExtensionCommandContext,
	log: Logger,
): Promise<UpgradeResult> {
	if (options.offline) {
		log("model catalogs: skipped (offline)");
		return piResult;
	}
	if (options.check) {
		return {
			...piResult,
			message: `${piResult.message}\n\nmodel catalogs refresh on /pi-upgrade (not checked).`,
		};
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
	try {
		log("refreshing model catalogs");
		const result = await ctx.modelRegistry.refresh({ allowNetwork: true, force: true, signal });
		if (result.aborted) {
			log("model catalog refresh timed out");
			return { ...piResult, message: `${piResult.message}\n\nmodel catalog refresh timed out.` };
		}
		if (result.errors.size > 0) {
			const details = [...result.errors]
				.map(([provider, error]) => `${provider}: ${error.message}`)
				.join("; ");
			log(`model catalog refresh had errors: ${details}`);
			return { ...piResult, message: `${piResult.message}\n\nmodel catalog refresh had errors: ${details}` };
		}
		return { ...piResult, message: `${piResult.message}\nModel catalogs refreshed.` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`model catalog refresh failed: ${message}`);
		return { ...piResult, message: `${piResult.message}\n\nmodel catalog refresh failed: ${message}` };
	} finally {
		clearTimeout(timeout);
	}
}

export default function piUpgrade(pi: ExtensionAPI): void {
	pi.registerCommand("pi-upgrade", {
		description: "Sync and rebuild the local pi source checkout (froooze/pi), update extensions, advance bundled-fork pins, and refresh model catalogs",
		getArgumentCompletions: (prefix: string) => {
			const options = ["--check", "--offline", "--force", "--no-extensions", "--no-pins", "--no-models", "--help"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			let options: UpgradeOptions & { help?: boolean };
			try {
				options = parseOptions(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			if (options.help) {
				ctx.ui.notify(helpText(resolveRepo() ?? `<unresolved: set PI_UPGRADE_REPO or ${configPath()}>`), "info");
				return;
			}

			const repo = resolveRepo();
			options.npmCommand = configuredNpmCommand(ctx);

			const logs: string[] = [];
			const log: Logger = (line) => {
				if (!line) return;
				logs.push(line);
				if (logs.length > 500) logs.splice(0, logs.length - 500);
				if (ctx.hasUI) ctx.ui.setWidget("pi-upgrade", logs.slice(-10), { placement: "aboveEditor" });
			};

			if (ctx.hasUI) ctx.ui.setStatus("pi-upgrade", "running");
			let result: UpgradeResult;
			try {
				if (repo) {
					result = await runPiUpgrade({ ...options, repo }, log);
				} else {
					// The pi checkout is optional: extensions, bundled pins, and model
					// catalogs still update on a machine without a source checkout.
					const message = `No pi source checkout found (set PI_UPGRADE_REPO or ${configPath()}); pi sync/rebuild skipped.`;
					log(message);
					result = { ok: true, message };
				}
				if (options.extensions !== false) {
					result = await withExtensions(result, options, ctx, log);
				}
				if (options.pins !== false) {
					result = await withPins(result, options, log);
				}
				if (options.models !== false) {
					result = await withModels(result, options, ctx, log);
				}
			} catch (error) {
				result = { ok: false, message: error instanceof Error ? error.message : String(error) };
			} finally {
				if (ctx.hasUI) {
					ctx.ui.setWidget("pi-upgrade", undefined);
					ctx.ui.setStatus("pi-upgrade", undefined);
				}
			}

			if (result.ok) {
				ctx.ui.notify(result.message, "info");
			} else {
				const tail = logs.slice(-6).join("\n");
				ctx.ui.notify(tail ? `${result.message}\n\n${tail}` : result.message, "error");
			}
		},
	});
}
