# pi-plugins

Personal [pi](https://github.com/earendil-works/pi-mono) packages by [@froooze](https://github.com/froooze) — extensions, skills, prompt templates, and themes.

Core `pi` fork lives at [`froooze/pi`](https://github.com/froooze/pi) (upstream contributions only). Everything personal lives here so the fork stays clean and easy to rebase.

## Install

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

## Contents

| Dir | What |
|-----|------|
| `extensions/` | TypeScript extensions (`.ts`, auto-discovered), including the per-stat colored footer |
| `skills/` | Agent skills (`*/SKILL.md`) |
| `prompts/` | Prompt templates (`.md`) |
| `themes/` | TUI themes (`.json`) — currently `dark-white-footer` |

## Bundled extensions (git-only, never published to npm)

This package itself is distributed **only via git** (`pi install git:github.com/froooze/pi-plugins`).
It is never published to the npm registry. The third-party extensions below are plain
npm `dependencies` — registry or `froooze` forks (pinned by commit SHA) — they resolve automatically when pi runs
`npm install` after cloning, and are re-exported through the `pi.extensions` manifest:

| Extension | Version | What it does |
|-----------|---------|--------------|
| [`@ff-labs/pi-fff`](https://github.com/froooze/fff/tree/pi-fff-only) (fork split of [`dmtrKovalenko/fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff)) | `froooze/fff#18ac372` | FFF-powered fuzzy file/content search; overrides built-in `find`/`grep`, `@`-mention autocomplete, `--fff-*` CLI flags |
| [`@juicesharp/rpiv-todo`](https://github.com/froooze/rpiv-mono/tree/rpiv-todo-only) (fork split of [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)) | `froooze/rpiv-mono#1b176e4` | `todo` tool + `/todos` command with a live overlay that survives `/reload` and compaction |
| [`@baylarsadigov/omp-undo-redo`](https://github.com/froooze/omp-undo-redo) (fork of [`Baylar55/omp-undo-redo`](https://github.com/Baylar55/omp-undo-redo)) | `froooze/omp-undo-redo#d223fb2` | Session + file `/undo`/`/redo` via Git snapshots (works in non-Git workspaces via private per-workspace repo) |
| [`pi-blackhole`](https://github.com/froooze/pi-blackhole) (fork of [`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole)) | `froooze/pi-blackhole#23e4a07` | Deterministic `/blackhole` compaction + observational memory (`/blackhole-memory`, `/blackhole-recall`, `recall` tool); replaces LLM `/compact` |
| [`pi-subagents-lite`](https://github.com/froooze/pi-subagents-lite) (fork of [`AlexParamonov/pi-subagents-lite`](https://github.com/AlexParamonov/pi-subagents-lite)) | `froooze/pi-subagents-lite#88db683` | Lightweight sub-agents (`Agent`/`StopAgent`/`AgentStatus` tools, `/agents` menu, foreground + background with steering/continuation, worktree support, live widget); schema-first, minimal token overhead |

```json
"pi": {
  "extensions": [
    "./extensions",
    "node_modules/@ff-labs/pi-fff/src/index.ts",
    "node_modules/@juicesharp/rpiv-todo/index.ts",
    "node_modules/@baylarsadigov/omp-undo-redo/dist/index.js",
    "node_modules/pi-blackhole/index.ts",
    "node_modules/pi-subagents-lite/src/index.ts"
  ]
}
```

Installing this package therefore replaces the need to install those extensions
separately. To load only a subset, filter in `~/.pi/agent/settings.json`:

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

## Theme: `dark-white-footer`

Copy of the live `~/.pi/agent/themes/dark-white-footer.json`. Select it via `/settings`
or in `settings.json`:

```json
{
  "theme": "dark-white-footer"
}

## Develop

1. Edit/add files locally.
2. Test live: copy to `~/.pi/agent/extensions/` or point `pi` at the file:
   ```bash
   pi -e ./extensions/model-hotkeys.ts
   ```
3. Hot-reload a running session with `/reload`.
4. Push to `main` — unpinned installs track latest. Optional pinned release: `git tag v1 && git push --tags`, then `pi install git:github.com/froooze/pi-plugins@v1`.

## Add a new extension

Create `extensions/my-thing.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

See [pi extension examples](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/examples/extensions) and [docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).

## License

MIT
