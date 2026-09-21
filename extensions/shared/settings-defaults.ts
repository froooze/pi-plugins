/**
 * Pure reconcile logic for the centralized plugin defaults.
 *
 * Pi has no native package/extension contract for seeding or overriding a value
 * in a machine-local plugin config: `SettingsManager.applyOverrides()` is
 * SDK-only and in-memory (never persisted), the setters Pi exposes cover only
 * selected `settings.json` fields, and no API lets a package write another
 * plugin's config file. So, like the extensions that predate this module, the
 * applier writes the files directly — and this module owns the policy so it
 * stays testable.
 *
 * The repo-versioned `settings-defaults.json` is the single source of truth and
 * declares one entry per target file under `targets`:
 *
 * ```json
 * { "targets": { "<id>": { "backfill": {}, "enforce": {}, "env": {} } } }
 * ```
 *
 * - `backfill`: written only when the leaf is absent. An explicit local value
 *   always wins, so this is a default, not an override.
 * - `enforce`: written whenever the leaf differs from the configured value.
 * - `env`: dotted path → env var. When a *backfilled* path has an env var and
 *   that var is unset/empty, the value is mirrored (`true`/`false` → `"1"`/`"0"`).
 *   A key already present in the file is never mirrored, matching pi-fff's
 *   `flag > env > file` precedence.
 *
 * Both maps deep-create missing intermediate objects. A path whose intermediate
 * segment exists but is not a plain object (a malformed local value) is left
 * untouched and reported as skipped, so user data is never clobbered.
 *
 * NOTE: like `compaction.ts` and `model-defaults.ts`, this file lives in a
 * subdirectory without an `index.ts`, so pi's extension discovery does not load
 * it as an extension — it is imported by the extensions that need it and by
 * `test/settings-defaults.test.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TargetDefaults {
	/** Dotted-path → value pairs applied only when the leaf is absent. */
	backfill?: Record<string, unknown>;
	/** Dotted-path → value pairs applied whenever the leaf differs. */
	enforce?: Record<string, unknown>;
	/** Dotted path → env var mirrored when the path was backfilled. */
	env?: Record<string, string>;
}

export interface SettingsDefaultsConfig {
	targets: Record<string, TargetDefaults>;
}

export interface SkippedPath {
	path: string;
	reason: "invalid-path" | "conflict";
}

export interface SettingsDefaultsResult {
	/** Cloned settings object with the defaults applied. Input is never mutated. */
	settings: Record<string, unknown>;
	/** True when at least one path was backfilled or enforced. */
	changed: boolean;
	/** Backfill paths that were absent and got written. */
	backfilled: string[];
	/** Enforce paths that differed and got written. */
	enforced: string[];
	/** Env vars set by the `env` mirror. */
	mirrored: string[];
	/** Paths left untouched because the path or an intermediate value is malformed. */
	skipped: SkippedPath[];
}

/** Minimal env accessor so tests can avoid touching `process.env`. */
export interface EnvLike {
	get(name: string): string | undefined;
	set(name: string, value: string): void;
}

export interface ApplyOptions {
	/** Env accessor for the `env` mirror map. Defaults to `process.env`. */
	env?: EnvLike;
}

const processEnv: EnvLike = {
	get: (name) => process.env[name],
	set: (name, value) => {
		process.env[name] = value;
	},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deep clone for the JSON-shaped values settings/defaults are made of. */
function cloneJson<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as unknown as T;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		out[key] = cloneJson(item);
	}
	return out as unknown as T;
}

/** Order-independent canonical form for deep equality of JSON values. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/** Split a dotted path, or null when it has empty segments (`""`, `"a..b"`, `".a"`). */
function splitPath(path: string): string[] | null {
	if (typeof path !== "string" || path.length === 0) return null;
	const segments = path.split(".");
	if (segments.some((segment) => segment.length === 0)) return null;
	return segments;
}

