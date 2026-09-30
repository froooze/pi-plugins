# Codemode transport (pi)

How to call ketch's MCP surfaces from a pi `codemode` script, and what changes
about token budgets when you do. Verified live against `ketch mcp serve`
(v0.18.0) and pi 0.99.2's built-in `mcp` + `codemode` extensions, 2026-09-22. The
binary still wins (SKILL.md rule 6).

## What the wiring looks like

With `pi mcp add ketch -- ketch mcp serve` and the default `codemode` exposure,
the six tools are not declared to the model, and since pi 0.99.2 they are not in
the `codemode` description either — not even as a namespace heading. The model
learns about the server from the **`mcp_servers` system prompt section**, one line
per server with how its tools are reached and a one-line summary:

```text
- mcp__ketch (codemode): ketch provides six research and bookmark tools: search (web search), code (grep public OSS repos for real-world usage), …
```

That line is the sign the operator wired ketch. Inside a script the tools are
`tools.mcp__ketch__<surface>`: `search`, `scrape`, `code`, `docs`, `crawl`,
`tag`. Full parameter tables and the CLI↔MCP name mapping are in
`references/surfaces.md`; the arguments are the flags without dashes
(`--max-chars` → `max_chars`, `--no-cache` → `no_cache`).

## Read `structuredContent`, never `content[0].text`

All six tools declare an `outputSchema` and ketch returns **both** a text block
and `structuredContent`. Pi types the resolved value as `CallToolResult<T>`, so
`structuredContent` arrives as a typed object — no `JSON.parse`:

```ts
const r = await tools.mcp__ketch__search({ query: "ketch mcp serve", limit: 5 });
r.structuredContent.results[0].url;   // { title, url, fetched_url, description, content }
```

Verified shapes: `search` and `scrape` → `{ warnings, results: [...] }`
(`search` results carry `title`/`url`/`fetched_url`/`description`/`content`;
`scrape` results carry `url`/`title`/`markdown`); `tag` → `{ tag, entries,
shown, … }`. Treat a missing `structuredContent` as "this build only sends text"
and parse `content[0].text` once, not per call site.

Error handling inside a script:

- `isError: true` **resolves**; it does not throw. Check it before reading
  `structuredContent`, and branch on the `[validation]` / `[not_found]` /
  `[upstream]` / `[precondition]` / `[cancelled]` prefix.
- A batch `scrape` reports per-URL failures inside a successful call: a
  `results[].error` entry, not `isError`. Drop those URLs and name them in the
  synthesis.
- `warnings` on either envelope is a non-fatal diagnostic (a failed tag write,
  an unavailable cache). Research output is still valid.

## Read the server's instructions with `describeNamespace()`

Since 0.99.2 the codemode description no longer carries MCP server
instructions, so the routing table and the error-prefix rules that ketch's
server ships are one call away instead of free:

```ts
const ns = await describeNamespace("mcp__ketch");
// { name, description?, instructions?, tools } — instructions is ketch's own
// routing guidance and error-prefix table; tools lists the six names.
```

Read it once at the start of a session (or when a call fails in a way the
prefix does not explain) instead of re-deriving the rules. `searchTools(query,
{ namespace: "mcp__ketch" })` and `ALL_TOOLS` cover the same ground when you
only need names. Both helpers match the namespace loosely: `mcp__ketch`,
`mcpketch`, and `ketch` all find it.

## Budgets: two different caps

`max_chars` + `trim` still bound **each fetch** — they cap the bytes the server
hands the script and the work JS does on them. Keep them; discipline 2 is
unchanged.

What changes is the **context** budget, which is no longer paid by the tool
call at all. Only what a script emits costs tokens:

- `text(...)` / `console.*` / the top-level `return` value are what the model
  sees; everything else stays in the sandbox.
- `// @options: {"max_output_tokens": 2000}` caps the script's whole output
  (default 10000). Over the cap, the head and tail survive and the full text
  goes to a temp file whose path is reported — which is still context, so set
  the cap you mean.
- `exit()` ends the script early and keeps output and store writes.

So the plan changes shape: fetch more pages with a tighter per-page cap, then
let JS decide what is worth quoting.

## Worked example: fan out, filter in JS, emit five lines

```js
// @options: {"max_output_tokens": 1200}
const QUERIES = ["ketch mcp serve", "ketch bbolt page cache lock", "ketch codemode"];

const searches = await Promise.all(
  QUERIES.map((query) => tools.mcp__ketch__search({ query, limit: 6, tag: "ketch-mcp" })),
);
for (const r of searches) {
  if (r.isError) text(`[search failed] ${r.content?.[0]?.text ?? "unknown"}`);
}

const byUrl = new Map();
for (const r of searches) {
  if (r.isError) continue;
  for (const hit of r.structuredContent?.results ?? []) {
    const key = (hit.fetched_url || hit.url || "").replace(/#.*$/, "");
    const seen = byUrl.get(key);
    if (!seen) byUrl.set(key, { ...hit, sources: 1 });
    else seen.sources += 1;               // rank by how many queries found it
  }
}

const ranked = [...byUrl.values()].sort((a, b) => b.sources - a.sources).slice(0, 5);
store("ketch-mcp", ranked.map((h) => h.url));
return ranked.map((h, i) => `${i + 1}. [${h.sources}x] ${h.title} — ${h.url}\n   ${h.description ?? ""}`);
```

