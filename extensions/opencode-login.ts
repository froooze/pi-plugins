/**
 * opencode-login - OpenCode credentials, OAuth-first.
 *
 * Background
 * ----------
 * Pi ships two built-in providers that share the same credential:
 *
 *   - `opencode`    (OpenCode Zen)  -> `OPENCODE_API_KEY` / auth.json `opencode`
 *   - `opencode-go` (OpenCode Go)   -> `OPENCODE_API_KEY` / auth.json `opencode-go`
 *
 * (see pi/docs/providers.md "Auth File" and
 * `pi-ai/src/providers/opencode.ts` / `opencode-go.ts`: both use
 * `envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"])`).
 *
 * Typing `/login` therefore shows two near-identical rows and the user has to
 * paste the same key twice. Worse, configuring only one leaves the other
 * `• unconfigured`, even though both accept the same key.
 *
 * Plus, OpenCode's own client now logs in through a device OAuth flow
 * (`opencode console login` -> https://opencode.ai/console/device). The static
 * API key alone no longer authenticates Zen reliably, so this extension also
 * registers an OAuth method on the built-in `opencode` provider:
 *
 *   - `/login opencode` -> OAuth (Pi's "Sign in with an account", listed before
 *     the API-key option) runs the same device flow against
 *     https://opencode.ai/console with the public `opencode-cli` client id and
 *     stores the resulting access/refresh tokens in auth.json.
 *   - `/login opencode-go` -> the same console account. Zen and Go share one
 *     OpenCode account, so Go adopts the credential already logged in for Zen
 *     (no second consent); both reconcile a rotated refresh token at refresh
 *     time.
 *
 * What this does
 * --------------
 * - OAuth is the default path; the API key is opt-in and explicit:
 *     - `/login opencode` (or `opencode-go`) -> OAuth; Pi's selector still
 *       lets you pick "Sign in with an API key" instead; Go adopts Zen's
 *       console account.
 *     - `/opencode` with no argument -> status plus OAuth-first choices.
 *     - `/opencode set <key>` -> explicitly writes the SAME API key to both
 *       `opencode` and `opencode-go` in `~/.pi/agent/auth.json` (interactive
 *       replacement of OAuth asks for confirmation).
 *     - `/opencode copy`, `/opencode status` work non-interactively too;
 *       a bare `/opencode <key>` is refused.
 * - On `session_start`, mirrors a one-sided setup: if exactly one of the two
 *   entries exists in auth.json, the missing one is backfilled with the same
 *   credential object so `/login` shows both as `✓ stored`. If both exist but
 *   differ, it warns and leaves them alone (`/opencode set <key>` unifies on
 *   one API key; `/login opencode-go` aligns them on the OAuth account).
 * - On `session_start` it re-reads the account's console projection from
 *   `${console}/api/config` when the stored one is missing or older than a
 *   day, so entitlement changes (e.g. a new free model) appear without a
 *   re-login. `/opencode refresh` forces the same fetch on demand.
 * - After every write it refreshes just those two providers so the login list
 *   flips to `✓ stored` immediately, without a restart.
 *
 * Platform limit (why this is `/opencode`, not `/login`)
 * -------------------------------------------------------
 * Built-in `/login` cannot be extended or filtered by extensions:
 * `interactive-mode.ts` handles `text === "/login"` in `onSubmit` before
 * `session.prompt()` (which is where extension commands dispatch), and
 * `getBuiltInCommandConflictDiagnostics` excludes any extension command named
 * `login` from autocomplete. There is also no event that lets extensions
 * rewrite the provider rows returned by `getLoginProviderOptions()`, and
 * `unregisterProvider("opencode-go")` cannot hide a built-in (recompose falls
 * back to the builtin when no overlay exists). So the unified "Opencode"
 * entry lives one keystroke away at `/opencode`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
	CONSOLE_PROJECTION_TTL_MS,
	consoleProjectionStale,
	createOpencodeOAuth,
	loadConsoleProjection,
	mergeConsoleProjection,
	OPENCODE_GO_PROVIDER,
	type OpenCodeCredential,
} from "./shared/opencode-oauth.ts";

const ZEN = "opencode";
const GO = "opencode-go";
const PROVIDERS = [ZEN, GO] as const;

function authPath(): string {
	return join(getAgentDir(), "auth.json");
}

type StoredApiKey = { type: "api_key"; key: string; env?: Record<string, string> };

function isApiKeyCredential(value: unknown): value is StoredApiKey {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.type === "api_key" && typeof record.key === "string";
}

function isOAuthCredential(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (value as Record<string, unknown>).type === "oauth";
}

function loadAuthFile(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid auth.json: expected an object at ${path}`);
	}
	return parsed as Record<string, unknown>;
}

/** Write the same key to both providers, preserving every other entry. */
function saveUnifiedKey(key: string): void {
	const path = authPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const data = loadAuthFile(path);
	const credential: StoredApiKey = { type: "api_key", key };
	data[ZEN] = { ...credential };
	data[GO] = { ...credential };
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
}

