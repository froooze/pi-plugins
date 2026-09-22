/**
 * Tests for extensions/ketch-setup.ts pure logic.
 *
 * Run: node --experimental-strip-types --no-warnings --test test/ketch-setup.test.ts
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	assetName,
	buildStatusLines,
	isProcresize,
	mergeConfig,
	parseChecksums,
	resolveKetchPath,
	spawnEnv,
	summarizeDoctor,
	wrapperScript,
	RELEASE_VERSION,
} from "../extensions/ketch-setup.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------ doctor */

const DOCTOR_SAMPLE = [
	{ surface: "search", backend: "auto", status: "ok", latency_ms: 0 },
	{ surface: "search", backend: "brave", status: "no_key", detail: "API key not set" },
	{ surface: "search", backend: "degoog", status: "misconfigured", detail: "degoog_url not set" },
	{ surface: "browser", backend: "none", status: "skipped" },
	"garbage",
	null,
	{ noStatus: true },
];

test("summarizeDoctor: counts rows, problems and blocking class", () => {
	const s = summarizeDoctor(DOCTOR_SAMPLE);
	assert.equal(s.total, 4); // non-objects / status-less entries skipped
	assert.equal(s.ok, 1);
	assert.equal(s.skipped, 1);
	assert.deepEqual(
		s.problems.map((p) => `${p.surface}/${p.backend}:${p.status}`),
		["search/brave:no_key", "search/degoog:misconfigured"],
	);
	assert.equal(s.blocking, 1); // only misconfigured counts as blocking
});

test("summarizeDoctor: non-array input degrades to zeros", () => {
	for (const bad of [undefined, null, "x", { not: "array" }, 42]) {
		const s = summarizeDoctor(bad);
		assert.equal(s.total, 0);
		assert.equal(s.ok, 0);
		assert.equal(s.blocking, 0);
		assert.deepEqual(s.problems, []);
	}
});

/* ----------------------------------------------------------- installer */

test("assetName: goreleaser naming (x64 → x86_64, windows zip)", () => {
	assert.equal(assetName("v0.18.0", "linux", "x64"), "ketch_0.18.0_linux_x86_64.tar.gz");
	assert.equal(assetName("v0.18.0", "linux", "arm64"), "ketch_0.18.0_linux_arm64.tar.gz");
	assert.equal(assetName("v0.18.0", "darwin", "arm64"), "ketch_0.18.0_darwin_arm64.tar.gz");
	assert.equal(assetName("v0.18.0", "darwin", "x64"), "ketch_0.18.0_darwin_x86_64.tar.gz");
	assert.equal(assetName("v0.18.0", "win32", "x64"), "ketch_0.18.0_windows_x86_64.zip");
	// unprefixed versions are tolerated (v stripped once)
	assert.equal(assetName("0.18.0", "linux", "x64"), "ketch_0.18.0_linux_x86_64.tar.gz");
	// unsupported platform/arch → undefined (manual-install path)
	assert.equal(assetName("v0.18.0", "freebsd", "x64"), undefined);
	assert.equal(assetName("v0.18.0", "linux", "ia32"), undefined);
});

test("parseChecksums: sha256 lines, * prefix, garbage tolerated", () => {
	const hashA = "a".repeat(64);
	const hashB = "B".repeat(64);
	const parsed = parseChecksums(
		[`${hashA}  ketch_0.18.0_linux_x86_64.tar.gz`, `${hashB} *ketch_0.18.0_darwin_arm64.tar.gz`, "", "not a checksum"].join("\n"),
	);
	assert.deepEqual(parsed, {
		"ketch_0.18.0_linux_x86_64.tar.gz": hashA,
		"ketch_0.18.0_darwin_arm64.tar.gz": hashB.toLowerCase(), // normalized
	});
});

test("isProcresize: only the Go 1.25 cgroup startup abort", () => {
	assert.ok(isProcresize("fatal error: procresize: invalid arg\n\nruntime stack:"));
	assert.ok(!isProcresize(""));
	assert.ok(!isProcresize("Error: unknown command"));
});

test("installer pin matches the vendored skill's provenance line", async () => {
	assert.equal(RELEASE_VERSION, "v0.18.0");
	const skill = readFileSync(join(root, "skills", "ketch", "SKILL.md"), "utf8");
	assert.ok(
		skill.includes(`1broseidon/ketch@${RELEASE_VERSION}`),
		`skills/ketch/SKILL.md must record vendoring from the same pin the installer downloads (${RELEASE_VERSION})`,
	);
});

/* ------------------------------------------------------------- wrapper */

test("wrapperScript: pins GOMAXPROCS and execs the parked binary", () => {
	const script = wrapperScript("/home/u");
	assert.ok(script.startsWith("#!/bin/sh"));
	assert.ok(script.includes("GOMAXPROCS=\"${GOMAXPROCS:-"));
	assert.ok(script.includes('exec "/home/u/.local/libexec/ketch-bin" "$@"'));
	assert.ok(script.includes("procresize"), "comment documents why the wrapper exists");
});

