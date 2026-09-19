#!/usr/bin/env node
/**
 * fork-split — build (and optionally push) a flattened `*-only` branch for one package
 * of an upstream monorepo, matching the branches in `froooze/rpiv-mono`.
 *
 * Each `*-only` branch is the output of `git subtree split -P <package>`: the package
 * lives at the repo root with its subtree-filtered commit history (only commits that
 * touched the package). npm cannot install an archive tarball from a subdirectory, so
 * one branch per package is required.
 *
 * Usage:
 *   node scripts/fork-split.mjs --package packages/rpiv-todo --branch rpiv-todo-only \
 *     [--ref main] [--upstream <git-url>] [--fork <git-url>] [--workdir <dir>] [--dry-run]
 *
 * Prints the split commit SHA, the pinnable archive tarball URL, and the README ref.
 * With `--dry-run` it builds the split locally and reports the push decision without pushing.
 *
 * This script is a convenience only; it is not run by tests or by Pi.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULTS = {
	upstream: "git@github.com:juicesharp/rpiv-mono.git",
	fork: "git@github.com:froooze/rpiv-mono.git",
	ref: "main",
};

function usage(message) {
	if (message) console.error(`error: ${message}\n`);
	console.error(
		[
			"usage: node scripts/fork-split.mjs --package <prefix> --branch <name> [options]",
			"",
			"options:",
			"  --package <prefix>   upstream subtree, e.g. packages/rpiv-todo   (required)",
			"  --branch <name>      target fork branch, e.g. rpiv-todo-only     (required)",
			"  --ref <ref>          upstream ref to split (default: main)",
			"  --upstream <url>     upstream repo url (default: juicesharp/rpiv-mono)",
			"  --fork <url>         fork repo url to push to (default: froooze/rpiv-mono)",
			"  --workdir <dir>      reuse a clone instead of a throwaway temp dir",
			"  --dry-run            build + report, do not push",
		].join("\n"),
	);
	process.exit(2);
}

function parseArgs(argv) {
	const opts = { ...DEFAULTS, dryRun: false, package: undefined, branch: undefined, workdir: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) usage(`missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case "--package": opts.package = next(); break;
			case "--branch": opts.branch = next(); break;
			case "--ref": opts.ref = next(); break;
			case "--upstream": opts.upstream = next(); break;
			case "--fork": opts.fork = next(); break;
			case "--workdir": opts.workdir = next(); break;
			case "--dry-run": opts.dryRun = true; break;
			case "-h":
			case "--help": usage(); break;
			default: usage(`unknown argument: ${arg}`);
		}
	}
	if (!opts.package) usage("--package is required");
	if (!opts.branch) usage("--branch is required");
	return opts;
}

function git(cwd, args, { allowFail = false } = {}) {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (err) {
		if (allowFail) return undefined;
		const stderr = err.stderr?.toString().trim() || err.message;
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
}

/** owner/repo from an SSH (`git@host:owner/repo.git`) or HTTPS (`https://host/owner/repo.git`) url. */
function ownerRepo(url) {
	const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
	if (!match) throw new Error(`cannot parse owner/repo from url: ${url}`);
	return { owner: match[1], repo: match[2] };
}

/** Ensure `workdir` is a full clone of `upstream` with `ref` resolved, then detach at it.
 *  `ref` may be a branch, tag, or (full or locally-present abbreviated) commit SHA.
 *  Returns the resolved upstream commit SHA. */
function prepareClone(workdir, upstream, ref) {
	if (!existsSync(join(workdir, ".git"))) {
		console.error(`cloning ${upstream} ...`);
		execFileSync("git", ["clone", "--quiet", upstream, workdir], { stdio: ["ignore", "inherit", "inherit"] });
	}
	let sha;
	try {
		git(workdir, ["fetch", "--quiet", "--no-tags", upstream, ref]);
		sha = git(workdir, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
	} catch {
		// Fetch needs a branch/tag or a full commit SHA; fall back to a SHA already in history.
		sha = git(workdir, ["rev-parse", "--verify", `${ref}^{commit}`], { allowFail: true });
	}
	if (!sha) throw new Error(`cannot resolve upstream ref ${ref} (use a branch, tag, or full commit SHA)`);
	// `git subtree split` needs the subtree present in the checked-out tree, so detach at it.
	git(workdir, ["checkout", "--quiet", "--detach", sha]);
	return sha;
}

const opts = parseArgs(process.argv.slice(2));
const throwaway = !opts.workdir;
const workdir = opts.workdir ?? mkdtempSync(join(tmpdir(), "fork-split-"));
const splitRef = `refs/fork-split/${opts.branch}`;
let exitCode = 0;

try {
	const upstreamSha = prepareClone(workdir, opts.upstream, opts.ref);
	git(workdir, ["branch", "-D", opts.branch], { allowFail: true });
	console.error(`splitting ${opts.package} @ ${upstreamSha.slice(0, 7)} ...`);
	execFileSync("git", ["subtree", "split", "-P", opts.package, "--branch", opts.branch], {
		cwd: workdir,
		stdio: ["ignore", "ignore", "pipe"],
	});
	const commit = git(workdir, ["rev-parse", opts.branch]);
	const { owner, repo } = ownerRepo(opts.fork);
	const tarball = `https://github.com/${owner}/${repo}/archive/${commit}.tar.gz`;

	// Fetch the current remote branch (if any) to decide fast-forward vs force.
	git(workdir, ["fetch", "--quiet", "--no-tags", opts.fork, `${opts.branch}:${splitRef}`], { allowFail: true });
	const remoteSha = git(workdir, ["rev-parse", splitRef], { allowFail: true });

	let decision = "new branch";
	if (remoteSha === commit) {
		decision = "up to date";
	} else if (remoteSha) {
		const fastForward =
			git(workdir, ["merge-base", "--is-ancestor", remoteSha, opts.branch], { allowFail: true }) !== undefined;
		decision = fastForward ? "fast-forward" : "force (unrelated history)";
	}

	if (opts.dryRun) {
		if (remoteSha) git(workdir, ["update-ref", "-d", splitRef], { allowFail: true });
	} else if (decision !== "up to date") {
		const pushArgs = ["push", opts.fork, `${opts.branch}:${opts.branch}`];
		if (decision.startsWith("force")) pushArgs.splice(1, 0, `--force-with-lease=${opts.branch}:${remoteSha}`);
		execFileSync("git", pushArgs, { cwd: workdir, stdio: ["ignore", "inherit", "inherit"] });
	}

	console.log("");
	console.log(`split:    ${opts.package} @ ${upstreamSha.slice(0, 7)} -> ${opts.branch}`);
	console.log(`commit:   ${commit}`);
	console.log(`tarball:  ${tarball}`);
	console.log(`readme:   ${owner}/${repo}#${commit.slice(0, 7)}`);
	console.log(
		`push:     ${
			opts.dryRun
				? `${decision} (dry-run, not pushed)`
				: decision === "up to date"
					? "up to date, nothing pushed"
					: `${decision}, pushed`
		}`,
	);
} catch (err) {
	console.error(`\nerror: ${err.message}`);
	exitCode = 1;
} finally {
	if (existsSync(join(workdir, ".git"))) git(workdir, ["update-ref", "-d", splitRef], { allowFail: true });
	if (throwaway) rmSync(workdir, { recursive: true, force: true });
}

process.exitCode = exitCode;
