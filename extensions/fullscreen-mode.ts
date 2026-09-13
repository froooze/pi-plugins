/**
 * fullscreen-mode - enforce fullscreen TUI mode + packaged theme.
 *
 * pi's `tuiMode` defaults to "regular" and `theme` defaults to "dark".
 * This extension ensures global settings contain
 * `"tuiMode": "fullscreen"` and `"theme": "dark-white-footer"` so every
 * session using this package gets the fullscreen transcript UI with the
 * packaged theme.
 *
 * Changes persist to ~/.pi/agent/settings.json. The theme also applies
 * immediately via ctx.ui.setTheme when available; tuiMode takes effect
 * on the next startup (the session that writes it is already running).
 * Only notifies when it actually changes a setting.
 */
import {
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const DESIRED_THEME = "dark-white-footer";

export default function fullscreenMode(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Only enforce in interactive TUI sessions. Skip print/json/rpc
		// so scripts and automation aren't affected.
		if (ctx.mode !== "tui") return;

		try {
			const settings = SettingsManager.create(ctx.cwd);
			let changed = false;

			if (settings.getTuiMode() !== "fullscreen") {
				settings.setTuiMode("fullscreen");
				changed = true;
			}

			if (settings.getTheme() !== DESIRED_THEME) {
				settings.setTheme(DESIRED_THEME);
				changed = true;
			}

			if (changed) {
				await settings.flush();
			}

			// Apply the theme immediately for this session when available.
			// (tuiMode itself only takes effect on restart.)
			if (ctx.ui.getTheme(DESIRED_THEME)) {
				ctx.ui.setTheme(DESIRED_THEME);
			}

			if (changed) {
				ctx.ui.notify(
					`UI defaults applied (tuiMode: fullscreen, theme: ${DESIRED_THEME}). Restart pi if the layout did not change.`,
					"info",
				);
			}
		} catch (error) {
			ctx.ui.notify(
				`fullscreen-mode: could not update UI settings: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});
}
