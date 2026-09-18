/**
 * local-history - cheap per-turn file undo/redo with zero token cost.
 *
 * Records a before-image of every file touched by the `edit`/`write` tools
 * (captured on `tool_call`, sealed on `agent_settled` — once per prompt,
 * after retries, compactions, and queued continuations finish) into a
 * sidecar directory next to the session file:
 *
 *   `<sessionDir>/local-history/<sessionId>/`
 *
 * `/undo` restores the files and rewinds the conversation through native
 * `/tree` navigation (`navigateTree` with no summary, so no LLM tokens are
 * spent); `/redo` steps forward again. `/local-history` shows status.
 *
 * Design constraints (deliberately simpler than omp-undo-redo):
 * - No git: no spawns, no refs in the user's repo, no `~/.omp` store,
 *   no background timers, no gc. Everything is plain files + `node:fs`.
 * - Zero tokens: snapshots live in the sidecar, never as session entries,
 *   so nothing is appended to the conversation or sent to the model.
 * - `bash`/shell side-effects are NOT tracked. Use git for those.
 * - Binary-safe: before-images are raw buffers, never decoded.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const HISTORY_DIR_NAME = "local-history";
const INDEX_FILE = "index.json";
const INDEX_VERSION = 1;

/** How many sealed turns are kept per session (undo depth). */
const MAX_TURNS = 50;
/** Total sidecar bytes per session (undo + redo backups) before oldest-first eviction. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** Files larger than this are tracked for conversation-only (no file restore). */
const MAX_FILE_BYTES = 1024 * 1024;
/** Sidecar dirs older than this with no matching session file are pruned on start. */
const ORPHAN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Dependency/VCS dirs inside the workspace are never snapshotted. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".hg", ".svn"]);

/** Minimal structural view of a session entry (no pi import needed). */
export interface PromptBranchEntry {
	id: string;
	type: string;
	message?: { role?: string };
}

/** A prompt entry is what `/tree` treats as a rewind point. */
export function isPromptEntry(entry: PromptBranchEntry): boolean {
	if (entry.type === "custom_message") return true;
	return entry.type === "message" && entry.message?.role === "user";
}

/**
 * Nearest prompt id at or before `fromId` (defaults to the leaf end).
 * Branch order is root -> leaf, as returned by `getBranch()`.
 */
export function findPrevPromptId(
	branch: PromptBranchEntry[],
	fromId?: string | null,
): string | null {
	let start = branch.length - 1;
	if (fromId !== undefined && fromId !== null) {
		const idx = branch.findIndex((entry) => entry.id === fromId);
		if (idx < 0) return null;
		start = idx;
	}
	for (let index = start; index >= 0; index--) {
		if (isPromptEntry(branch[index])) return branch[index].id;
	}
	return null;
}

/**
 * First prompt strictly after `afterId` (branch order is root -> leaf).
 * Null when `afterId` is unknown or nothing prompt-like follows it.
 */
export function findNextPromptId(branch: PromptBranchEntry[], afterId: string): string | null {
	const idx = branch.findIndex((entry) => entry.id === afterId);
	if (idx < 0) return null;
	for (let index = idx + 1; index < branch.length; index++) {
		if (isPromptEntry(branch[index])) return branch[index].id;
	}
	return null;
}

/**
 * Anchor for the backstop seal: leftover captures belong to the run whose
 * prompt comes first after the last sealed leaf. Falls back to the newest
 * prompt when the sealed leaf is unknown (no seal yet this process).
 * Never walks from the leaf end directly: the next run's user message may
 * already be in the branch, and it belongs to the next step, not this one.
 */
export function resolveBackstopAnchor(
	branch: PromptBranchEntry[],
	lastEndLeaf: string | null,
): string | null {
	if (lastEndLeaf) {
		const next = findNextPromptId(branch, lastEndLeaf);
		if (next) return next;
	}
	return findPrevPromptId(branch);
}

/**
 * Last non-prompt entry id from the leaf end (branch order is root -> leaf).
 * Null when the branch holds prompts only. Pins the backstop seal's end leaf:
 * at `before_agent_start` the leaf may already be the new user message, and
 * redo-navigating to a prompt entry would land on its parent instead.
 */
export function findLastNonPromptId(branch: PromptBranchEntry[]): string | null {
	for (let index = branch.length - 1; index >= 0; index--) {
		if (!isPromptEntry(branch[index])) return branch[index].id;
	}
	return null;
}

