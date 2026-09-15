# AGENTS.md

## Git — read-only by default

- Never run git **write** actions on your own: no `commit`, `push`, `force push`,
  `tag`, `publish`, `merge`, `rebase`, `reset`, `checkout`/`switch`/`restore`
  that discards work, `stash`, `branch -D`, or similar.
- Never **ask or suggest** running them either (e.g. no "want me to commit/push this?").
- Read-only commands (`status`, `diff`, `log`, `show`) are always fine.
- Only perform write actions after the user **explicitly** requests them in that session.
