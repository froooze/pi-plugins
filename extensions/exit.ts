/**
 * exit — `/exit` as an alias for Pi's built-in `/quit`.
 *
 * Why this is an extension and not a core command
 * -----------------------------------------------
 * `/quit` is handled by a hard string check in Pi's interactive submit path
 * (`modes/interactive/interactive-mode.ts`), declared in the built-in
 * `BUILTIN_SLASH_COMMANDS` list (`core/slash-commands.ts`). Adding `/exit`
 * there would mean touching the `froooze/pi` fork and carrying that diff on
 * every upstream rebase.
 *
 * The extension API already exposes the same shutdown hook in every context
 * (`ctx.shutdown()`), so a registered command gets identical behavior with no
 * fork drift: interactive mode sets `shutdownRequested` and exits when idle,
 * or finishes the in-flight turn first (`checkShutdownRequested`). `/exit` is
 * not a built-in name, so it triggers no command-conflict diagnostic and still
 * appears in autocomplete.
 *
 *   /exit   — same as /quit
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Command name, without the leading slash. */
export const EXIT_COMMAND = "exit";

/** Request a graceful shutdown; the mode decides when it is safe to exit. */
export async function handleExit(ctx: ExtensionCommandContext): Promise<void> {
	ctx.shutdown();
}

/** Register `/exit`. Split out from the default export so it is unit-testable. */
export function registerExit(pi: ExtensionAPI): void {
	pi.registerCommand(EXIT_COMMAND, {
		description: "Quit Pi (alias for /quit)",
		handler: (_args, ctx) => handleExit(ctx),
	});
}

export default function exitCommand(pi: ExtensionAPI): void {
	registerExit(pi);
}
