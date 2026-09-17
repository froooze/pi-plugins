/**
 * opencode-login - unified OpenCode API key entry.
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
 * What this does
 * --------------
 * - Registers `/opencode` (plus `/opencode-login` alias):
 *     - no key stored yet -> prompts once, writes the SAME key to both
 *       `opencode` and `opencode-go` in `~/.pi/agent/auth.json`
 *     - key already stored -> offers Update / Copy to clipboard / Status
 *     - `/opencode <key>`, `/opencode copy`, `/opencode status` work
 *       non-interactively (print/RPC mode included)
 * - On `session_start`, mirrors a one-sided setup: if exactly one of the two
 *   entries exists in auth.json, the missing one is backfilled with the same
 *   credential object so `/login` shows both as `✓ stored`. If both exist but
 *   differ, it warns and leaves them alone (`/opencode` unifies on demand).
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

function statusLine(ctx: ExtensionCommandContext): string {
	return PROVIDERS.map((provider) => {
		const status = ctx.modelRegistry.getProviderAuthStatus(provider);
		const name = provider === ZEN ? "OpenCode Zen" : "OpenCode Go";
		if (!status.configured) return `${name}: unconfigured`;
		const source =
			status.source === "stored"
				? "stored"
				: status.label?.trim()
					? status.label
					: (status.source ?? "configured");
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
		warnOrThrow(ctx, "No OpenCode API key configured yet. Run /opencode to save one.");
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
	report(ctx, "OpenCode API key copied to clipboard.");
}

async function promptAndSave(ctx: ExtensionCommandContext): Promise<void> {
	const key = await ctx.ui.input("OpenCode API key (saved to Zen + Go)", "sk-...");
	if (key === undefined) return; // dismissed
	const trimmed = key.trim();
	if (!trimmed) {
		ctx.ui.notify("Empty key — nothing saved.", "warning");
		return;
	}
	try {
		saveUnifiedKey(trimmed);
	} catch (error) {
		ctx.ui.notify(
			`Could not write auth.json: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	await refreshOpencode(ctx);
	ctx.ui.notify(
		`Saved the same OpenCode API key for ${ZEN} + ${GO}.\n${statusLine(ctx)}`,
		"info",
	);
	try {
		await copyToClipboard(trimmed);
		ctx.ui.notify("Also copied to clipboard.", "info");
	} catch {
		// Saving is what matters; clipboard is a convenience.
	}
}

const SUBCOMMANDS = ["copy", "status", "help", "set"] as const;

/** True when the word is an obvious typo of a subcommand, e.g. `stats`, `coppy`.
 * Only the abbreviation direction counts (`stat` -> `status`). Never the
 * reverse: API keys may start with any letters, so `settlement-...` must
 * still save instead of warning. */
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
			`Unknown subcommand "${word}". Try /opencode copy, /opencode status, /opencode help — or pass the full API key.`,
		);
		return;
	}

	if (word === "copy") {
		await copyCurrentKey(ctx);
		return;
	}
	if (word === "status") {
		report(ctx, statusLine(ctx));
		return;
	}
	if (word === "help" || word === "?" || word === "-h" || word === "--help") {
		ctx.ui.notify(
			"/opencode — one key for Zen + Go\n" +
				"/opencode <key> — save without prompting\n" +
				"/opencode copy — copy the current key to clipboard\n" +
				"/opencode status — show Zen/Go auth status",
			"info",
		);
		return;
	}
	// Non-interactive set: `/opencode sk-...` (also covers print/RPC mode,
	// where there is no dialog UI to prompt with). `set` is an accepted
	// verb: `/opencode set sk-...`.
	let inlineKey = arg;
	if (word === "set") inlineKey = arg.slice(3).trim();
	if (inlineKey && !/\s/.test(inlineKey)) {
		try {
			saveUnifiedKey(inlineKey);
		} catch (error) {
			const message = `Could not write auth.json: ${error instanceof Error ? error.message : String(error)}`;
			if (!ctx.hasUI) throw new Error(message);
			ctx.ui.notify(message, "error");
			return;
		}
		await refreshOpencode(ctx);
		report(ctx, `Saved the same OpenCode API key for ${ZEN} + ${GO}.\n${statusLine(ctx)}`);
		try {
			await copyToClipboard(inlineKey);
			report(ctx, "Also copied to clipboard.");
		} catch {
			// Saving is what matters; clipboard is a convenience.
		}
		return;
	}
	if (inlineKey) {
		warnOrThrow(ctx, "That doesn't look like a single API key (no spaces expected).");
		return;
	}

	if (!ctx.hasUI) {
		throw new Error("No OpenCode API key configured. Re-run with the key: /opencode <key>");
	}

	const zenStatus = ctx.modelRegistry.getProviderAuthStatus(ZEN);
	const goStatus = ctx.modelRegistry.getProviderAuthStatus(GO);
	if (!zenStatus.configured && !goStatus.configured) {
		await promptAndSave(ctx);
		return;
	}

	const choice = await ctx.ui.select("OpenCode API key (shared by Zen + Go)", [
		"Update key (writes to Zen + Go)",
		"Copy current key to clipboard",
		"Show status",
	]);
	if (choice === undefined) return;
	if (choice.startsWith("Copy")) {
		await copyCurrentKey(ctx);
		return;
	}
	if (choice.startsWith("Show")) {
		ctx.ui.notify(statusLine(ctx), "info");
		return;
	}
	await promptAndSave(ctx);
}

/**
 * Backfill the missing side when only one entry exists, so `/login` shows
 * both rows as configured. Returns true when it wrote the file.
 */
function mirrorOneSidedSetup(): boolean {
	const path = authPath();
	const zen = readStoredCredential(ZEN, path);
	const go = readStoredCredential(GO, path);
	const zenKey = isApiKeyCredential(zen);
	const goKey = isApiKeyCredential(go);

	if ((zenKey && goKey) || (!zenKey && !goKey)) return false;

	const source = zenKey ? zen : go;
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
	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		await handleOpencode(args, ctx);
	};
	pi.registerCommand("opencode", {
		description: "Save one OpenCode API key for Zen + Go (mirrored), copy it to clipboard",
		getArgumentCompletions: (prefix: string) => {
			const options = ["copy", "status", "help"];
			const matches = options.filter((opt) => opt.startsWith(prefix.toLowerCase()));
			if (matches.length === 0) return null;
			return matches.map((value) => ({
				value,
				label: value,
				description: value === "copy" ? "Copy the current key" : value === "status" ? "Show Zen/Go auth status" : "Show usage",
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
						`OpenCode Zen and Go keys differ. Run /opencode to unify them (both use the same API key).`,
						"warning",
					);
				}
			} catch {
				// Status nudge only; never break startup.
			}
			return;
		}
		try {
			await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [...PROVIDERS] });
		} catch {
			// File is fixed; the next availability pass converges.
		}
		ctx.ui.notify(
			`opencode-login: mirrored the OpenCode API key so both ${ZEN} and ${GO} show as configured.`,
			"info",
		);
	});
}
