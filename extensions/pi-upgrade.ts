/**
 * pi-upgrade - sync and rebuild the local pi source checkout from inside pi.
 *
 * Registers `/pi-upgrade` (with `--check`, `--offline`, `--force`), the
 * in-pi counterpart of the `pi-upgrade` shell command. It syncs the fork
 * (default `froooze/pi`) and rebuilds, so the npm-linked `pi` picks up the new
 * build on the next launch.
 *
 * Implementation notes (ported from DEXBot2/scripts/update.ts):
 * - fetch + count before mutating, so "already up to date" is a clean no-op;
 * - fail-open dependency detection (node_modules / manifest diff / dirty);
 * - a post-build guard (artifact exists, was refreshed, and runs) so a silent
 *   compiler no-op cannot masquerade as a successful upgrade;
 * - `GODEBUG=containermaxprocs=0` for tsgo, whose Go runtime mis-detects CPUs
 *   on hosts with a malformed /sys/fs/cgroup/cpu.max.
 *
 * Configuration (all optional environment variables):
 *   PI_UPGRADE_REPO             checkout to sync (default ~/BTS/Git/pi)
 *   PI_UPGRADE_REMOTE           git remote   (default origin)
 *   PI_UPGRADE_BRANCH           git branch   (default main)
 *   PI_UPGRADE_EXPECTED_REMOTE  substring the remote URL should contain
 *                               (default froooze/pi; mismatch only warns)
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const REPO = process.env.PI_UPGRADE_REPO?.trim() || join(homedir(), "BTS", "Git", "pi");
const REMOTE = process.env.PI_UPGRADE_REMOTE?.trim() || "origin";
const BRANCH = process.env.PI_UPGRADE_BRANCH?.trim() || "main";
const EXPECTED_REMOTE = process.env.PI_UPGRADE_EXPECTED_REMOTE?.trim() || "froooze/pi";
const BUNDLE = join(REPO, "packages", "coding-agent", "dist", "bundle", "cli.js");

const HELP = [
	"Usage: /pi-upgrade [--check] [--offline] [--force]",
	"",
	"  --check    report whether the fork has new commits, then exit (read-only)",
	"  --offline  skip the network model-data refresh",
	"  --force    rebuild even if the checkout is already up to date",
	"",
	`Repo:   ${REPO} (${REMOTE}/${BRANCH})`,
].join("\n");

export interface UpgradeOptions {
	check?: boolean;
	offline?: boolean;
	force?: boolean;
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
			cwd: options.cwd ?? REPO,
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

function parseOptions(input: string): UpgradeOptions & { help?: boolean } {
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
	if (!existsSync(join(REPO, ".git"))) {
		return { ok: false, message: `${REPO} is not a git checkout (no .git found).` };
	}

	// Only stream the long-running steps; git plumbing would flood the widget.
	const exec = (command: string, args: string[], stream = false): Promise<RunResult> =>
		run(command, args, stream ? { onLog: log } : {});

	// Discard npm's harmless `"peer": true` lockfile rewrite so it cannot block
	// the pull. Other local edits are intentionally left alone.
	const lockDirty = await exec("git", ["diff", "--quiet", "--", "package-lock.json"]);
	if (lockDirty.code === 1) {
		log("restoring npm-generated package-lock.json churn");
		await exec("git", ["checkout", "--", "package-lock.json"]);
	}

	const remote = await exec("git", ["remote", "get-url", REMOTE]);
	if (remote.code !== 0) {
		return { ok: false, message: `remote '${REMOTE}' is not configured in ${REPO}.` };
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
	if (incoming === 0 && !options.force && !dirty && existsSync(BUNDLE)) {
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
		if (!existsSync(join(REPO, "node_modules", ".package-lock.json"))) return true;
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
	if (!existsSync(BUNDLE)) {
		return { ok: false, message: `build did not produce ${BUNDLE}.` };
	}
	if (statSync(BUNDLE).mtimeMs < buildStart - 2000) {
		return { ok: false, message: `${BUNDLE} was not refreshed by the build (tsgo may have no-op'd).` };
	}
	const version = await run(process.execPath, [BUNDLE, "--version"]);
	if (version.code !== 0) {
		return { ok: false, message: `${BUNDLE} exists but does not run.` };
	}

	const newHead = (await exec("git", ["log", "--oneline", "-1"])).stdout.trim();
	return { ok: true, message: `pi upgraded to ${version.stdout.trim().split("\n")[0]} (${newHead}).` };
}

export default function piUpgrade(pi: ExtensionAPI): void {
	pi.registerCommand("pi-upgrade", {
		description: "Sync and rebuild the local pi source checkout (froooze/pi)",
		getArgumentCompletions: (prefix: string) => {
			const options = ["--check", "--offline", "--force", "--help"];
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
				ctx.ui.notify(HELP, "info");
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
				result = await runPiUpgrade(options, log);
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
