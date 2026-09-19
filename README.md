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
| `blackhole-defaults` | Backfills preferred and enforces fixed pi-blackhole settings in the global config (blackhole engine; 299k backstop, 24.9k retained tool output, memory off); warns when project config/env shadows them |
| `colored-footer` | Per-stat colored footer; extension statuses (e.g. 🗜) render inline |
| `compact-per-model` | Per-model auto-compact thresholds (249k, luna 90% ≈ 245k) below blackhole's 299k backstop on settled runs; blackhole stays the engine |
| `fff-guard` | Confines FFF indexing to the project cwd (never `/`/`$HOME`); fail-fast with rg/fd fallback hints |
| `fullscreen-mode` | Enforces fullscreen TUI + `dark-white-footer` theme |
| `model-hotkeys` | Alt+1…4 model switching (`/model-hotkeys`); bindings in `model-hotkeys.json` |
| `local-history` | Per-turn file `/undo`/`/redo` + `/local-history` status via sidecar before-images next to the session file (no git, no tokens, `edit`/`write` only) |
| `muse-spark-reasoning-fix` | Drops encrypted-reasoning replay for Muse Spark on OpenCode gateways |
| `opencode-client-spoof` | Makes OpenCode Zen free-tier models accept Pi: spoofs `User-Agent`/session id and adds the `glob`/`grep` tool names Zen's client gate requires |
| `opencode-login` | Unified `/opencode` entry: saves one API key to Zen + Go (mirrored), `copy`/`status`, clipboard copy |
| `pi-upgrade` | `/pi-upgrade [--check\|--offline\|--force]` syncs and rebuilds the local `froooze/pi` source checkout (fetch-and-count, fail-open dep install, post-build staleness guard) |

## 📦 Bundled extensions

The extensions below ship as pinned npm `dependencies` (auto-resolved on `npm install` after cloning) and are re-exported via the `pi.extensions` manifest. The commit pins in `package.json` are the source of truth; `npm run test:pins` fails if this table drifts from them.

| Extension | Version | What it does |
|-----------|---------|--------------|
| [`@ff-labs/pi-fff`](https://github.com/froooze/fff/tree/pi-fff-only) (fork split of [`dmtrKovalenko/fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff)) | `froooze/fff#18ac372` | FFF-powered fuzzy file/content search; overrides built-in `find`/`grep`, `@`-mention autocomplete, `--fff-*` CLI flags |
| [`@juicesharp/rpiv-todo`](https://github.com/froooze/rpiv-mono/tree/rpiv-todo-only) (fork split of [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)) | `froooze/rpiv-mono#1b176e4` | `todo` tool + `/todos` command with a live overlay that survives `/reload` and compaction |
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