/** Resolve a tool `path` arg against the workspace cwd. Null when unusable. */
export function resolveToolPath(cwd: string, inputPath: unknown): string | null {
	if (typeof inputPath !== "string" || inputPath.trim() === "") return null;
	return resolve(cwd, inputPath);
}

/** True for paths we deliberately never snapshot (dependency/VCS dirs, at any depth). */
export function isSkippedPath(cwd: string, absPath: string): boolean {
	const rel = relative(cwd, absPath);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return false;
	return rel.split(sep).some((part) => SKIP_DIR_NAMES.has(part));
}

export interface StoredFile {
	/** Absolute workspace path. */
	path: string;
	/** Backup file name inside the session sidecar dir (null = file did not exist or was skipped). */
	backup: string | null;
	/** Whether the file existed when captured. */
	existed: boolean;
	/** Backup byte size (0 when no backup). */
	bytes: number;
}

export interface StoredTurn {
	id: string;
	userMsgId: string | null;
	endLeafId: string | null;
	sealedAt: string;
	files: StoredFile[];
	/** Absolute paths that changed but were too large to snapshot. */
	skipped: string[];
}

export interface StoredIndex {
	version: number;
	undo: StoredTurn[];
	redo: StoredTurn[];
}

export interface HistoryCaps {
	maxTurns: number;
	maxBytes: number;
}

export function emptyIndex(): StoredIndex {
	return { version: INDEX_VERSION, undo: [], redo: [] };
}

function isStoredFile(value: unknown): value is StoredFile {
	if (!value || typeof value !== "object") return false;
	const f = value as StoredFile;
	return (
		typeof f.path === "string" &&
		(f.backup === null || typeof f.backup === "string") &&
		typeof f.existed === "boolean" &&
		typeof f.bytes === "number"
	);
}

function cleanTurn(turn: unknown): StoredTurn | null {
	if (!turn || typeof turn !== "object") return null;
	const t = turn as Partial<StoredTurn>;
	if (typeof t.id !== "string" || !Array.isArray(t.files)) return null;
	if (!t.files.every(isStoredFile)) return null;
	return {
		id: t.id,
		userMsgId: typeof t.userMsgId === "string" ? t.userMsgId : null,
		endLeafId: typeof t.endLeafId === "string" ? t.endLeafId : null,
		sealedAt: typeof t.sealedAt === "string" ? t.sealedAt : "",
		files: t.files,
		skipped: Array.isArray(t.skipped) ? t.skipped.filter((s): s is string => typeof s === "string") : [],
	};
}

/** Parse persisted index; any corruption yields a fresh index (never throws). */
export function parseIndex(raw: string): StoredIndex {
	try {
		const value = JSON.parse(raw) as Partial<StoredIndex>;
		if (!value || typeof value !== "object" || value.version !== INDEX_VERSION) {
			return emptyIndex();
		}
		if (!Array.isArray(value.undo) || !Array.isArray(value.redo)) return emptyIndex();
		return {
			version: INDEX_VERSION,
			undo: value.undo.map(cleanTurn).filter((t): t is StoredTurn => t !== null),
			redo: value.redo.map(cleanTurn).filter((t): t is StoredTurn => t !== null),
		};
	} catch {
		return emptyIndex();
	}
}

async function rmForce(path: string): Promise<void> {
	await fs.rm(path, { force: true }).catch(() => undefined);
}

/** Atomic JSON write (tmp + rename) so readers never see a partial index. */
async function writeJsonAtomic(path: string, value: StoredIndex): Promise<void> {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		await fs.writeFile(tmp, JSON.stringify(value), "utf8");
		await fs.rename(tmp, path);
	} finally {
		await rmForce(tmp);
	}
}

/**
 * Crash-safe file write: tmp in the same directory + rename, so a crash
 * mid-restore never leaves a truncated file (this may be the user's only copy).
 */
async function writeFileAtomicSameDir(path: string, content: Buffer): Promise<void> {
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(tmp, content);
		await fs.rename(tmp, path);
	} finally {
		await rmForce(tmp);
	}
}

interface PendingCapture {
	existed: boolean;
	backup: string | null;
	bytes: number;
}

