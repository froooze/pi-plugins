/**
 * Pure logic for the bundled-extension fork pins.
 *
 * The three bundled extensions ship as exact-commit GitHub archive tarballs in
 * `package.json` (see AGENTS.md). `pi update --extensions` installs exactly the
 * pinned commit and never discovers newer fork commits, so a pinned fork that
 * moved on stays stale until its pin is advanced.
 *
 * This module knows which fork branch each pin tracks and turns
 * `(pinned spec, remote branch head)` into a bump plan. The IO half
 * (`updateBundledPins` in `pi-upgrade.ts`) resolves the remote heads and runs
 * npm.
 *
 * NOTE: lives in a subdirectory without an `index.ts`, so pi's extension
 * discovery does not load it as an extension.
 */

export interface BundledFork {
	/** Dependency name as it appears in `package.json#dependencies`. */
	name: string;
	/** Fork repository, no trailing `.git`. */
	repo: string;
	/** Branch whose head is the latest good commit for this package. */
	branch: string;
}

export const BUNDLED_FORKS: readonly BundledFork[] = [
	{ name: "@ff-labs/pi-fff", repo: "https://github.com/froooze/fff", branch: "pi-fff-only" },
	{ name: "@juicesharp/rpiv-todo", repo: "https://github.com/froooze/rpiv-mono", branch: "rpiv-todo-only" },
	{ name: "pi-blackhole", repo: "https://github.com/froooze/pi-blackhole", branch: "main" },
];

export interface ArchivePin {
	owner: string;
	repo: string;
	sha: string;
}

const ARCHIVE_PIN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/([0-9a-f]{7,40})\.tar\.gz$/;

/** Parse a GitHub archive tarball URL into its owner/repo/commit, or undefined. */
export function parseArchivePin(spec: string): ArchivePin | undefined {
	const match = ARCHIVE_PIN.exec(spec);
	if (!match) return undefined;
	return { owner: match[1], repo: match[2], sha: match[3] };
}

/** The archive tarball for a fork commit. */
export function archiveUrl(repo: string, sha: string): string {
	return `${repo.replace(/\.git$/, "")}/archive/${sha}.tar.gz`;
}

export interface PinBump {
	name: string;
	repo: string;
	branch: string;
	from: string;
	to: string;
	url: string;
}

/**
 * Pairs each configured pin that differs from its fork branch head into a bump.
 * Missing specs, non-archive specs, and unknown/short remote heads are skipped.
 */
export function planPinBumps(
	dependencies: Record<string, string | undefined>,
	remoteHeads: Record<string, string | undefined>,
): PinBump[] {
	const bumps: PinBump[] = [];
	for (const fork of BUNDLED_FORKS) {
		const spec = dependencies[fork.name];
		if (!spec) continue;
		const pin = parseArchivePin(spec);
		if (!pin) continue;
		const head = remoteHeads[fork.name];
		if (!head || head.length < 40 || head === pin.sha) continue;
		bumps.push({
			name: fork.name,
			repo: fork.repo,
			branch: fork.branch,
			from: pin.sha,
			to: head,
			url: archiveUrl(fork.repo, head),
		});
	}
	return bumps;
}