async function refreshOpencode(ctx: ExtensionCommandContext): Promise<void> {
	try {
		await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [...PROVIDERS] });
	} catch {
		// Best effort: the file write already landed; the next startup
		// availability pass picks it up even if this refresh fails.
	}
}

async function resolvedKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	for (const provider of PROVIDERS) {
		try {
			const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
			if (key) return key;
		} catch {
			// Try the next provider.
		}
	}
	return undefined;
}

/** Credential kind stored for a provider, for status/labels (not env/runtime). */
function storedCredentialLabel(provider: string, path: string): string | undefined {
	try {
		const credential = readStoredCredential(provider, path);
		if (isOAuthCredential(credential)) return "OAuth (OpenCode Console)";
		if (isApiKeyCredential(credential)) return "API key";
	} catch {
		// Corrupt auth.json: fall back to the registry status below.
	}
	return undefined;
}

/** Whether the stored credential for a provider is OAuth. */
function storedUsesOAuth(provider: string): boolean {
	try {
		return isOAuthCredential(readStoredCredential(provider, authPath()));
	} catch {
		return false;
	}
}

/** Identity fields of an OAuth credential, for mismatch warnings. */
function oauthIdentity(value: unknown): { id?: string; email?: string } {
	if (!isOAuthCredential(value)) return {};
	const record = value as Record<string, unknown>;
	return {
		id: typeof record.accountID === "string" && record.accountID ? record.accountID : undefined,
		email: typeof record.email === "string" && record.email ? record.email : undefined,
	};
}

/**
 * True only when both credentials expose a comparable id/email and disagree.
 * Comparing an id against an email (one credential missing a field) would
 * otherwise look like a mismatch.
 */
function oauthAccountsDiffer(a: { id?: string; email?: string }, b: { id?: string; email?: string }): boolean {
	if (a.id && b.id) return a.id !== b.id;
	if (a.email && b.email) return a.email !== b.email;
	return false;
}

/**
 * Reader for cross-provider OAuth adoption: `opencode-go` reuses the account
 * already logged in for `opencode`, and both reconcile rotated refresh tokens.
 */
function siblingOAuthReader(provider: string): () => OpenCodeCredential | undefined {
	return () => {
		const credential = readStoredCredential(provider, authPath());
		if (!isOAuthCredential(credential)) return undefined;
		const record = credential as Record<string, unknown>;
		if (
			typeof record.access !== "string" ||
			typeof record.refresh !== "string" ||
			typeof record.expires !== "number"
		) {
			return undefined;
		}
		return {
			...record,
			access: record.access,
			refresh: record.refresh,
			expires: record.expires,
		} as OpenCodeCredential;
	};
}

/**
 * Re-read the account's console projection (inference endpoint, per-model wire
 * API, model whitelist) from `${console}/api/config` and persist it.
 *
 * The whitelist moves server-side (free-tier swaps, newly added models), so a
 * projection captured at login would keep hiding newly entitled models until
 * the next re-login. A missing or stale projection is therefore refreshed at
 * startup once per {@link CONSOLE_PROJECTION_TTL_MS}; `force` skips the TTL for
 * the `/opencode refresh` command. Returns `{ refreshed, changed }`:
 * `refreshed` is false when there is nothing to do or the fetch failed, and
 * `changed` reports whether the model-affecting payload moved (so callers only
 * refresh the model registry when it did).
 *
 * Best-effort: skips API-key setups and `--offline` (unless forced), and leaves
 * auth.json untouched when the fetch fails.
 */