/** Per-session undo/redo state. Backups live on disk; stacks live here + index.json. */
export class SessionHistory {
	readonly dir: string;
	readonly caps: HistoryCaps;
	undo: StoredTurn[] = [];
	redo: StoredTurn[] = [];
	private pending = new Map<string, PendingCapture>();
	private dirty = new Set<string>();
	private skippedPaths = new Set<string>();

	constructor(dir: string, caps: Partial<HistoryCaps> = {}) {
		this.dir = dir;
		this.caps = {
			maxTurns: caps.maxTurns ?? MAX_TURNS,
			maxBytes: caps.maxBytes ?? MAX_TOTAL_BYTES,
		};
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	byteTotal(): number {
		let total = 0;
		for (const turn of [...this.undo, ...this.redo]) {
			for (const file of turn.files) total += file.bytes;
		}
		return total;
	}

	async load(): Promise<void> {
		const raw = await fs.readFile(join(this.dir, INDEX_FILE), "utf8").catch(() => null);
		if (raw === null) return;
		const index = parseIndex(raw);
		this.undo = index.undo;
		this.redo = index.redo;
	}

	async persist(): Promise<void> {
		try {
			await fs.mkdir(this.dir, { recursive: true });
			await writeJsonAtomic(join(this.dir, INDEX_FILE), {
				version: INDEX_VERSION,
				undo: this.undo,
				redo: this.redo,
			});
		} catch {
			// Best effort: in-memory stacks still work for this process.
		}
	}

	/**
	 * Capture the before-image of a file about to be written.
	 * First capture per run wins; oversized/unreadable files are recorded
	 * as skipped (surfaced in the undo notice, never silently dropped).
	 */
	async captureBefore(absPath: string): Promise<"captured" | "created" | "skipped"> {
		const existing = this.pending.get(absPath);
		if (existing) {
			return existing.backup ? "captured" : existing.existed ? "skipped" : "created";
		}
		let content: Buffer | null = null;
		try {
			content = await fs.readFile(absPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				// Absent: recorded as a creation below.
			} else {
				// Unreadable is not absent: track as existed-but-unsnapshotted
				// so the step warns instead of silently leaving it unrestored.
				this.pending.set(absPath, { existed: true, backup: null, bytes: 0 });
				this.skippedPaths.add(absPath);
				return "skipped";
			}
		}
		if (content === null) {
			this.pending.set(absPath, { existed: false, backup: null, bytes: 0 });
			return "created";
		}
		if (content.length > MAX_FILE_BYTES) {
			this.pending.set(absPath, { existed: true, backup: null, bytes: 0 });
			this.skippedPaths.add(absPath);
			return "skipped";
		}
		// Random backup name: the sidecar survives process restarts, so a
		// counter would collide with (and overwrite) backups from a previous run.
		const backup = `bk-${randomUUID()}.bak`;
		try {
			await fs.mkdir(this.dir, { recursive: true });
			await fs.writeFile(join(this.dir, backup), content);
		} catch {
			this.pending.set(absPath, { existed: true, backup: null, bytes: 0 });
			this.skippedPaths.add(absPath);
			return "skipped";
		}
		this.pending.set(absPath, { existed: true, backup, bytes: content.length });
		return "captured";
	}

	/** Drop a pending capture (tool failed, file unchanged). */
	async dropPending(absPath: string): Promise<void> {
		const capture = this.pending.get(absPath);
		if (!capture) return;
		this.pending.delete(absPath);
		this.dirty.delete(absPath);
		this.skippedPaths.delete(absPath);
		if (capture.backup) await rmForce(join(this.dir, capture.backup));
	}

	markDirty(absPath: string): void {
		if (this.pending.has(absPath)) this.dirty.add(absPath);
	}

	/**
	 * Backup names still owned by unsealed captures. Sweeps must keep them:
	 * a sweep running between capture and seal (or in another process
	 * sharing the dir) must not delete a live pending backup.
	 */
	pendingBackupNames(): Set<string> {
		const names = new Set<string>();
		for (const capture of this.pending.values()) {
			if (capture.backup) names.add(capture.backup);
		}
		return names;
	}

	/**
	 * Seal one undo step for the finished agent run. Runs without file writes
	 * still seal (conversation-only step) so prompt history stays 1:1 steppable.
	 * Sealing a new run clears the redo stack, like any history model.
	 */
	async seal(userMsgId: string | null, endLeafId: string | null): Promise<StoredTurn> {
		const files: StoredFile[] = [];
		for (const [absPath, capture] of this.pending) {
			if (this.dirty.has(absPath)) {
				files.push({
					path: absPath,
					backup: capture.backup,
					existed: capture.existed,
					bytes: capture.bytes,
				});
			} else if (capture.backup) {
				await rmForce(join(this.dir, capture.backup));
			}
		}
		this.pending.clear();
		this.dirty.clear();
		const skipped = [...this.skippedPaths].filter((p) =>
			files.some((f) => f.path === p && f.backup === null && f.existed),
		);
		this.skippedPaths.clear();
		const turn: StoredTurn = {
			id: `t-${randomUUID()}`,
			userMsgId,
			endLeafId,
			sealedAt: new Date().toISOString(),
			files,
			skipped,
		};
		this.undo.push(turn);
		await this.discardRedoFiles();
		this.redo = [];
		await this.enforceCaps();
		await this.persist();
		return turn;
	}

	/** Pop an undo step; the caller restores `turn.files` then pushes the redo record. */
	popUndo(): StoredTurn | undefined {
		return this.undo.pop();
	}

	popRedo(): StoredTurn | undefined {
		return this.redo.pop();
	}

	pushRedo(turn: StoredTurn): void {
		this.redo.push(turn);
	}

	pushUndo(turn: StoredTurn): void {
		this.undo.push(turn);
	}

	async clearRedo(): Promise<void> {
		if (this.redo.length === 0) return;
		await this.discardRedoFiles();
		this.redo = [];
		await this.persist();
	}

	private async discardRedoFiles(): Promise<void> {
		const backups: string[] = [];
		for (const turn of this.redo) {
			for (const file of turn.files) {
				if (file.backup) backups.push(join(this.dir, file.backup));
			}
		}
		await Promise.all(backups.map(rmForce));
	}

	private async discardTurnFiles(turns: StoredTurn[]): Promise<void> {
		await Promise.all(
			turns.flatMap((turn) =>
				turn.files.filter((f) => f.backup).map((f) => rmForce(join(this.dir, f.backup as string))),
			),
		);
	}

	/** Oldest-first eviction; deletes backup files of evicted turns. */
	async enforceCaps(): Promise<void> {
		while (this.undo.length > this.caps.maxTurns) {
			const evicted = this.undo.shift();
			if (!evicted) break;
			await this.discardTurnFiles([evicted]);
		}
		if (this.redo.length > this.caps.maxTurns) {
			const drop = this.redo.splice(0, this.redo.length - this.caps.maxTurns);
			await this.discardTurnFiles(drop);
		}
		// Byte cap spans undo + redo (cached total, decremented on evict).
		// Redo evicts from the head: redo[0] is the first-undone (= farthest-forward)
		// step, so dropping it keeps the remaining chain contiguous from the
		// current position. Popping the tail would drop the nearest-forward step
		// and leave a gap (the surviving far step's snapshots assume the dropped
		// step's state). Same reason the maxTurns trim above splices from the head.
		let total = this.byteTotal();
		while (total > this.caps.maxBytes && (this.undo.length > 0 || this.redo.length > 0)) {
			const evicted = this.undo.length > 0 ? this.undo.shift() : this.redo.shift();
			if (!evicted) break;
			total -= evicted.files.reduce((sum, file) => sum + file.bytes, 0);
			await this.discardTurnFiles([evicted]);
		}
	}
}

export function historyRootFor(sessionDir: string): string {
	return join(sessionDir, HISTORY_DIR_NAME);
}

export function sessionDirFor(sessionId: string, sessionDir: string): string {
	return join(historyRootFor(sessionDir), sessionId);
}

/**
 * Best-effort orphan sweep: sidecar dirs with no matching session file and old mtime.
 * Session files are named `<timestamp>_<sessionId>.jsonl`, sidecars `<sessionId>`.
 */
/**
 * Seal-time sweep: delete `bk-*`/`rd-*` backups no undo/redo step references.
 * Closes the crash window where a process dies after captureBefore writes a
 * backup but before seal runs. Unknown `*.bak` names are left alone so a
 * future backup scheme cannot be deleted by an older extension version.
 */
export async function sweepUnreferencedBackups(history: SessionHistory): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(history.dir);
	} catch {
		return;
	}
	const referenced = new Set<string>([INDEX_FILE]);
	for (const turn of [...history.undo, ...history.redo]) {
		for (const file of turn.files) {
			if (file.backup) referenced.add(file.backup);
		}
	}
	for (const name of history.pendingBackupNames()) referenced.add(name);
	await Promise.all(
		names
			.filter(
				(name) =>
					!referenced.has(name) &&
					(name.startsWith("bk-") || name.startsWith("rd-")) &&
					name.endsWith(".bak"),
			)
			.map((name) => rmForce(join(history.dir, name))),
	);
}

