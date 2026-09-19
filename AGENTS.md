# AGENTS.md

## Git — read-only by default

- Never run git **write** actions on your own: no `commit`, `push`, `force push`,
  `tag`, `publish`, `merge`, `rebase`, `reset`, `checkout`/`switch`/`restore`
  that discards work, `stash`, `branch -D`, or similar.
- Never **ask or suggest** running them either (e.g. no "want me to commit/push this?").
- Read-only commands (`status`, `diff`, `log`, `show`) are always fine.
- Only perform write actions after the user **explicitly** requests them in that session.

## Bundled extension bumps

The three bundled extensions (`@ff-labs/pi-fff`, `@juicesharp/rpiv-todo`,
`pi-blackhole`) are pinned in `package.json` as GitHub archive tarballs at an
exact commit. `pi update --extensions` does **not** discover newer commits of
these forks — it only installs the commit pinned here. Bumping requires moving
the pin in this repo and pushing, after which `pi update --extensions` re-clones,
wipes `node_modules/`, and runs `npm install`.

A bump touches **four** places; miss one and the docs/installs drift:

1. `package.json` → `dependencies.<name>` tarball URL (new commit hash).
2. `package-lock.json` → `resolved` + `integrity` for the dependency (regenerate via `npm install`).
3. `package.json` → `allowScripts` entry `<name>@<new-version>` when it exists.
4. `README.md` → the `Version` cell of the `## 📦 Bundled extensions` table (`owner/repo#shorthash`).

`test/pins.test.ts` enforces 1/3/4 against 2. Run it directly with
`npm run test:pins` (also part of `npm test`); it fails loudly on a stale README
hash, a repo mismatch, or an `allowScripts` version mismatch.

Guard against future drift by never hand-editing only `package.json`: after any
bump, run `npm test` before pushing.