Nothing but those five entries reaches the model; the fan-out, the dedupe and
the ranking happened in the sandbox.

## Worked example: let a classifier model pick what to read

Only when a classifier model is actually available
(`models.getAvailableOfType("classifier")` is non-empty — TypeSafe Jev, or any
chat model on a llama.cpp router). A classifier is cheaper than the main model
precisely because it sees one small JSON state and answers typed questions, so
use it to triage, not to synthesize.

Shape to remember: `models.classify(model, { state, questions })` answers **one
state per call** — `answers` is keyed by question name, and each answer is a
single `{ type, … }` value (`choice` + `probabilities`, `score`, or
`probability`). For a per-candidate verdict, call it once per candidate, at
most four in flight.

```js
// @options: {"max_output_tokens": 1500}
const jev = await models.getModelOfType("classifier", "cloudflare-workers-ai", "typesafe/jev");
if (!jev) return "no classifier model configured — rank in JS instead";

const { results } = (await tools.mcp__ketch__search({ query: "…", limit: 12 })).structuredContent;
const candidates = results.slice(0, 12).map((h) => ({
  url: h.url,
  title: h.title,
  snippet: (h.description ?? h.content ?? "").slice(0, 600),
}));

const questions = {
  authoritative: {
    type: "choice",
    instructions:
      "Judge only what this source is. Pick documentation of the behavior itself over commentary about it.",
    criteria: {
      primary: "Official docs, source code, changelog or issue tracker",
      secondary: "Maintainer or well-known engineer writing from experience",
      weak: "Aggregator, listicle, SEO content, undated mirror",
    },
  },
};

const verdicts = [];
let next = 0;
async function worker() {
  while (next < candidates.length) {
    const candidate = candidates[next++];
    const r = await models.classify(jev, { state: candidate, questions });
    // Provider errors resolve with stopReason "error"/"aborted", they do not throw.
    verdicts.push({
      ...candidate,
      rank: r.stopReason === "stop" ? r.answers?.authoritative?.choice ?? "weak" : "unrated",
    });
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

const keep = verdicts.filter((v) => v.rank !== "weak");
store("triage", verdicts);
text(keep.map((v) => `${v.rank}: ${v.title} — ${v.url}`));
return `${verdicts.length} triaged, ${verdicts.filter((v) => v.rank === "primary").length} primary, ${verdicts.filter((v) => v.rank === "unrated").length} unrated`;
```

`stopReason` is `"stop" | "error" | "aborted"` — test it against `"stop"`, never
for truthiness (`"stop"` is truthy), and read `errorMessage` for the reason. The
per-candidate verdicts go to `store("triage", …)` so a follow-up call can rank or
re-read them without re-searching; the same pattern works over scraped pages
instead of search hits. A `bool` question (`criteria: { true: …, false: … }`,
answer `probability`) is the cheap variant when you only need a yes/no triage.

## Sandbox rules that bite

- Arguments and results make a JSON round trip: no class instances, no `Date`,
  no cycles. Plain objects, arrays, strings, numbers.
- No `fetch`, no timers, no `require`. A promise nothing can settle fails
  immediately, so every `await` needs a tool call or a classifier behind it.
- `tools.mcp__ketch__search` is a valid identifier, so both
  `tools.mcp__ketch__search({…})` and `tools["mcp__ketch__search"]({…})` work.
- **Names are normalized**: `-` in a tool or namespace name becomes `_`
  (`mcp__my-server` → `mcp__myserver`). ketch has no dashes, but a script copied
  from another server's docs may.
- Since 0.99.2 the first prompt does not wait for servers without `direct`
  tools: they connect in the background, and a script waits only when it names
  the namespace or searches tools. So the first script call may block briefly,
  and if the server is still down its tools are simply absent — check
  `pi mcp list` or `/mcp reconnect` before concluding ketch is unavailable.
- `codemode-deferred` is now an alias for `codemode`; the two behave the same,
  and neither lists tools in the codemode description.

## When not to use it

- **Operator actions stay CLI**: `config set`, `ketch config`, `cache`,
  `browser install`, `crawl --background`/`status`/`stop`, `doctor`. They are
  not in MCP by design, so they run through `bash` regardless.
- **One small call needs no script.** With `--exposure direct` the tools are
  declared to the model (and the first prompt waits for the server to connect),
  so a single `search` costs one round trip and needs no discovery step.
  Codemode earns its keep at fan-out, at batch scrapes, and whenever the raw
  result is much larger than the answer.
- **The page-cache tradeoff does not change** (SKILL.md gotchas): a live MCP
  server holds the bbolt lock for the session, so CLI scrapes in the same
  session run uncached and `ketch cache clear` fails. Batch through the server,
  or stay CLI-only.

## Wiring it, if the operator asks

```sh
pi mcp add ketch --description "ketch: web search, OSS code search, library docs, scrape, crawl, tag" -- ketch mcp serve
```

`--description` is worth passing: its first line is what the `mcp_servers`
section shows (up to 250 characters) and it ranks the server's tools in tool
search. Without it pi falls back to the first line of the server's own
instructions, which is decent but tied to the installed binary's wording. Add
`--exposure direct` only if the model should call ketch without a script. Then
`pi mcp list` to confirm, and `/reload` (or a new session) to connect.