/** Whether every segment exists; returns the leaf value when present. */
function getPath(root: Record<string, unknown>, segments: string[]): { present: boolean; value?: unknown } {
	let current: unknown = root;
	for (const segment of segments) {
		if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
			return { present: false };
		}
		current = current[segment];
	}
	return { present: true, value: current };
}

/**
 * Assign `value` at `segments`, creating missing intermediate objects. Returns
 * false when an intermediate segment exists but is not a plain object (conflict).
 * Mutates `root`, which callers pass as a clone.
 */
function setPath(root: Record<string, unknown>, segments: string[], value: unknown): boolean {
	let current = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		const next = current[segment];
		if (next === undefined) {
			const created: Record<string, unknown> = {};
			current[segment] = created;
			current = created;
		} else if (isPlainObject(next)) {
			current = next;
		} else {
			return false;
		}
	}
	current[segments[segments.length - 1]] = value;
	return true;
}

/** Normalize one target's parsed section into typed maps. */
export function normalizeDefaults(raw: unknown): TargetDefaults {
	if (!isPlainObject(raw)) return { backfill: {}, enforce: {}, env: {} };
	const env: Record<string, string> = {};
	if (isPlainObject(raw.env)) {
		for (const [path, value] of Object.entries(raw.env)) {
			if (typeof value === "string" && value.length > 0) env[path] = value;
		}
	}
	return {
		backfill: isPlainObject(raw.backfill) ? raw.backfill : {},
		enforce: isPlainObject(raw.enforce) ? raw.enforce : {},
		env,
	};
}

/** Normalize a parsed settings-defaults.json into the target registry. */
export function normalizeConfig(raw: unknown): SettingsDefaultsConfig {
	if (!isPlainObject(raw) || !isPlainObject(raw.targets)) return { targets: {} };
	const targets: Record<string, TargetDefaults> = {};
	for (const [id, value] of Object.entries(raw.targets)) {
		if (isPlainObject(value)) targets[id] = normalizeDefaults(value);
	}
	return { targets };
}

/** Load and normalize the bundled settings-defaults.json next to the package root. */
export function loadBundledConfig(): SettingsDefaultsConfig {
	try {
		const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "settings-defaults.json");
		if (!existsSync(path)) return { targets: {} };
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { targets: {} };
	}
}

/** Apply one target's backfill/enforce/env maps to a settings object. Never mutates the input. */
export function applySettingsDefaults(
	settings: Record<string, unknown>,
	target: TargetDefaults,
	options?: ApplyOptions,
): SettingsDefaultsResult {
	const next = cloneJson(settings);
	const env = options?.env ?? processEnv;
	const backfilled: string[] = [];
	const enforced: string[] = [];
	const mirrored: string[] = [];
	const skipped: SkippedPath[] = [];

	for (const [path, value] of Object.entries(target.backfill ?? {})) {
		const segments = splitPath(path);
		if (!segments) {
			skipped.push({ path, reason: "invalid-path" });
			continue;
		}
		if (getPath(next, segments).present) continue; // explicit local value wins
		if (!setPath(next, segments, cloneJson(value))) {
			skipped.push({ path, reason: "conflict" });
			continue;
		}
		backfilled.push(path);

		const envVar = target.env?.[path];
		if (envVar) {
			const current = env.get(envVar);
			if (current === undefined || current === "") {
				env.set(envVar, value ? "1" : "0");
				mirrored.push(envVar);
			}
		}
	}

	for (const [path, value] of Object.entries(target.enforce ?? {})) {
		const segments = splitPath(path);
		if (!segments) {
			skipped.push({ path, reason: "invalid-path" });
			continue;
		}
		const found = getPath(next, segments);
		if (found.present && canonical(found.value) === canonical(value)) continue; // already correct
		if (!setPath(next, segments, cloneJson(value))) {
			skipped.push({ path, reason: "conflict" });
			continue;
		}
		enforced.push(path);
	}

	return {
		settings: next,
		changed: backfilled.length > 0 || enforced.length > 0,
		backfilled,
		enforced,
		mirrored,
		skipped,
	};
}
