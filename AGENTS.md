# AGENTS.md

## Git — read-only by default

- Never run git **write** actions on your own: `commit`, `push`, `force push`, `tag`, `publish`, `merge`, `rebase`, `reset`, `checkout`/`switch`/`restore` that discards work, `stash`, `branch -D`, or similar.
- Never **ask or suggest** running them either (e.g. "want me to commit/push this?").
- Read-only commands (`status`, `diff`, `log`, `show`) are always fine.
- Perform write actions only after the user **explicitly** requests them in that session.

## Bundled extension bumps

The three bundled extensions (`@ff-labs/pi-fff`, `@juicesharp/rpiv-todo`, `pi-blackhole`) are pinned as exact-commit GitHub tarballs in `package.json`. `pi update --extensions` does **not** discover newer commits of these forks — it installs only the pinned commit. Bumping moves the pin here and pushes; `pi update --extensions` then re-clones, wipes `node_modules/`, and runs `npm install`.

A bump touches **four** places — miss one and docs/installs drift:

1. `package.json` → `dependencies.<name>` tarball URL (new commit hash).
2. `package-lock.json` → `resolved` + `integrity` (regenerate via `npm install`).
3. `package.json` → `allowScripts` entry `<name>@<new-version>`, if present.
4. `README.md` → `Version` cell of the `Bundled extensions` table (`owner/repo#shorthash`).

`test/pins.test.ts` enforces 1/3/4 against 2. Run it via `npm run test:pins` (part of `npm test`); it fails loudly on a stale README hash, a repo mismatch, or an `allowScripts` version mismatch. Never hand-edit only `package.json`: after any bump, run `npm test` before pushing.
