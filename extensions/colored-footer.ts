/**
 * colored-footer - color each built-in footer statistic independently.
 *
 * The built-in footer applies color only to context pressure. This replaces
 * that footer while preserving its token, cache, cost, context, and model
 * information.
 */
import { relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const relativeCwd = relative(resolve(home), resolve(cwd));
	const insideHome =
		relativeCwd === "" ||
		(relativeCwd !== ".." && !relativeCwd.startsWith(`..${sep}`));
	return insideHome ? (relativeCwd === "" ? "~" : `~${sep}${relativeCwd}`) : cwd;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export default function coloredFooter(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type !== "message") continue;
						const message = entry.message as AssistantMessage & {
							role: string;
						usage?: {
								input: number;
								output: number;
								cacheRead: number;
								cacheWrite: number;
								cost: { total: number };
							};
						};
						if (!message.usage) continue;

						input += message.usage.input;
						output += message.usage.output;
						cacheRead += message.usage.cacheRead;
						cacheWrite += message.usage.cacheWrite;
						cost += message.usage.cost.total;

						if (message.role === "assistant") {
							const promptTokens =
								message.usage.input +
								message.usage.cacheRead +
								message.usage.cacheWrite;
							latestCacheHitRate =
								promptTokens > 0
									? (message.usage.cacheRead / promptTokens) * 100
									: undefined;
						}
					}

					const stats: string[] = [];
					if (input) stats.push(theme.fg("success", `↑${formatTokens(input)}`));
					if (output) stats.push(theme.fg("error", `↓${formatTokens(output)}`));
					if (cacheRead) stats.push(theme.fg("muted", `R${formatTokens(cacheRead)}`));
					if (cacheWrite) stats.push(theme.fg("muted", `W${formatTokens(cacheWrite)}`));
					if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) {
						stats.push(theme.fg("warning", `CH${latestCacheHitRate.toFixed(1)}%`));
					}
					if (cost) stats.push(theme.fg("text", `$${cost.toFixed(3)}`));

					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = usage?.percent;
					const contextText =
						percent === null || percent === undefined
							? `?/${formatTokens(contextWindow)}`
							: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
					stats.push(theme.fg("mdHeading", contextText));

					const statsLeft = stats.join(" ");
					const model = ctx.model;
					let right = model?.id || "no-model";
					if (footerData.getAvailableProviderCount() > 1 && model) {
						right = `${theme.fg("muted", `(${model.provider})`)} ${right}`;
					}
					if (model?.reasoning) {
						const thinking = ctx.thinkingLevel || "off";
						if (thinking !== "off") right += ` • ${thinking}`;
					}

					const branch = footerData.getGitBranch();
					let cwd = formatCwd(ctx.cwd);
					if (branch) cwd += ` (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) cwd += ` • ${sessionName}`;

					const statsWidth = visibleWidth(statsLeft);
					const rightWidth = visibleWidth(right);
					const availableRight = width - statsWidth - 2;
					const fittedRight =
						statsWidth + 2 + rightWidth <= width
							? right
							: availableRight > 0
							? truncateToWidth(right, availableRight, "")
							: "";
					const statsLine =
						statsLeft +
						" ".repeat(Math.max(0, width - statsWidth - visibleWidth(fittedRight))) +
						fittedRight;
					const lines = [
						truncateToWidth(theme.fg("dim", cwd), width),
						truncateToWidth(statsLine, width),
					];
					const statuses = Array.from(footerData.getExtensionStatuses().values());
					if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width));
					return lines;
				},
			};
		});
	});
}
