/**
 * muse-spark-reasoning-fix - stop replaying encrypted reasoning for Muse Spark
 * on the OpenCode gateways.
 *
 * Upstream pi (`@earendil-works/pi-ai`, `openai-responses` API) always sends
 * `include: ["reasoning.encrypted_content"]` for reasoning models and replays
 * native `reasoning` items from history on the next step. The OpenCode
 * gateways (`opencode` = Zen, `opencode-go`) proxy the Muse Spark Responses
 * lane to Meta but cannot round-trip encrypted reasoning: the upstream binds
 * `encrypted_content` to the gateway's own caller, so replaying it on a
 * tool-continuation step fails with
 * `400 ... reasoning encrypted_content was not issued to this caller`,
 * aborting every tool-call turn.
 *
 * This is the same bug fixed in oh-my-pi #11931 (fixes #11928) via catalog
 * compat flags (`include-encrypted-reasoning #false` +
 * `filter-reasoning-history #true` for `meta`/`muse-spark` on
 * `opencode-zen`/`opencode-go`). Upstream pi has no such compat flags, so
 * this extension applies the equivalent rewrite at the
 * `before_provider_request` hook: for `muse-spark-*` on `opencode` /
 * `opencode-go` via `openai-responses`, drop
 * `reasoning.encrypted_content` from `include` and strip `reasoning` items
 * from `input` so encrypted reasoning is neither requested nor replayed.
 *
 * No-op for all other providers/models. Safe to keep after upstream fixes
 * the catalog: there will simply be nothing left to strip.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDERS = new Set(["opencode", "opencode-go"]);
const ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";

function isMuseSparkLane(
	model: { provider?: string; id?: string; api?: string } | undefined,
	payloadModelId: string | undefined,
): boolean {
	// Prefer the active model from ctx; fall back to the payload's model id
	// in case ctx.model is unset when the hook fires.
	if (model) {
		if (model.api !== undefined && model.api !== "openai-responses") return false;
		if (!TARGET_PROVIDERS.has(model.provider ?? "")) return false;
		return /muse-spark/i.test(model.id ?? "");
	}
	return payloadModelId !== undefined && /muse-spark/i.test(payloadModelId);
}

function stripEncryptedReasoning(payload: Record<string, unknown>): Record<string, unknown> | undefined {
	let changed = false;
	const next: Record<string, unknown> = { ...payload };

	// 1. Stop requesting encrypted reasoning.
	if (Array.isArray(next.include)) {
		const filtered = (next.include as unknown[]).filter((v) => v !== ENCRYPTED_REASONING_INCLUDE);
		if (filtered.length !== (next.include as unknown[]).length) {
			changed = true;
			if (filtered.length === 0) delete next.include;
			else next.include = filtered;
		}
	} else if (next.include === ENCRYPTED_REASONING_INCLUDE) {
		changed = true;
		delete next.include;
	}

	// 2. Drop replayed native reasoning items (they carry the encrypted_content
	// that the gateway cannot round-trip).
	if (Array.isArray(next.input)) {
		const input = next.input as Array<{ type?: string } | unknown>;
		const filtered = input.filter(
			(item) => typeof item !== "object" || item === null || (item as { type?: string }).type !== "reasoning",
		);
		if (filtered.length !== input.length) {
			changed = true;
			next.input = filtered;
		}
	}

	return changed ? next : undefined;
}

export default function museSparkReasoningFix(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (typeof event.payload !== "object" || event.payload === null) return;
		const payload = event.payload as Record<string, unknown>;
		const payloadModelId = typeof payload.model === "string" ? payload.model : undefined;
		const model = ctx.model as { provider?: string; id?: string; api?: string } | undefined;

		if (!isMuseSparkLane(model, payloadModelId)) return;

		// Only Responses payloads have input/include in this shape.
		if (!("input" in payload) && !("include" in payload)) return;

		return stripEncryptedReasoning(payload);
	});
}
