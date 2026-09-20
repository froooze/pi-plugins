/**
 * Pure reconcile logic for the centralized model defaults.
 *
 * The shared defaults live in the repo-versioned `model-defaults.json`, which
 * reaches every machine through the `git:github.com/froooze/pi-plugins`
 * package. Pi itself only reads the machine-local `<agentDir>/settings.json`,
 * so `extensions/model-defaults.ts` applies the shared defaults at session
 * start instead of writing them into settings.json — settings.json then only
 * ever holds values a user explicitly chose.
 *
 * Precedence and lifecycle for a managed key (currently `defaultProvider`,
 * `defaultModel`, `defaultThinkingLevel`):
 *
 * - local equals the current shared value  → redundant mirror, removed so the
 *   centralized file stays the single source of truth;
 * - local equals the *previous* shared value (tracked in a sidecar state file)
 *   → stale mirror from an older sync, removed so an updated centralized value
 *   takes effect;
 * - local differs from both → an explicit user choice, kept untouched
 *   (local is king).
 *
 * NOTE: like `compaction.ts`, this lives in a subdirectory without an
 * `index.ts`, so pi's extension discovery does not load it as an extension.
 */

export type Defaults = Record<string, unknown>;

/** Settings keys the shared defaults are allowed to manage. */
export const MANAGED_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];

export interface ReconcileResult {
	/** New settings object with redundant/stale managed keys removed. */
	settings: Record<string, unknown>;
	/** True when at least one managed key was removed. */
	changed: boolean;
	/** Managed keys removed (for logging). */
	removed: ManagedKey[];
	/** True when at least one managed key holds an explicit local choice. */
	localOverride: boolean;
	/** Managed keys holding an explicit local choice (local wins). */
	overridden: ManagedKey[];
}

/** Order-independent canonical form; enough for the JSON scalars/maps we reconcile. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function same(a: unknown, b: unknown): boolean {
	return canonical(a) === canonical(b);
}

/** Whether the shared file declares a value for a managed key. */
function declares(shared: Defaults, key: ManagedKey): boolean {
	return Object.prototype.hasOwnProperty.call(shared, key);
}

/**
 * Reconcile the managed keys in `settings` against the current shared defaults
 * and the previously propagated shared defaults. Never mutates its inputs.
 */
export function reconcileModelDefaults(
	settings: Record<string, unknown>,
	shared: Defaults,
	previous: Defaults,
): ReconcileResult {
	const next: Record<string, unknown> = { ...settings };
	const removed: ManagedKey[] = [];
	const overridden: ManagedKey[] = [];

	for (const key of MANAGED_KEYS) {
		if (!declares(shared, key)) continue;
		if (!Object.prototype.hasOwnProperty.call(next, key)) continue;

		const local = next[key];
		const sharedValue = shared[key];

		if (same(local, sharedValue)) {
			delete next[key];
			removed.push(key);
			continue;
		}
		if (declares(previous, key) && same(local, previous[key])) {
			delete next[key];
			removed.push(key);
			continue;
		}
		overridden.push(key);
	}

	return {
		settings: next,
		changed: removed.length > 0,
		removed,
		localOverride: overridden.length > 0,
		overridden,
	};
}

/**
 * Effective thinking level for the shared default model. Precedence mirrors
 * "local is king": an explicit `modelThinkingLevels["provider/model"]` beats an
 * explicit `defaultThinkingLevel`, which beats the shared value. `undefined`
 * means no level should be forced.
 */
export function resolveThinking(
	settings: Record<string, unknown>,
	shared: Defaults,
	provider: string,
	modelId: string,
	valid: readonly string[],
): string | undefined {
	const map = settings.modelThinkingLevels;
	if (map !== null && typeof map === "object" && !Array.isArray(map)) {
		const perModel = (map as Record<string, unknown>)[`${provider}/${modelId}`];
		if (typeof perModel === "string" && valid.includes(perModel)) return perModel;
	}
	if (typeof settings.defaultThinkingLevel === "string" && valid.includes(settings.defaultThinkingLevel)) {
		return settings.defaultThinkingLevel;
	}
	const value = shared.defaultThinkingLevel;
	return typeof value === "string" && valid.includes(value) ? value : undefined;
}