async function refreshConsoleProjection(force = false): Promise<{ refreshed: boolean; changed: boolean }> {
	const skipped = { refreshed: false, changed: false };
	if (!force && process.env.PI_OFFLINE) return skipped;

	const path = authPath();
	const now = Date.now();
	const data = loadAuthFile(path);
	const oauthProviders = PROVIDERS.filter((provider) => isOAuthCredential(data[provider]));
	if (oauthProviders.length === 0) return skipped;

	if (
		!force &&
		!oauthProviders.some((provider) =>
			consoleProjectionStale(data[provider] as OpenCodeCredential, now, CONSOLE_PROJECTION_TTL_MS, provider),
		)
	) {
		return skipped;
	}

	const source = siblingOAuthReader(ZEN)() ?? siblingOAuthReader(GO)();
	if (!source) return skipped;

	// Zen and Go share the account but have distinct `/api/config` entries
	// (different inference endpoint and whitelist), so read the projection per
	// provider instead of applying one entry to both.
	let changed = false;
	let refreshed = false;
	for (const provider of oauthProviders) {
		const projection = await loadConsoleProjection(source, {
			signal: AbortSignal.timeout(5000),
			provider,
		});
		if (!projection) continue;
		refreshed = true;
		const merged = mergeConsoleProjection(data[provider] as OpenCodeCredential, projection, now);
		data[provider] = merged.credential;
		changed = changed || merged.changed;
	}
	if (!refreshed) return skipped;

	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	return { refreshed: true, changed };
}

/**
 * `/opencode refresh`: force a projection re-read and report whether the
 * entitlement/routing payload moved. Recovers from a stale whitelist (e.g. a
 * newly entitled free model) without a re-login.
 */
async function refreshConsoleProjectionCommand(ctx: ExtensionCommandContext): Promise<void> {
	let result: { refreshed: boolean; changed: boolean };
	try {
		result = await refreshConsoleProjection(true);
	} catch (error) {
		const message = `Could not refresh the OpenCode console projection: ${
			error instanceof Error ? error.message : String(error)
		}`;
		if (!ctx.hasUI) throw new Error(message);
		ctx.ui.notify(message, "error");
		return;
	}

	if (!result.refreshed) {
		const message =
			"Could not read the OpenCode console projection (no OAuth credential, or the console was unreachable). " +
			"The stored projection was kept.";
		if (!ctx.hasUI) throw new Error(message);
		ctx.ui.notify(message, "warning");
		return;
	}

	if (result.changed) await refreshOpencode(ctx);
	report(
		ctx,
		`${
			result.changed
				? "Console projection updated (model whitelist/routing refreshed)."
				: "Console projection re-read; nothing changed."
		}\n${statusLine(ctx)}`,
	);
}

function statusLine(ctx: ExtensionCommandContext): string {
	const path = authPath();
	return PROVIDERS.map((provider) => {
		const status = ctx.modelRegistry.getProviderAuthStatus(provider);
		const name = provider === ZEN ? "OpenCode Zen" : "OpenCode Go";
		if (!status.configured) return `${name}: unconfigured`;
		const source =
			storedCredentialLabel(provider, path) ??
			(status.source === "stored"
				? "stored"
				: status.label?.trim()
					? status.label
					: (status.source ?? "configured"));
		return `${name}: ✓ ${source}`;
	}).join("\n");
}

/** Info feedback that also works in print/JSON mode (where ui.notify is a no-op). */
function report(ctx: ExtensionCommandContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, "info");
		return;
	}
	// JSON-mode stdout is a JSON event stream; keep it parseable.
	if (ctx.mode === "json") console.error(message);
	else console.log(message);
}

/**
 * Warning feedback. Print/JSON mode has no dialogs, so throw instead —
 * runPrintMode surfaces it on stderr via the extension error listener.
 */
