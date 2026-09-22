/**
 * pi-upgrade - sync and rebuild the local pi source checkout from inside pi,
 * then update the installed extension packages.
 *
 * Registers `/pi-upgrade` (with `--check`, `--offline`, `--force`,
 * `--no-extensions`), the in-pi counterpart of the `pi-upgrade` shell command.
 * It syncs the fork (default `froooze/pi`) and rebuilds, so the npm-linked `pi`
 * picks up the new build on the next launch. Afterwards it checks for and
 * updates installed extension packages, the in-process equivalent of
 * `pi update --extensions` (updated extensions likewise load on the next
 * launch).
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
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	DefaultPackageManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	getPackageDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

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
		"Usage: /pi-upgrade [--check] [--offline] [--force] [--no-extensions]",
		"",
		"  --check          report whether the fork and extensions have updates, then exit (read-only)",
		"  --offline        skip the network model-data refresh and extension update",
		"  --force          rebuild even if the checkout is already up to date",
		"  --no-extensions  skip the installed-extension check/update",
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
		const ci = await exec("npm", ["ci", "--ignore-scripts", "--prefer-offline"], true);
		if (ci.code !== 0) {
			return { ok: false, message: `npm ci failed:\n${lastLines(ci)}` };
		}
	} else {
		log("dependencies unchanged, skipping npm ci");
	}

	if (!options.offline) {
		log("npm run hydrate:model-data");
		const hydrate = await exec("npm", ["run", "hydrate:model-data"], true);
		if (hydrate.code !== 0) {
			return { ok: false, message: `model-data refresh failed:\n${lastLines(hydrate)}` };
		}
	}

	const buildStart = Date.now();
	log("npm run build:offline");
	const build = await exec("npm", ["run", "build:offline"], true);
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

export default function piUpgrade(pi: ExtensionAPI): void {
	pi.registerCommand("pi-upgrade", {
		description: "Sync and rebuild the local pi source checkout (froooze/pi), then update extensions",
		getArgumentCompletions: (prefix: string) => {
			const options = ["--check", "--offline", "--force", "--no-extensions", "--help"];
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
			if (!repo) {
				ctx.ui.notify(
					[
						"No pi source checkout found.",
						`Set PI_UPGRADE_REPO, or create ${configPath()} with {"repo": "/path/to/pi"}.`,
					].join("\n"),
					"error",
				);
				return;
			}

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
				result = await runPiUpgrade({ ...options, repo }, log);
				if (options.extensions !== false) {
					result = await withExtensions(result, options, ctx, log);
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
