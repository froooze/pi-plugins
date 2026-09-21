/**
 * fff-guard - never let FFF index `/` or `$HOME`; only the project cwd.
 *
 * pi-fff indexes `ctx.cwd` on session_start. When pi is launched from the
 * filesystem root or the home directory that means a full `/` or `$HOME`
 * walk (the "(fff): Your cwd (/) is too large" warning), plus aux pickers
 * for absolute `path:` constraints outside the workspace can do the same.
 *
 * Root scanning is already off by default in pi-fff; home scanning defaults
 * to ON, so a bare `pi` from `~` (or a `path: /...` / `path: ~/...` tool
 * call) kicks off the heavy index. Those defaults live in the `pi-fff`
 * target of the repo-versioned `settings-defaults.json`, applied by the
 * `settings-defaults` extension (eagerly at import, before the bundled
 * pi-fff extension snapshots its file, and re-checked on session_start).
 *
 * This extension keeps only the guard behavior: it warns when the current
 * cwd itself is `/` or `$HOME`, where FFF tools fail fast instead of
 * indexing — the fix is to `cd` into the project and run pi there.
 *
 * Finally, a `tool_result` hook catches FFF's fail-fast refusal
 * (`Failed to create FFF file picker ... Refusing to index ...`) and
 * appends a retry hint pointing the model at `bash` with `rg`/`fd`
 * (or the builtin `grep`/`find` tools when not in FFF override mode),
 * which handle absolute outside-workspace paths without an index.
 */
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isFsRoot(dir: string): boolean {
	const resolved = resolve(dir);
	return parse(resolved).root === resolved;
}

function isHomeDir(dir: string): boolean {
	return resolve(dir) === resolve(homedir());
}

// Tool names pi-fff registers per mode (index.ts: FFF_TOOL_NAMES vs
// OVERRIDE_TOOL_NAMES). In `override` mode the FFF tools shadow the
// builtins under the same `grep`/`find` names — the refusal text check
// below is what distinguishes an FFF failure from a builtin one.
const FFF_TOOL_NAMES = new Set([
	"ffgrep",
	"fffind",
	"fff-multi-grep",
	"grep",
	"find",
	"multi_grep",
]);

const REFUSAL_RE = /Refusing to index|Failed to create FFF file picker/i;

function toolResultText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function refusalHint(toolName: string, input: Record<string, unknown>, cwd?: string): string {
	// No `path` param means the main cwd picker refused (pi launched from
	// `/` or `~`), or a multi_grep `constraints`-only call did — show the
	// cwd so the hint names the real directory.
	const rawPath =
		typeof input.path === "string" && input.path.trim() !== ""
			? input.path.trim()
			: (cwd ?? ".");
	const quotedPath = shellQuote(rawPath);
	if (toolName.toLowerCase().includes("grep")) {
		const patterns: string[] = Array.isArray(input.patterns)
			? (input.patterns as unknown[]).filter((p): p is string => typeof p === "string")
			: typeof input.pattern === "string"
				? [input.pattern as string]
				: [];
		const pattern = patterns[0] ?? "<pattern>";
		const more =
			patterns.length > 1 ? ` (all of: ${patterns.map((p) => `"${p}"`).join(", ")})` : "";
		return (
			`[fff-guard: FFF refused to index ${rawPath} — scanning of / and $HOME is disabled, ` +
			`so fffind/ffgrep cannot search there. Retry the same search without the index${more} ` +
			`via \`bash\`: \`rg ${shellQuote(pattern)} ${quotedPath}\` ` +
			`(or the builtin \`grep\` tool with pattern ${JSON.stringify(pattern)} + path ${JSON.stringify(rawPath)} ` +
			`when not in FFF override mode).]`
		);
	}
	if (toolName.toLowerCase().includes("find")) {
		const pattern = typeof input.pattern === "string" ? input.pattern : "<glob>";
		return (
			`[fff-guard: FFF refused to index ${rawPath} — scanning of / and $HOME is disabled, ` +
			`so fffind/ffgrep cannot search there. Retry without the index ` +
			`via \`bash\`: \`fd ${shellQuote(pattern)} ${quotedPath}\` ` +
			`(or the builtin \`find\` tool with pattern ${JSON.stringify(pattern)} + path ${JSON.stringify(rawPath)} ` +
			`when not in FFF override mode).]`
		);
	}
	return (
		`[fff-guard: FFF refused to index ${rawPath} — scanning of / and $HOME is disabled. ` +
		`Retry without the index via \`bash\` (\`rg\`/\`fd\`), \`read\`, \`ls\`, ` +
		`or the builtin \`grep\`/\`find\` tools on path ${JSON.stringify(rawPath)} ` +
		`(when not in FFF override mode).]`
	);
}

export default function fffGuard(pi: ExtensionAPI) {
	// Fail-fast refusal -> self-correcting retry hint. Partial patch:
	// only `content` is returned, `details`/`isError`/`usage` pass through.
	// The isError gate matters: pi-fff's refusal is a thrown execute()
	// error (isError true), while a successful builtin grep match whose
	// file contents happen to contain "Refusing to index" arrives with
	// isError false — without the gate we'd misfire on the latter.
	pi.on("tool_result", async (event, ctx) => {
		try {
			if (!FFF_TOOL_NAMES.has(event.toolName)) return;
			if (!event.isError) return;
			const text = toolResultText(
				event.content as Array<{ type: string; text?: string }>,
			);
			if (!REFUSAL_RE.test(text)) return;
			if (/fff-guard: FFF refused to index/.test(text)) return; // already hinted
			const hint = refusalHint(
				event.toolName,
				event.input as Record<string, unknown>,
				(ctx as { cwd?: string } | undefined)?.cwd,
			);
			const first = (event.content as Array<{ type: string; text?: string }>).find(
				(c) => c.type === "text",
			);
			if (!first) return { content: [{ type: "text", text: hint }] };
			return {
				content: [
					...event.content,
					{ type: "text", text: `\n\n${hint}` },
				],
			};
		} catch {
			// Never break tool results; the raw FFF error is still usable.
			return;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Friendly diagnosis: with scanning disabled, launching pi from `/`
		// or `~` makes FFF fail fast ("Refusing to index ..."). Tell the
		// user the actual fix instead of leaving them with a raw init error.
		try {
			if (isFsRoot(ctx.cwd) || isHomeDir(ctx.cwd)) {
				ctx.ui.notify(
					`fff-guard: running from ${ctx.cwd} — FFF indexing of / and $HOME is disabled, so file search is limited here. cd into your project and run pi there for full results.`,
					"warning",
				);
			}
		} catch {
			// Non-fatal; ignore.
		}
	});
}