function warnOrThrow(ctx: ExtensionCommandContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, "warning");
		return;
	}
	throw new Error(message);
}

async function copyCurrentKey(ctx: ExtensionCommandContext): Promise<void> {
	const key = await resolvedKey(ctx);
	if (!key) {
		warnOrThrow(
			ctx,
			"No OpenCode credential configured yet. Sign in with /login opencode (OAuth), or set a key with /opencode set <key>.",
		);
		return;
	}
	try {
		await copyToClipboard(key);
	} catch (error) {
		const message = `Could not copy to clipboard: ${error instanceof Error ? error.message : String(error)}`;
		if (!ctx.hasUI) throw new Error(message);
		ctx.ui.notify(message, "error");
		return;
	}
	report(ctx, "OpenCode credential copied to clipboard (it may expire if it is an OAuth token).");
}

async function promptAndSave(ctx: ExtensionCommandContext, replacingOAuth = false): Promise<void> {
	const title = replacingOAuth
		? "OpenCode API key (replaces the stored OAuth credential)"
		: "OpenCode API key (saved to Zen + Go)";
	const key = await ctx.ui.input(title, "sk-...");
	if (key === undefined) return; // dismissed
	const trimmed = key.trim();
	if (!trimmed) {
		ctx.ui.notify("Empty key — nothing saved.", "warning");
		return;
	}
	await applyApiKey(ctx, trimmed, replacingOAuth);
}

/** Write one API key to both providers, refresh, and report. */
async function applyApiKey(
	ctx: ExtensionCommandContext,
	key: string,
	replacedOAuth: boolean,
): Promise<void> {
	try {
		saveUnifiedKey(key);
	} catch (error) {
		const message = `Could not write auth.json: ${error instanceof Error ? error.message : String(error)}`;
		if (!ctx.hasUI) throw new Error(message);
		ctx.ui.notify(message, "error");
		return;
	}
	await refreshOpencode(ctx);
	report(
		ctx,
		`Saved the same OpenCode API key for ${ZEN} + ${GO}.${
			replacedOAuth ? "\nReplaced the stored OAuth credential (run /login opencode to sign back in with OAuth)." : ""
		}\n${statusLine(ctx)}`,
	);
	try {
		await copyToClipboard(key);
		report(ctx, "Also copied to clipboard.");
	} catch {
		// Saving is what matters; clipboard is a convenience.
	}
}

const SUBCOMMANDS = ["copy", "refresh", "status", "help", "set"] as const;

/** True when the word is an obvious typo of a subcommand, e.g. `stats`, `coppy`.
 * Only the abbreviation direction counts (`stat` -> `status`). Never the reverse,
 * so a word merely starting with a subcommand (e.g. `settings`) is not flagged. */
function isNearMissSubcommand(word: string): boolean {
	if (!word || SUBCOMMANDS.some((sub) => word === sub)) return false;
	if (SUBCOMMANDS.some((sub) => sub.startsWith(word))) return true;
	return SUBCOMMANDS.some((sub) => {
		if (Math.abs(sub.length - word.length) > 2) return false;
		let edits = 0;
		const a = sub;
		const b = word;
		const len = Math.max(a.length, b.length);
		for (let i = 0; i < len; i++) {
			if (a[i] !== b[i] && ++edits > 2) return false;
		}
		return edits <= 2;
	});
}

