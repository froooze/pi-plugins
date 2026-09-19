/**
 * Guard: the bundled-extension pins documented in README.md must match the
 * source of truth in package.json (+ package-lock.json).
 *
 * Why: bundled extensions are pinned as GitHub archive tarballs at an exact
 * commit. A bump commit historically updated package.json + package-lock.json
 * + allowScripts but forgot the README hash, silently drifting the docs.
 * `pi update --extensions` only installs what package.json pins, so the README
 * is the only place a human reads the version — it must not lie.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/pins.test.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type PackageJson = {
	dependencies?: Record<string, string>;
	allowScripts?: Record<string, unknown>;
};
type PackageLock = {
	packages?: Record<string, { version?: string }>;
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as PackageLock;
const readme = readFileSync(join(root, "README.md"), "utf8");

type Pin = { name: string; owner: string; repo: string; sha: string };

function parseArchivePin(name: string, spec: string): Pin | undefined {
	const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/([0-9a-f]{7,40})\.tar\.gz$/.exec(spec);
	if (!match) return undefined;
	return { name, owner: match[1], repo: match[2], sha: match[3] };
}

const pins = Object.entries(pkg.dependencies ?? {})
	.map(([name, spec]) => parseArchivePin(name, spec))
	.filter((pin): pin is Pin => Boolean(pin));

const bundledSection = readme.split("## 📦 Bundled extensions")[1] ?? "";

test("bundled pins: package.json declares at least one GitHub archive dependency", () => {
	assert.ok(pins.length > 0, "expected at least one github archive tarball dependency in package.json");
});

test("bundled pins: README row matches package.json commit", () => {
	for (const pin of pins) {
		const row = bundledSection.split("\n").find((line) => line.includes(`\`${pin.name}\``));
		assert.ok(row, `README bundled table is missing a row for ${pin.name}`);

		const ref = /`([^`]+)#([0-9a-f]{7,40})`/.exec(row);
		assert.ok(ref, `README row for ${pin.name} has no \`owner/repo#sha\` ref`);
		assert.equal(ref[1], `${pin.owner}/${pin.repo}`, `README repository ref for ${pin.name}`);

		assert.ok(
			pin.sha.startsWith(ref[2]),
			`README pin for ${pin.name} is ${ref[2]} but package.json pins ${pin.sha.slice(0, 7)}`,
		);
	}
});

test("bundled pins: README has no stale GitHub archive refs", () => {
	for (const [, repoRef, sha] of readme.matchAll(/`([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9a-f]{7,40})`/g)) {
		const matchesPin = pins.some(
			(pin) => repoRef === `${pin.owner}/${pin.repo}` && pin.sha.startsWith(sha),
		);
		assert.ok(matchesPin, `README references ${repoRef}#${sha} which no package.json pin matches`);
	}
});

test("bundled pins: allowScripts versions match package-lock.json", () => {
	for (const pin of pins) {
		const prefix = `${pin.name}@`;
		for (const key of Object.keys(pkg.allowScripts ?? {})) {
			if (!key.startsWith(prefix)) continue;
			const locked = lock.packages?.[`node_modules/${pin.name}`]?.version;
			assert.equal(key, `${pin.name}@${locked}`, `allowScripts entry ${key} does not match locked ${locked}`);
		}
	}
});