test("spawnEnv: keeps an explicit GOMAXPROCS, pins CPUs otherwise", () => {
	assert.equal(spawnEnv({ GOMAXPROCS: "2" }).GOMAXPROCS, "2");
	// empty string is falsy → must not leak through (Go would parse it as unset-ish)
	assert.match(spawnEnv({ GOMAXPROCS: "" }).GOMAXPROCS ?? "", /^[1-9]\d*$/);
	assert.match(spawnEnv({}).GOMAXPROCS ?? "", /^[1-9]\d*$/);
});

/* -------------------------------------------------------------- config */

test("mergeConfig: defaults, explicit values, corrupt shapes", () => {
	assert.deepEqual(mergeConfig(undefined), { enabled: true, missingNotified: false });
	assert.deepEqual(mergeConfig("junk"), { enabled: true, missingNotified: false });
	assert.deepEqual(mergeConfig([1, 2]), { enabled: true, missingNotified: false });
	assert.deepEqual(mergeConfig({ enabled: false, missingNotified: true }), { enabled: false, missingNotified: true });
	// wrong types fall back per key
	assert.deepEqual(mergeConfig({ enabled: "yes", missingNotified: 1 }), { enabled: true, missingNotified: false });
});

/* ---------------------------------------------------------- PATH probe */

test("resolveKetchPath: first hit on PATH, undefined when absent", () => {
	const dir = join(tmpdir(), `ketch-path-test-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	try {
		writeFileSync(join(dir, "ketch"), "#!/bin/sh\n", { mode: 0o755 });
		const sep = ":"; // POSIX delimiter (module resolves via node:path on this host)
		assert.equal(resolveKetchPath(`${dir}${sep}/nonexistent`), join(dir, "ketch"));
		assert.equal(resolveKetchPath("/nonexistent-dir-xyz"), undefined);
		// empty PATH → no candidates. (Explicit `undefined` would fall back to
		// the real process.env.PATH default — environment-dependent here.)
		assert.equal(resolveKetchPath(""), undefined);
		// binName override (Windows ketch.exe lookup) picks the exact name
		assert.equal(resolveKetchPath(dir, "ketch.exe"), undefined);
		assert.ok(existsSync(join(dir, "ketch")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------ status */

const SUMMARY = summarizeDoctor(DOCTOR_SAMPLE);

test("buildStatusLines: missing binary → single actionable line", () => {
	assert.deepEqual(buildStatusLines({}), ["not installed — run /ketch setup"]);
});

test("buildStatusLines: full render with exit 5, keys, hints, truncation", () => {
	const longDetail = "x".repeat(200);
	const lines = buildStatusLines({
		binPath: "/home/u/.local/bin/ketch",
		version: { version: "v0.18.0", commit: "edb0948", go: "go1.25.7", os: "linux", arch: "amd64", update: { available: false } },
		config: { backend: "auto", config_path: "/home/u/.config/ketch/config.json", github_token_set: true, brave_api_key_set: false },
		summary: summarizeDoctor([
			...DOCTOR_SAMPLE.slice(0, 3),
			{ surface: "docs", backend: "context7", status: "no_key", detail: longDetail },
		]),
		doctorExit: 5,
	});
	const joined = lines.join("\n");
	assert.match(joined, /v0\.18\.0 \(edb0948\) · go1\.25\.7 linux\/amd64/);
	assert.ok(lines.includes("binary: /home/u/.local/bin/ketch"));
	assert.match(joined, /backend: auto · config: \/home\/u\/\.config\/ketch\/config\.json/);
	assert.ok(lines.includes("keys set: github"), "only *_key_set === true entries listed");
	assert.match(joined, /doctor: 1\/4 ok · 0 skipped · 3 problems — EXIT 5/);
	assert.ok(lines.some((l) => l === "- search/degoog: misconfigured — degoog_url not set"));
	assert.ok(lines.some((l) => l.startsWith("- docs/context7: no_key — ") && l.endsWith("…")), "detail truncated with ellipsis");
	assert.ok(lines.some((l) => l.includes("free context7 key")), "docs hint present");
	assert.ok(lines.some((l) => l.includes('doctor counts as blocking (exit 5)')), "blocking note present");
	assert.ok(!joined.includes("update available"), "no update line when update.available is false");
});

test("buildStatusLines: update notice, degraded subsystems", () => {
	const lines = buildStatusLines({
		binPath: "/usr/bin/ketch",
		version: { version: "v0.18.0", commit: "abc1234", update: { available: true, latest_version: "v0.19.0" } },
	});
	assert.ok(lines.includes("update available: v0.19.0"));

	const degraded = buildStatusLines({ binPath: "/usr/bin/ketch" });
	assert.ok(degraded.includes("version: unavailable (ketch version --json failed)"));
	assert.ok(degraded.includes("doctor: unavailable (ketch doctor --json failed)"));
});

test("buildStatusLines: no keys set → keyless-chain line", () => {
	const lines = buildStatusLines({
		binPath: "/usr/bin/ketch",
		config: { backend: "auto", brave_api_key_set: false },
	});
	assert.ok(lines.includes("keys set: none (keyless auto chain active)"));
});