async function handleOpencode(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const arg = args.trim();
	const word = arg.split(/\s+/, 1)[0]?.toLowerCase() ?? "";

	if (isNearMissSubcommand(word)) {
		warnOrThrow(
			ctx,
			`Unknown subcommand "${word}". Try /opencode status, /opencode refresh, /opencode copy, /opencode help.`,
		);
		return;
	}

	if (word === "copy") {
		await copyCurrentKey(ctx);
		return;
	}
	if (word === "refresh") {
		await refreshConsoleProjectionCommand(ctx);
		return;
	}
	if (word === "status") {
		report(ctx, statusLine(ctx));
		return;
	}
	if (word === "help" || word === "?" || word === "-h" || word === "--help") {
		report(
			ctx,
			"/opencode — OpenCode credentials (OAuth is the default)\n" +
				"/opencode status — show Zen/Go credential type\n" +
				"/opencode copy — copy the current credential to clipboard\n" +
				"/opencode refresh — re-read the account's model whitelist/routing now\n" +
				"/opencode set <key> — explicitly save one API key for Zen + Go\n" +
				"/login opencode — sign in with the OpenCode Console account (OAuth)",
		);
		return;
	}

	// API keys are opt-in and accepted only through the explicit `set` verb.
	// A bare key argument must never silently replace an OAuth login.
	if (word === "set") {
		const key = arg.slice(3).trim();
		if (!key || /\s/.test(key)) {
			warnOrThrow(ctx, "Usage: /opencode set <key> (a single API key, no spaces).");
			return;
		}
		const replacedOAuth = storedUsesOAuth(ZEN) || storedUsesOAuth(GO);
		if (replacedOAuth && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"Replace the OpenCode OAuth credential?",
				"Saving a static API key overwrites the stored OAuth tokens for Zen + Go. Run /login opencode to sign back in with OAuth.",
			);
			if (!confirmed) return;
		}
		await applyApiKey(ctx, key, replacedOAuth);
		return;
	}
	if (arg) {
		warnOrThrow(
			ctx,
			"API keys are only saved explicitly. Use /opencode set <key>, or /login opencode for OAuth.",
		);
		return;
	}

	// No arguments: report status and the OAuth-first choices.
	if (!ctx.hasUI) {
		report(
			ctx,
			`${statusLine(ctx)}\n\nOAuth (default): /login opencode (Go shares the same account)\nAPI key (explicit): /opencode set <key>`,
		);
		return;
	}

	const zenOAuth = storedUsesOAuth(ZEN);
	const choice = await ctx.ui.select("OpenCode credentials (Zen + Go)", [
		"Show status",
		"Copy current credential to clipboard",
		"Sign in with OAuth — run /login opencode",
		zenOAuth ? "Replace with an API key (explicit)" : "Set an API key (explicit)",
	]);
	if (choice === undefined) return;
	if (choice.startsWith("Show")) {
		ctx.ui.notify(statusLine(ctx), "info");
		return;
	}
	if (choice.startsWith("Copy")) {
		await copyCurrentKey(ctx);
		return;
	}
	if (choice.startsWith("Sign in")) {
		ctx.ui.notify(
			"Run /login opencode to sign in with the OpenCode Console account (OAuth). /login opencode-go adopts the same account.",
			"info",
		);
		return;
	}
	await promptAndSave(ctx, zenOAuth);
}

type CredentialKind = "api_key" | "oauth";

function credentialKind(value: unknown): CredentialKind | undefined {
	if (isApiKeyCredential(value)) return "api_key";
	if (isOAuthCredential(value)) return "oauth";
	return undefined;
}

/**
 * Backfill the missing side when only one entry exists, so `/login` shows
 * both rows as configured. Returns true when it wrote the file.
 *
 * OAuth is mirrored too: `opencode-go` and `opencode` are the same console
 * account, and the OAuth config adopts the sibling credential (and its rotated
 * refresh token) at login/refresh time, so copying it is safe.
 */
function mirrorOneSidedSetup(): boolean {
	const path = authPath();
	const zen = readStoredCredential(ZEN, path);
	const go = readStoredCredential(GO, path);
	const zenKind = credentialKind(zen);
	const goKind = credentialKind(go);

	// Backfill only a completely missing side. When both are present we leave
	// them alone (and warn if the kinds differ); OAuth siblings reconcile a
	// rotated refresh token through adoption at refresh time.
	if ((zenKind === undefined) === (goKind === undefined)) return false;

	const source = zenKind !== undefined ? zen : go;
	const data = loadAuthFile(path);
	data[ZEN] = structuredClone(source);
	data[GO] = structuredClone(source);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	return true;
}