export async function pruneOrphans(sessionDir: string): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(historyRootFor(sessionDir));
	} catch {
		return;
	}
	let sessionFiles: Set<string>;
	try {
		const files = await fs.readdir(sessionDir);
		sessionFiles = new Set(files.filter((f) => f.endsWith(".jsonl")));
	} catch {
		return;
	}
	const now = Date.now();
	await Promise.all(
		names.map(async (name) => {
			const dir = join(historyRootFor(sessionDir), name);
			try {
				const stat = await fs.stat(dir);
				if (!stat.isDirectory() || now - stat.mtimeMs < ORPHAN_AFTER_MS) return;
				const owned = [...sessionFiles].some((f) => f.endsWith(`_${name}.jsonl`));
				if (!owned) await fs.rm(dir, { recursive: true, force: true });
			} catch {
				// Leave it for the next sweep.
			}
		}),
	);
}

export async function readCurrentFile(absPath: string): Promise<{ existed: boolean; content: Buffer | null }> {
	try {
		return { existed: true, content: await fs.readFile(absPath) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { existed: false, content: null };
		}
		throw error;
	}
}

/** Snapshot current disk state into the sidecar; used to build redo/undo records. */
export async function snapshotCurrentFile(
	history: SessionHistory,
	absPath: string,
): Promise<StoredFile> {
	let current;
	try {
		current = await readCurrentFile(absPath);
	} catch {
		// Unreadable is not absent: report "existed but unsnapshotted" so a
		// later restore leaves the file alone instead of deleting it.
		return { path: absPath, backup: null, existed: true, bytes: 0 };
	}
	if (!current.existed || current.content === null) {
		return { path: absPath, backup: null, existed: false, bytes: 0 };
	}
	if (current.content.length > MAX_FILE_BYTES) {
		return { path: absPath, backup: null, existed: true, bytes: 0 };
	}
	const backup = `rd-${randomUUID()}.bak`;
	try {
		await fs.mkdir(history.dir, { recursive: true });
		await fs.writeFile(join(history.dir, backup), current.content);
		return { path: absPath, backup, existed: true, bytes: current.content.length };
	} catch {
		return { path: absPath, backup: null, existed: true, bytes: 0 };
	}
}

