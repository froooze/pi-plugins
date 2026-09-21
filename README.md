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
| `blackhole-defaults` | Backfills preferred and enforces fixed pi-blackhole settings in the global config (blackhole engine, `tailBehavior: pi-default`, 300k backstop, 29.5k retained tool output, 60k Pi `keepRecentTokens`, memory off); warns when project config/env/model overrides shadow them |
| `colored-footer` | Per-stat colored footer; extension statuses (e.g. 🗜) render inline |
| `compact-per-model` | Per-model auto-compact thresholds (249k, luna 85% ≈ 230k) below blackhole's 300k backstop on settled runs; blackhole stays the engine |
| `fff-guard` | Confines FFF indexing to the project cwd (never `/`/`$HOME`); fail-fast with rg/fd fallback hints |
| `fullscreen-mode` | Enforces fullscreen TUI + `dark-white-footer` theme |
| `model-hotkeys` | Alt+1…4 model switching (`/model-hotkeys`); bindings in `model-hotkeys.json` |
| `model-defaults` | Applies the repo-versioned startup model/thinking default from `model-defaults.json` on fresh sessions; `settings.json` is only written to drop redundant/stale mirrors, and an explicit local value always wins (`/model-defaults`) |
| `local-history` | Per-turn file `/undo`/`/redo` + `/local-history` status via sidecar before-images next to the session file (no git, no tokens, `edit`/`write` only) |
| `muse-spark-reasoning-fix` | Drops encrypted-reasoning replay for Muse Spark on OpenCode gateways |
| `opencode-client-spoof` | Makes OpenCode Zen free-tier models accept Pi: sends the full OpenCode CLI identity (`User-Agent: opencode/<ver>`, `x-opencode-client`, `x-opencode-session`, `x-opencode-request`, `x-opencode-project`) and adds minimal `glob`/`grep` gate tools (gate checks names only, so no duplicated schemas). `PI_OPENCODE_SPOOF_SCOPE=auto\|all\|free\|off`: `auto` (default) also spoofs paid Zen/Go once the provider is OAuth-authenticated, so one account never flips between the `cli` and `pi` identities the Console logs |
| `opencode-login` | OpenCode credentials with **OAuth as the default**: `/login opencode` (+ `opencode-go`, which adopts the Zen account) runs the `opencode console login` device flow; `/login` still lets you pick "Sign in with an API key". Console OAuth routes requests the way OpenCode does — `/api/config` is captured at login, then `oauth.modifyModels` reprojects the built-in `/zen` catalog onto the account's `inference/openai/v1` endpoint with its `x-opencode-org-id` header and model whitelist (the `/zen` gateway only takes `oc_sk_…`/`sk-…` keys, so a raw OAuth token there is a 401). `/opencode` shows status/OAuth guidance, `/opencode set <key>` explicitly mirrors one API key to Zen + Go (a bare `/opencode <key>` is refused), plus `copy`/`status` |
| `opencode-session-id` | Fills Pi's session id into extension-initiated one-shot completions so OpenCode/Go get the `x-opencode-session` routing header (fixes `/btw`'s `400 MissingSessionID`); `PI_OPENCODE_ZEN_SPOOF=1` opt-in also spoofs Zen with the same full identity headers (UA + `ses_…`/`msg_…` ids + `x-opencode-project`) and the gate tools with `toolChoice:none`, following `opencode-client-spoof`'s `PI_OPENCODE_SPOOF_SCOPE` |
| `pi-upgrade` | `/pi-upgrade [--check\|--offline\|--force]` syncs and rebuilds the local `froooze/pi` source checkout (fetch-and-count, fail-open dep install, post-build staleness guard); checkout located via `PI_UPGRADE_REPO`, `<agentDir>/pi-upgrade.json`, or auto-derived from the running pi (no baked-in path) |
| `prompt-slim` | Trims per-request system-prompt overhead: compacts pi's `<docs>` section and drops bundled tools' `promptGuidelines` bullets that merely restate their description/schema; `/prompt-slim` status, `PI_PROMPT_SLIM=off\|docs\|guidelines` |
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

## 📦 Bundled extensions

The extensions below ship as pinned npm `dependencies` (auto-resolved on `npm install` after cloning) and are re-exported via the `pi.extensions` manifest. The commit pins in `package.json` are the source of truth; `npm run test:pins` fails if this table drifts from them.

| Extension | Version | What it does |
|-----------|---------|--------------|
| [`@ff-labs/pi-fff`](https://github.com/froooze/fff/tree/pi-fff-only) (fork split of [`dmtrKovalenko/fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff)) | `froooze/fff#18ac372` | FFF-powered fuzzy file/content search; overrides built-in `find`/`grep`, `@`-mention autocomplete, `--fff-*` CLI flags |
| [`@juicesharp/rpiv-btw`](https://github.com/froooze/rpiv-mono/tree/rpiv-btw-only) (fork split of [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-btw)) | `froooze/rpiv-mono#6215d19` | `/btw <question>` side question answered by the same model in an ephemeral bottom overlay — read-only clone of the current branch, no tools, no disk, never enters the transcript |
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