export default function opencodeLogin(pi: ExtensionAPI) {
	// `/login opencode` and `/login opencode-go` offer OAuth (Pi's "Sign in with
	// an account", listed first) next to the built-in API-key option. Both are
	// the same console account, so Go adopts the credential already stored for
	// Zen.
	pi.registerProvider(ZEN, {
		oauth: createOpencodeOAuth({ provider: ZEN, readSibling: siblingOAuthReader(GO) }),
	});
	pi.registerProvider(GO, {
		oauth: createOpencodeOAuth({ provider: OPENCODE_GO_PROVIDER, readSibling: siblingOAuthReader(ZEN) }),
	});

	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		await handleOpencode(args, ctx);
	};
	pi.registerCommand("opencode", {
		description: "Manage OpenCode credentials (OAuth default; /opencode set <key> for an API key)",
		getArgumentCompletions: (prefix: string) => {
			const options = ["copy", "refresh", "status", "help", "set"];
			const matches = options.filter((opt) => opt.startsWith(prefix.toLowerCase()));
			if (matches.length === 0) return null;
			return matches.map((value) => ({
				value,
				label: value,
				description:
					value === "copy"
						? "Copy the current credential"
						: value === "refresh"
							? "Re-read the console model whitelist/routing"
							: value === "status"
								? "Show Zen/Go auth status (OAuth vs API key)"
								: value === "set"
									? "Explicitly save an API key (Zen + Go)"
									: "Show usage",
			}));
		},
		handler,
	});
	pi.registerCommand("opencode-login", {
		description: "Alias for /opencode",
		handler,
	});

	pi.on("session_start", async (_event, ctx) => {
		let mirrored = false;
		try {
			mirrored = mirrorOneSidedSetup();
		} catch {
			return; // Corrupt auth.json: leave it for pi itself to report.
		}
		if (!mirrored) {
			// Both set but different keys = split-brain from configuring each
			// provider separately in /login. Nudge toward the unified command.
			try {
				const path = authPath();
				const zen = readStoredCredential(ZEN, path);
				const go = readStoredCredential(GO, path);
				if (
					isApiKeyCredential(zen) &&
					isApiKeyCredential(go) &&
					JSON.stringify(zen) !== JSON.stringify(go)
				) {
					ctx.ui.notify(
						"OpenCode Zen and Go API keys differ. Run /opencode set <key> to unify them on one key, or /login opencode to use OAuth.",
						"warning",
					);
				} else if (
					(isOAuthCredential(zen) && isApiKeyCredential(go)) ||
					(isApiKeyCredential(zen) && isOAuthCredential(go))
				) {
					ctx.ui.notify(
						`OpenCode Zen and Go use different credential types (${
							isOAuthCredential(zen) ? "Zen OAuth" : "Zen API key"
						} / ${
							isOAuthCredential(go) ? "Go OAuth" : "Go API key"
						}). Run /login opencode-go to use the same OAuth account, or /opencode set <key> to unify both on one API key.`,
						"warning",
					);
				} else if (isOAuthCredential(zen) && isOAuthCredential(go)) {
					const zenAccount = oauthIdentity(zen);
					const goAccount = oauthIdentity(go);
					if (oauthAccountsDiffer(zenAccount, goAccount)) {
						const label = (who: { id?: string; email?: string }) => who.email ?? who.id ?? "unknown";
						ctx.ui.notify(
							`OpenCode Zen and Go are signed in to different console accounts (${label(zenAccount)} / ${label(goAccount)}). Run /login opencode to re-align them (Go adopts the Zen account).`,
							"warning",
						);
					}
				}
			} catch {
				// Status nudge only; never break startup.
			}
		} else {
			ctx.ui.notify(
				`opencode-login: mirrored the OpenCode credential so both ${ZEN} and ${GO} show as configured.`,
				"info",
			);
		}

		let projectionChanged = false;
		try {
			projectionChanged = (await refreshConsoleProjection()).changed;
		} catch {
			// Refresh is best effort; a failed fetch leaves auth.json unchanged.
		}
		if (!mirrored && !projectionChanged) return;
		try {
			await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [...PROVIDERS] });
		} catch {
			// File is fixed; the next availability pass converges.
		}
	});
}