export interface ApplyResult {
	restored: number;
	missing: number;
	skipped: number;
}

/**
 * Apply a stored file list to disk.
 * - `restored`: bytes written back (or created-file deleted).
 * - `missing`: backup vanished from the sidecar.
 * - `skipped`: file existed but was never snapshotted (too large) — left alone.
 */
export async function applyStoredFiles(
	history: SessionHistory,
	files: StoredFile[],
): Promise<ApplyResult> {
	let restored = 0;
	let missing = 0;
	let skipped = 0;
	for (const file of files) {
		try {
			if (!file.existed) {
				await rmForce(file.path);
				restored++;
				continue;
			}
			if (file.backup === null) {
				skipped++;
				continue;
			}
			const content = await fs.readFile(join(history.dir, file.backup)).catch(() => null);
			if (content === null) {
				missing++;
				continue;
			}
			await fs.mkdir(dirname(file.path), { recursive: true });
			await writeFileAtomicSameDir(file.path, content);
			restored++;
		} catch {
			missing++;
		}
	}
	return { restored, missing, skipped };
}

function describeFiles(turn: StoredTurn, result: ApplyResult): string {
	const parts: string[] = [];
	if (result.restored > 0) parts.push(`${result.restored} file${result.restored === 1 ? "" : "s"} restored`);
	if (result.missing > 0) parts.push(`${result.missing} backup${result.missing === 1 ? "" : "s"} missing`);
	const skippedCount = result.skipped + turn.skipped.length;
	if (skippedCount > 0)
		parts.push(`${skippedCount} file${skippedCount === 1 ? "" : "s"} not tracked (too large or unreadable)`);
	if (parts.length === 0) return "conversation moved (that turn wrote no files)";
	return parts.join(", ");
}

