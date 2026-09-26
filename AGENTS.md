# AGENTS.md

## Git — read-only by default

- Never run git **write** actions on your own: `commit`, `push`, `force push`, `tag`, `publish`, `merge`, `rebase`, `reset`, `checkout`/`switch`/`restore` that discards work, `stash`, `branch -D`, or similar.
- Never **ask or suggest** running them either (e.g. "want me to commit/push this?").
- Read-only commands (`status`, `diff`, `log`, `show`) are always fine.
- Perform write actions only after the user **explicitly** requests them in that session.

## Bundled extension bumps

The three bundled extensions (`@ff-labs/pi-fff`, `@juicesharp/rpiv-todo`, `pi-blackhole`) are pinned as exact-commit GitHub tarballs in `package.json`. (`/btw` is now an own extension — `extensions/btw.ts` — and `@juicesharp/rpiv-btw` is no longer pinned or loaded.) `pi update --extensions` does **not** discover newer commits of these forks — it installs only the pinned commit. Bumping moves the pin here and pushes; `pi update --extensions` then re-clones, wipes `node_modules/`, and runs `npm install`.

A bump touches **four** places — miss one and docs/installs drift:

1. `package.json` → `dependencies.<name>` tarball URL (new commit hash).
2. `package-lock.json` → `resolved` + `integrity` (regenerate via `npm install`).
3. `package.json` → `allowScripts` entry `<name>@<new-version>`, if present.
4. `README.md` → `Version` cell of the `Bundled extensions` table (`owner/repo#shorthash`).

`test/pins.test.ts` enforces 1/3/4 against 2. Run it via `npm run test:pins` (part of `npm test`); it fails loudly on a stale README hash, a repo mismatch, or an `allowScripts` version mismatch. Never hand-edit only `package.json`: after any bump, run `npm test` before pushing.

`/pi-upgrade` separately queries each fork's branch head and advances the *installed* checkout's pins directly (`extensions/shared/bundle-pins.ts`), because `pi update --extensions` installs only the pinned commit. That keeps a machine current between repo bumps; the four places above remain the source of truth for other machines.

### Fork splits

`@ff-labs/pi-fff` and `pi-blackhole` live in their own repos. `@juicesharp/rpiv-todo`
is a fork split of the `juicesharp/rpiv-mono` monorepo, hosted as a **per-package
branch** in `froooze/rpiv-mono`:

| Package | Upstream subtree | Fork branch |
|---|---|---|
| `@juicesharp/rpiv-todo` | `juicesharp/rpiv-mono` → `packages/rpiv-todo` | `rpiv-todo-only` |

Each branch is the output of `git subtree split -P <prefix>`: the package at repo root
with its subtree-filtered history (only commits that touched the package). The branch
carries every package file, tests and docs included — GitHub archive tarballs ignore
the package `files` filter. npm cannot install an archive tarball from a subdirectory,
so one branch per package is required.

Use `scripts/fork-split.mjs` to build and push a split; it fast-forwards when the new
history descends from the remote branch and otherwise uses `--force-with-lease`.
Refresh the branch from the upstream commit you want to snapshot:

```
node scripts/fork-split.mjs --package packages/rpiv-todo --branch rpiv-todo-only --ref <upstream-ref>
```

Then pin the printed commit and follow the four-place bump above.
