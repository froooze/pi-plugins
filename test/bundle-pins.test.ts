/**
 * Tests for the pure bundled-fork pin logic in extensions/shared/bundle-pins.ts.
 *
 * The IO half (resolving fork heads, running npm) is integration territory; here
 * we guard the decision of *which* pins advance and the archive-URL parsing the
 * README/pins test relies on.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/bundle-pins.test.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	BUNDLED_FORKS,
	archiveUrl,
	parseArchivePin,
	planPinBumps,
} from "../extensions/shared/bundle-pins.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BASE = "https://github.com/froooze/pi-blackhole/archive/";
const OLD_SHA = "0d1c5da8c346ce467102b078bd71fba997fd4222";
const NEW_SHA = "e0cbdf0a4ae4ca875dec866d4032feb4fe610862";

test("parseArchivePin accepts a GitHub archive tarball", () => {
	assert.deepEqual(parseArchivePin(`${BASE}${OLD_SHA}.tar.gz`), {
		owner: "froooze",
		repo: "pi-blackhole",
		sha: OLD_SHA,
	});
});

test("parseArchivePin rejects non-archive specs", () => {
	assert.equal(parseArchivePin("^1.2.3"), undefined);
	assert.equal(parseArchivePin("git:github.com/froooze/pi-blackhole"), undefined);
	assert.equal(parseArchivePin(`${BASE}not-a-sha.tar.gz`), undefined);
});

test("archiveUrl builds the pinned tarball URL and tolerates a .git suffix", () => {
	assert.equal(archiveUrl("https://github.com/froooze/pi-blackhole", NEW_SHA), `${BASE}${NEW_SHA}.tar.gz`);
	assert.equal(archiveUrl("https://github.com/froooze/vi.git", NEW_SHA), `https://github.com/froooze/vi/archive/${NEW_SHA}.tar.gz`);
});

test("planPinBumps advances only forks whose pin differs from the branch head", () => {
	const dependencies = Object.fromEntries(BUNDLED_FORKS.map((fork) => [fork.name, `${BASE}${OLD_SHA}.tar.gz`]));
	const remoteHeads = Object.fromEntries(BUNDLED_FORKS.map((fork) => [fork.name, NEW_SHA]));

	const bumps = planPinBumps(dependencies, remoteHeads);

	assert.equal(bumps.length, BUNDLED_FORKS.length);
	for (const bump of bumps) {
		assert.equal(bump.from, OLD_SHA);
		assert.equal(bump.to, NEW_SHA);
		assert.equal(bump.url, archiveUrl(bump.repo, NEW_SHA));
	}
});

test("planPinBumps is a no-op when the pin already matches the head", () => {
	const dependencies = { "pi-blackhole": `${BASE}${NEW_SHA}.tar.gz` };
	assert.deepEqual(planPinBumps(dependencies, { "pi-blackhole": NEW_SHA }), []);
});

test("planPinBumps skips missing deps, non-archive specs, and unknown heads", () => {
	const deps = {
		"@ff-labs/pi-fff": `${BASE}${OLD_SHA}.tar.gz`,
		"@juicesharp/rpiv-todo": "^1.0.0",
		"pi-blackhole": `${BASE}${OLD_SHA}.tar.gz`,
	};
	assert.deepEqual(planPinBumps(deps, {}), []);
	const bumps = planPinBumps(deps, { "@ff-labs/pi-fff": NEW_SHA });
	assert.deepEqual(bumps.map((bump) => bump.name), ["@ff-labs/pi-fff"]);
});

test("every pinned archive dependency is covered by BUNDLED_FORKS", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const covered = new Set(BUNDLED_FORKS.map((fork) => fork.name));
	const pinned = Object.entries(pkg.dependencies ?? {}).filter(([, spec]) => parseArchivePin(spec));
	assert.ok(pinned.length > 0, "expected at least one pinned archive dependency");
	for (const [name] of pinned) {
		assert.ok(covered.has(name), `${name} is pinned in package.json but missing from BUNDLED_FORKS`);
	}
});