export default function localHistory(pi: ExtensionAPI) {
	const histories = new Map<string, SessionHistory>();
	/** End leaf of the last sealed step, per session (backstop anchor). */
	const lastSealedEnd = new Map<string, string | null>();
	/**
	 * Own navigateTree call in flight. `session_tree` echoes synchronously
	 * inside that await, so a flag (not an id comparison) tells our echo
	 * from foreign navigation: pi retargets user-message targets to their
	 * parent leaf, so the emitted id never equals the requested target.
	 */
	let ownNavInFlight = false;

	function historyFor(sessionId: string, sessionDir: string): SessionHistory {
		const existing = histories.get(sessionId);
		if (existing) return existing;
		const created = new SessionHistory(sessionDirFor(sessionId, sessionDir));
		histories.set(sessionId, created);
		return created;
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const history = historyFor(sessionId, ctx.sessionManager.getSessionDir());
			await history.load();
			// Hydrate to the current position (redo top wins after an undo);
			// overwritten before first read, since the backstop only runs
			// once pending captures exist, which always postdates a seal.
			lastSealedEnd.set(
				sessionId,
				history.redo.at(-1)?.endLeafId ?? history.undo.at(-1)?.endLeafId ?? null,
			);
			ownNavInFlight = false;
			await pruneOrphans(ctx.sessionManager.getSessionDir());
		} catch {
			// Never break startup; history simply starts empty.
		}
	});

	pi.on("session_shutdown", async () => {
		for (const history of histories.values()) {
			await history.persist().catch(() => undefined);
		}
		histories.clear();
		ownNavInFlight = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (event.toolName !== "edit" && event.toolName !== "write") return;
			const raw = (event.input as { path?: unknown } | undefined)?.path;
			const absPath = resolveToolPath(ctx.cwd, raw);
			if (!absPath || isSkippedPath(ctx.cwd, absPath)) return;
			const sessionId = ctx.sessionManager.getSessionId();
			await historyFor(sessionId, ctx.sessionManager.getSessionDir()).captureBefore(absPath);
		} catch {
			// Capture is best effort; the tool itself still runs.
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.toolName !== "edit" && event.toolName !== "write") return;
			const raw = (event.input as { path?: unknown } | undefined)?.path;
			const absPath = resolveToolPath(ctx.cwd, raw);
			if (!absPath) return;
			const sessionId = ctx.sessionManager.getSessionId();
			const history = histories.get(sessionId);
			if (!history) return;
			if (event.isError) {
				await history.dropPending(absPath);
			} else {
				history.markDirty(absPath);
			}
		} catch {
			// Never break tool results.
		}
	});

	// One seal per prompt: `agent_settled` fires after retries, compactions,
	// and queued continuations finish. (`agent_end` can fire per low-level run
	// inside one prompt — sealing there would split a single prompt into
	// several undo steps anchored to the same user message.)
	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const history = historyFor(sessionId, ctx.sessionManager.getSessionDir());
			const branch = ctx.sessionManager.getBranch() as PromptBranchEntry[];
			const sealed = await history.seal(findPrevPromptId(branch), ctx.sessionManager.getLeafId());
			lastSealedEnd.set(sessionId, sealed.endLeafId);
			await sweepUnreferencedBackups(history);
		} catch {
			// A missed seal just means one prompt is not steppable.
		}
	});

	// Defensive: if a prompt never reached `agent_settled` (crash between runs,
	// missed event), its captures would leak into the next prompt's step.
	// Anchor to the prompt that follows the last sealed leaf — never to the
	// leaf end, where the next prompt's user message may already sit.
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const history = histories.get(sessionId);
			if (!history || history.pendingCount === 0) return;
			const branch = ctx.sessionManager.getBranch() as PromptBranchEntry[];
			const anchor = resolveBackstopAnchor(branch, lastSealedEnd.get(sessionId) ?? null);
			const sealed = await history.seal(
				anchor,
				findLastNonPromptId(branch) ?? ctx.sessionManager.getLeafId(),
			);
			lastSealedEnd.set(sessionId, sealed.endLeafId);
		} catch {
			// Non-fatal.
		}
	});

	pi.on("session_tree", async () => {
		try {
			if (ownNavInFlight) return;
			for (const history of histories.values()) {
				await history.clearRedo();
			}
		} catch {
			// Non-fatal.
		}
	});

	async function doUndo(ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();
		if (!ctx.isIdle()) {
			ctx.ui.notify("Cannot undo while the agent is busy.", "warning");
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		const history = historyFor(sessionId, ctx.sessionManager.getSessionDir());
		await history.load();
		const turn = history.popUndo();
		if (!turn) {
			ctx.ui.notify("Nothing to undo in this session.", "info");
			return;
		}
		// Record the present as the redo step before overwriting it.
		const redoFiles: StoredFile[] = [];
		for (const file of turn.files) {
			redoFiles.push(await snapshotCurrentFile(history, file.path));
		}
		const result = await applyStoredFiles(history, turn.files);
		history.pushRedo({
			id: turn.id,
			userMsgId: turn.userMsgId,
			endLeafId: turn.endLeafId,
			sealedAt: turn.sealedAt,
			files: redoFiles,
			skipped: [],
		});
		await history.enforceCaps();
		await history.persist();
		if (turn.userMsgId && ctx.sessionManager.getEntry(turn.userMsgId)) {
			ownNavInFlight = true;
			try {
				const nav = await ctx.navigateTree(turn.userMsgId);
				if (nav?.cancelled) {
					ctx.ui.notify("Files restored, but conversation navigation was cancelled.", "warning");
					return;
				}
			} catch {
				ctx.ui.notify("Files restored, but conversation navigation was cancelled.", "warning");
				return;
			} finally {
				ownNavInFlight = false;
			}
		}
		ctx.ui.notify(`Undid last turn: ${describeFiles(turn, result)}.`, "info");
	}

	async function doRedo(ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();
		if (!ctx.isIdle()) {
			ctx.ui.notify("Cannot redo while the agent is busy.", "warning");
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		const history = historyFor(sessionId, ctx.sessionManager.getSessionDir());
		await history.load();
		const turn = history.popRedo();
		if (!turn) {
			ctx.ui.notify("Nothing to redo in this session.", "info");
			return;
		}
		// The current state becomes the undo step for this redo.
		const undoFiles: StoredFile[] = [];
		for (const file of turn.files) {
			undoFiles.push(await snapshotCurrentFile(history, file.path));
		}
		const result = await applyStoredFiles(history, turn.files);
		history.pushUndo({
			id: turn.id,
			userMsgId: turn.userMsgId,
			endLeafId: turn.endLeafId,
			sealedAt: turn.sealedAt,
			files: undoFiles,
			skipped: [],
		});
		await history.enforceCaps();
		await history.persist();
		if (turn.endLeafId && ctx.sessionManager.getEntry(turn.endLeafId)) {
			ownNavInFlight = true;
			try {
				const nav = await ctx.navigateTree(turn.endLeafId);
				if (nav?.cancelled) {
					ctx.ui.notify("Files restored, but conversation navigation was cancelled.", "warning");
					return;
				}
			} catch {
				ctx.ui.notify("Files restored, but conversation navigation was cancelled.", "warning");
				return;
			} finally {
				ownNavInFlight = false;
			}
		}
		ctx.ui.notify(`Redid turn: ${describeFiles(turn, result)}.`, "info");
	}

	pi.registerCommand("undo", {
		description: "Undo the last turn: restore file before-images and rewind the conversation",
		handler: async (_args, ctx) => {
			await doUndo(ctx).catch(() => {
				ctx.ui.notify("Undo failed; files were left unchanged.", "error");
			});
		},
	});

	pi.registerCommand("redo", {
		description: "Redo the last undone turn: restore files and move the conversation forward",
		handler: async (_args, ctx) => {
			await doRedo(ctx).catch(() => {
				ctx.ui.notify("Redo failed; files were left unchanged.", "error");
			});
		},
	});

	pi.registerCommand("local-history", {
		description: "Show local per-turn file history status (turns, size, location)",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const history = historyFor(sessionId, ctx.sessionManager.getSessionDir());
			await history.load();
			const kb = Math.round(history.byteTotal() / 1024);
			ctx.ui.notify(
				`local-history: ${history.undo.length} undo step(s), ${history.redo.length} redo step(s), ` +
					`${kb} KiB in ${history.dir} (limits: ${MAX_TURNS} turns, 50 MiB, 1 MiB/file). ` +
					`Tracks edit/write only; bash side-effects are not tracked.`,
				"info",
			);
		},
	});
}
