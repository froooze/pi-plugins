# pi-plugins

Personal [pi](https://github.com/earendil-works/pi-mono) packages by [@froooze](https://github.com/froooze) — first-party extensions, bundled third-party extensions, skills, prompt templates, and themes.

Core `pi` fork lives at [`froooze/pi`](https://github.com/froooze/pi) (upstream contributions only). Everything personal lives here so the fork stays clean and easy to rebase.

## 📥 Install

```bash
# whole package (tracks latest on main)
pi install git:github.com/froooze/pi-plugins

# try without installing
pi -e git:github.com/froooze/pi-plugins
```

Project-local (team-shared, auto-installed on startup after trust):

```bash
pi install -l git:github.com/froooze/pi-plugins
```

Pinned (reproducible, stays on tag):

```bash
pi install git:github.com/froooze/pi-plugins@v1
```

## 📑 Contents

| Dir | What |
|-----|------|
| `extensions/` | TypeScript extensions (`.ts`, auto-discovered) — see own extensions below |
| `skills/` | Agent skills (`*/SKILL.md`) |
| `prompts/` | Prompt templates (`.md`) |
| `themes/` | TUI themes (`.json`) — currently `dark-white-footer` |

## 🧩 Own extensions

| Extension | What it does |
|-----------|--------------|
| `blackhole-defaults` | Warns when a project-local pi-blackhole config, a `PI_BLACKHOLE_*` env var, a project `settings.json`, or a per-model `compaction.modelOverrides` entry shadows a value enforced by `settings-defaults` |
| `btw` | `/btw [question]` opens a side question in a **forked copy of the current session, in a new terminal window** (`pi --fork …`). The fork keeps the whole transcript and streams real thinking/tools; the main session is untouched. `/btw` alone opens Pi's multi-line editor, so formatted questions work (newlines preserved). Terminal auto-detected (tmux, xfce4-terminal, kitty, wezterm, alacritty, ghostty, konsole, gnome-terminal, xterm, macOS Terminal); `PI_BTW_LAUNCH` overrides with a `{cmd}` template, `PI_BTW_PI` overrides the `pi` binary |
| `colored-footer` | Per-stat colored footer; extension statuses (e.g. 🗜) render inline |
| `compact-per-model` | Per-model auto-compact thresholds (249k, luna 85% ≈ 230k) below blackhole's 300k backstop on settled runs; blackhole stays the engine |
| `fff-guard` | Confines FFF indexing to the project cwd (never `/`/`$HOME`; scanning flags declared in `settings-defaults.json`); warns when launched from `/`/`$HOME`, plus fail-fast `rg`/`fd` fallback hints |
| `model-hotkeys` | Alt+1…4 model switching (`/model-hotkeys`); bindings in `model-hotkeys.json` |
| `model-defaults` | Applies the repo-versioned startup model/thinking default from `model-defaults.json` on fresh sessions; `settings.json` is only written to drop redundant/stale mirrors, and an explicit local value always wins (`/model-defaults`) |
| `local-history` | Per-turn file `/undo`/`/redo` + `/local-history` status via sidecar before-images next to the session file (no git, no tokens, `edit`/`write` only) |
| `muse-spark-reasoning-fix` | Drops encrypted-reasoning replay for Muse Spark on OpenCode gateways |
| `opencode-client-spoof` | Makes OpenCode Zen free-tier models accept Pi: sends the full OpenCode CLI identity (`User-Agent: opencode/<ver>`, `x-opencode-client`, `x-opencode-session`, `x-opencode-request`, `x-opencode-project`) and adds minimal `glob`/`grep` gate tools (gate checks names only, so no duplicated schemas). `PI_OPENCODE_SPOOF_SCOPE=auto\|all\|free\|off`: `auto` (default) also spoofs paid Zen/Go once the provider is OAuth-authenticated, so one account never flips between the `cli` and `pi` identities the Console logs |
| `opencode-login` | OpenCode credentials with **OAuth as the default**: `/login opencode` (+ `opencode-go`, which adopts the Zen account) runs the `opencode console login` device flow; `/login` still lets you pick "Sign in with an API key". Console OAuth routes requests the way OpenCode does — `/api/config` is captured at login, then `oauth.modifyModels` reprojects the built-in `/zen` catalog onto the account's `inference/openai/v1` endpoint with its `x-opencode-org-id` header and model whitelist (the `/zen` gateway only takes `oc_sk_…`/`sk-…` keys, so a raw OAuth token there is a 401). `/opencode` shows status/OAuth guidance, `/opencode set <key>` explicitly mirrors one API key to Zen + Go (a bare `/opencode <key>` is refused), plus `copy`/`status` |
| `opencode-session-id` | Fills Pi's session id into extension-initiated one-shot completions so OpenCode/Go get the `x-opencode-session` routing header (e.g. custom compaction/handoff calls that bypass the main agent's `streamFn`); `PI_OPENCODE_ZEN_SPOOF=1` opt-in also spoofs Zen with the same full identity headers (UA + `ses_…`/`msg_…` ids + `x-opencode-project`) and the gate tools with `toolChoice:none`, following `opencode-client-spoof`'s `PI_OPENCODE_SPOOF_SCOPE` |
| `pi-upgrade` | `/pi-upgrade [--check\|--offline\|--force]` syncs and rebuilds the local `froooze/pi` source checkout (fetch-and-count, fail-open dep install, post-build staleness guard); checkout located via `PI_UPGRADE_REPO`, `<agentDir>/pi-upgrade.json`, or auto-derived from the running pi (no baked-in path) |
| `prompt-slim` | Trims per-request system-prompt overhead: compacts pi's `<docs>` section and drops bundled tools' `promptGuidelines` bullets that merely restate their description/schema; `/prompt-slim` status, `PI_PROMPT_SLIM=off\|docs\|guidelines` |
| `settings-defaults` | The single applier for every file-backed plugin default. Writes each target in `settings-defaults.json` through one function: Pi `settings.json` (`retry.maxRetries=6` backfill; `compaction.keepRecentTokens=60000`, `tuiMode`, `theme` enforce), `pi-blackhole/pi-blackhole-config.json` (engine/tail/backstop/retained-output/memory), `pi-fff.json` (root/home scanning, env-mirrored). Applies after `/reload`; `/settings-defaults` status |
| `task-notify` | OS desktop notification when a run settles (`agent_settled`, post-retry/compaction): Linux `notify-send` → `gdbus` via the freedesktop D-Bus service (works on X11 **and** Wayland, incl. KDE Plasma/KWin, GNOME, XFCE, sway/dunst), macOS `osascript`, Windows PowerShell WinRT toast. `Aborted` runs stay silent; session name + duration in the body. TUI-only; `PI_TASK_NOTIFY=off` / `PI_NOTIFICATIONS=off` opt-outs; `/notify [status\|test\|on\|off]` (`<agentDir>/task-notify.json`). Position/transparency/colors are daemon-owned, not settable via the API |
| `todo-reconcile` | On `agent_settled`, if the `rpiv-todo` list still has open tasks, injects one follow-up telling the model to finish or reconcile them. TUI-only; aborts, exhausted errors, deferred ops, and headless/subagent/RPC sessions are skipped, one nudge per user turn (`<agentDir>/todo-reconcile.json`) |

## 🧭 Model defaults

The startup model/thinking default is centralized in `model-defaults.json`, so it reaches every machine through the git package instead of living in each `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4.1-flash",
  "defaultThinkingLevel": "low"
}
```

`model-defaults` applies it on a fresh session and never seeds it into `settings.json`. Precedence:

- an explicit local value (e.g. saved with `/model` → Ctrl+S) **always wins**;
- a local value equal to the shared one is removed as redundant;
- a local value equal to the previously propagated shared value (tracked in `<agentDir>/model-defaults.state.json`) is removed as stale, so a centralized update takes effect;
- `--model` / `--provider` / `--thinking` win for that run.

## ⚙️ Settings defaults

Every plugin's file-backed defaults are centralized in `settings-defaults.json`, so they reach every machine through the git package and every target is written by the one shared `applySettingsDefaults` function:

```json
{
  "targets": {
    "settings": {
      "backfill": { "retry.maxRetries": 6 },
      "enforce": {
        "compaction.keepRecentTokens": 60000,
        "tuiMode": "fullscreen",
        "theme": "dark-white-footer"
      }
    },
    "pi-blackhole": {
      "backfill": { "compaction": "auto", "compactionEngine": "blackhole" },
      "enforce": {
        "memory": false,
        "compactAfterTokens": 300000,
        "retainedToolOutputMaxTokens": 29500,
        "tailBehavior": "pi-default"
      }
    },
    "pi-fff": {
      "backfill": { "enableFsRootScanning": false, "enableHomeDirScanning": false },
      "env": {
        "enableFsRootScanning": "FFF_ENABLE_ROOT_SCAN",
        "enableHomeDirScanning": "FFF_ENABLE_HOME_SCAN"
      }
    }
  }
}
```

`settings-defaults` applies each target at session start (Pi caches `settings.json` at startup, so writes apply after `/reload`):

- `backfill` — written only when the leaf is absent, so an explicit local value always wins;
- `enforce` — written whenever the leaf differs, for values that must track the plugin;
- `env` — mirrors a backfilled boolean to an env var (`true`/`false` → `"1"`/`"0"`) only when that var is unset; pi-fff snapshots its config at extension load, so its target is also applied eagerly at import.

Paths are dotted and ids map to fixed files (`settings.json`, `pi-blackhole/pi-blackhole-config.json`, `pi-fff.json`). Missing intermediate objects are created; a malformed local intermediate (e.g. `"retry": "auto"`) is left untouched and reported, never clobbered. `compact-per-model` deliberately keeps its defaults in `shared/compaction.ts` (its file stores only diffs, so seeding it would freeze future default changes); `model-defaults.json` and `model-hotkeys.json` keep their own targeted mechanisms.

## 📦 Bundled extensions

The extensions below ship as pinned npm `dependencies` (auto-resolved on `npm install` after cloning) and are re-exported via the `pi.extensions` manifest. The commit pins in `package.json` are the source of truth; `npm run test:pins` fails if this table drifts from them.

| Extension | Version | What it does |
|-----------|---------|--------------|
| [`@ff-labs/pi-fff`](https://github.com/froooze/fff/tree/pi-fff-only) (fork split of [`dmtrKovalenko/fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff)) | `froooze/fff#18ac372` | FFF-powered fuzzy file/content search; overrides built-in `find`/`grep`, `@`-mention autocomplete, `--fff-*` CLI flags |
| [`@juicesharp/rpiv-todo`](https://github.com/froooze/rpiv-mono/tree/rpiv-todo-only) (fork split of [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)) | `froooze/rpiv-mono#97dfbc5` | `todo` tool + `/todos` command with a live overlay that survives `/reload` and compaction |
| [`pi-blackhole`](https://github.com/froooze/pi-blackhole) (fork of [`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole)) | `froooze/pi-blackhole#0d1c5da` | Deterministic `/blackhole` compaction + observational memory (`/blackhole-memory`, `/blackhole-recall`, `recall` tool); replaces LLM `/compact` |

To load only a subset, filter in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/froooze/pi-plugins",
      "extensions": ["extensions/*.ts"],
      "themes": ["+themes/dark-white-footer.json"]
    }
  ]
}
```

## 🎨 Theme: `dark-white-footer`

Copy of the live `~/.pi/agent/themes/dark-white-footer.json`. Select it via `/settings`
or in `settings.json`:

```json
{
  "theme": "dark-white-footer"
}
```

## 🛠️ Develop

Fork this repo to build your own collection, then:

1. Edit/add files locally (`extensions/*.ts`, `skills/*/SKILL.md`, `prompts/*.md`, `themes/*.json`).
2. Test live: copy to `~/.pi/agent/extensions/` or point `pi` at the file:
   ```bash
   pi -e ./extensions/model-hotkeys.ts
   ```
3. Hot-reload a running session with `/reload`.
4. Push to `main` — unpinned installs track latest. Optional: `git tag v1 && git push --tags`.

## 💖 Support

If you sign up for [Opencode](https://opencode.ai/go?ref=43N85PD5D7), please consider using my referral link — it helps fund ongoing development at no extra cost to you:

👉 https://opencode.ai/go?ref=43N85PD5D7

## 📄 License

MIT
