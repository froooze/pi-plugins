/**
 * fff-guard: suppression of pi-fff's duplicate root/home init error.
 *
 * pi-fff re-reports the picker refusal as `FFF init failed: …` ("error" toast)
 * right after fff-guard already explained it. fff-guard wraps the shared
 * `ctx.ui.notify` to drop exactly that message — and nothing else.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { homedir } from "node:os";
import {
	installInitFailureFilter,
	isStrict,
	shouldSuppressInitFailure,
	type NotifyCapableUi,
} from "../extensions/fff-guard.ts";

const HOME = homedir();
const PROJECT = "/tmp/some-project";

/** The exact toast pi-fff raises when launched from $HOME. */
const HOME_INIT_FAILURE =
	`FFF init failed: Failed to create FFF file picker for ${HOME}: Failed to init file picker: ` +
	"Can not run certain FFF features in a file system root or home directories. " +
	"Consider smaller per-project directories.";

/** The older wordings, still emitted by some FFF builds. */
const REFUSING_INIT_FAILURE = "FFF init failed: Refusing to index / (Refusing to index)";

/** A genuine FFF fault that must never be hidden. */
const DB_INIT_FAILURE = "FFF init failed: Failed to open frecency database: lock held by another process";

/** Collects everything a filtered ui forwards. */
function makeUi(): NotifyCapableUi & { seen: Array<[string, string | undefined]> } {
	const seen: Array<[string, string | undefined]> = [];
	return {
		seen,
		notify(message: string, type?: "info" | "warning" | "error") {
			seen.push([message, type]);
		},
	};
}

describe("shouldSuppressInitFailure", () => {
	test("suppresses the root/home refusal from $HOME", () => {
		assert.equal(shouldSuppressInitFailure(HOME_INIT_FAILURE, HOME), true);
	});

	test("suppresses the refusal from the filesystem root", () => {
		const msg = "FFF init failed: Refusing to index /";
		assert.equal(shouldSuppressInitFailure(msg, "/"), true);
	});

	test("suppresses the older 'Refusing to index' wording", () => {
		assert.equal(shouldSuppressInitFailure(REFUSING_INIT_FAILURE, HOME), true);
	});

	test("suppresses the 'too large' wording", () => {
		assert.equal(shouldSuppressInitFailure("FFF init failed: Your cwd (/) is too large", "/"), true);
	});

	test("keeps a genuine FFF fault visible", () => {
		assert.equal(shouldSuppressInitFailure(DB_INIT_FAILURE, HOME), false);
	});

	test("keeps a fault visible even when it mentions home", () => {
		// Prefix matches, refusal wording does not -> real failure.
		const msg = "FFF init failed: lmdb lock in /home/alex/.pi/agent/fff is held by another process";
		assert.equal(shouldSuppressInitFailure(msg, HOME), false);
	});

	test("keeps another extension's toast that quotes the refusal", () => {
		const msg = "some-other-ext: FFF init failed: Refusing to index /";
		assert.equal(shouldSuppressInitFailure(msg, HOME), false);
	});

	test("requires a root/home cwd even for the refusal wording", () => {
		// Aux pickers can also refuse; a project cwd means this is a real fault.
		assert.equal(shouldSuppressInitFailure(REFUSING_INIT_FAILURE, PROJECT), false);
	});

	test("tolerates non-string and empty input", () => {
		assert.equal(shouldSuppressInitFailure(undefined as unknown as string, HOME), false);
		assert.equal(shouldSuppressInitFailure("", HOME), false);
		assert.equal(shouldSuppressInitFailure("FFF init failed:", HOME), false);
	});
});

describe("installInitFailureFilter", () => {
	test("drops the FFF init error and forwards everything else", () => {
		const ui = makeUi();
		installInitFailureFilter(ui, { cwd: HOME, env: {} });

		ui.notify(HOME_INIT_FAILURE, "error");
		ui.notify("(fff): Failed to open frecency/history database (lock). Continuing.", "error");
		ui.notify("fff-guard: running from /home/alex — cd into your project", "warning");

		assert.deepEqual(ui.seen.map(([m]) => m.split(":")[0]), ["(fff)", "fff-guard"]);
		assert.equal(ui.seen[0][1], "error");
		assert.equal(ui.seen[1][1], "warning");
	});

	test("forwards everything from a project cwd (no suppression needed)", () => {
		const ui = makeUi();
		installInitFailureFilter(ui, { cwd: PROJECT, env: {} });

		ui.notify(DB_INIT_FAILURE, "error");

		assert.equal(ui.seen.length, 1);
		assert.equal(ui.seen[0][0], DB_INIT_FAILURE);
	});

	test("strict mode keeps the raw error", () => {
		const ui = makeUi();
		installInitFailureFilter(ui, { cwd: HOME, strict: true });

		ui.notify(HOME_INIT_FAILURE, "error");

		assert.equal(ui.seen.length, 1);
		assert.equal(ui.seen[0][0], HOME_INIT_FAILURE);
	});

	test("is idempotent — a second session_start does not stack wrappers", () => {
		const ui = makeUi();
		installInitFailureFilter(ui, { cwd: HOME, env: {} });
		const afterFirst = ui.notify;
		installInitFailureFilter(ui, { cwd: HOME, env: {} });
		assert.equal(ui.notify, afterFirst);

		ui.notify(HOME_INIT_FAILURE, "error");
		ui.notify("unrelated", "info");
		assert.deepEqual(ui.seen, [["unrelated", "info"]]);
	});

	test("restore puts the original notify back", () => {
		const ui = makeUi();
		const original = ui.notify;
		const restore = installInitFailureFilter(ui, { cwd: HOME, env: {} });
		assert.notEqual(ui.notify, original);

		restore();
		assert.equal(ui.notify, original);
		ui.notify(HOME_INIT_FAILURE, "error");
		assert.equal(ui.seen.length, 1);
	});

	test("re-install works after a restore (new session, same ui)", () => {
		const ui = makeUi();
		installInitFailureFilter(ui, { cwd: HOME, env: {} })();
		const second = installInitFailureFilter(ui, { cwd: HOME, env: {} });

		ui.notify(HOME_INIT_FAILURE, "error");
		assert.equal(ui.seen.length, 0);

		second();
		ui.notify(HOME_INIT_FAILURE, "error");
		assert.equal(ui.seen.length, 1);
	});

	test("survives an unpatchable ui object", () => {
		const broken = { notify: undefined } as unknown as NotifyCapableUi;
		const restore = installInitFailureFilter(broken, { cwd: HOME, env: {} });
		assert.doesNotThrow(() => restore());
	});
});

describe("isStrict", () => {
	test("defaults to off", () => {
		assert.equal(isStrict({}), false);
	});

	test("accepts 1/on/true, case- and space-insensitive", () => {
		assert.equal(isStrict({ PI_FFF_GUARD_STRICT: "1" }), true);
		assert.equal(isStrict({ PI_FFF_GUARD_STRICT: " ON " }), true);
		assert.equal(isStrict({ PI_FFF_GUARD_STRICT: "True" }), true);
	});

	test("off/0/false and junk keep suppression on", () => {
		assert.equal(isStrict({ PI_FFF_GUARD_STRICT: "0" }), false);
		assert.equal(isStrict({ PI_FFF_GUARD_STRICT: "off" }), false);
		assert.equal(isStrict({ PI_FFF_GUARD_STRICT: "false" }), false);
		assert.equal(isStrict({ PI_FFF_GUARD_STRICT: "maybe" }), false);
	});
});
