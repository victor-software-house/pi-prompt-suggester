import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SuggestionUsageStats } from "../../domain/state.js";
import type { SuggestionSink } from "../../app/orchestrators/turn-end.js";

export interface UiContextLike {
	getContext(): ExtensionContext | undefined;
	getEpoch(): number;
	getSuggestion(): string | undefined;
	setSuggestion(text: string | undefined): void;
	prefillOnlyWhenEditorEmpty: boolean;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatUsage(usage: { suggester: SuggestionUsageStats; seeder: SuggestionUsageStats }): string {
	const combinedInput = usage.suggester.inputTokens + usage.seeder.inputTokens;
	const combinedOutput = usage.suggester.outputTokens + usage.seeder.outputTokens;
	const combinedCacheRead = usage.suggester.cacheReadTokens + usage.seeder.cacheReadTokens;
	const combinedCost = usage.suggester.costTotal + usage.seeder.costTotal;
	const suggesterPromptTokens = usage.suggester.last?.inputTokens ?? 0;
	return `suggester usage: ↑${formatTokens(combinedInput)} ↓${formatTokens(combinedOutput)} R${formatTokens(combinedCacheRead)} $${combinedCost.toFixed(3)} (${usage.suggester.calls} sugg, ${usage.seeder.calls} seed), last suggester prompt: ${formatTokens(suggesterPromptTokens)} tok`;
}

export class PiSuggestionSink implements SuggestionSink {
	public constructor(private readonly runtime: UiContextLike) {}

	public async showSuggestion(text: string, options?: { restore?: boolean; generationId?: number }): Promise<void> {
		if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch()) return;
		const ctx = this.runtime.getContext();
		if (!ctx?.hasUI) return;

		const editorText = ctx.ui.getEditorText();
		const trimmedEditorText = editorText.trim();
		const isMultilineSuggestion = text.includes("\n");
		const prefixCompatible = !editorText.includes("\n") && text.startsWith(editorText);
		const canGhostInEditor =
			ctx.isIdle() &&
			!ctx.hasPendingMessages() &&
			(isMultilineSuggestion
				? trimmedEditorText.length === 0
				: this.runtime.prefillOnlyWhenEditorEmpty
					? trimmedEditorText.length === 0
					: trimmedEditorText.length === 0 || prefixCompatible);

		if (canGhostInEditor) {
			this.runtime.setSuggestion(text);
		} else {
			this.runtime.setSuggestion(undefined);
		}

		const statusLabel = options?.restore ? "✦ restored prompt suggestion" : "✦ prompt suggestion";
		const statusHint = canGhostInEditor ? " · Space accepts" : " · ghost hidden";
		ctx.ui.setStatus("suggester", ctx.ui.theme.fg("accent", `${statusLabel}${statusHint}`));
	}

	public async clearSuggestion(options?: { generationId?: number }): Promise<void> {
		if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch()) return;
		const ctx = this.runtime.getContext();
		this.runtime.setSuggestion(undefined);
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("suggester", undefined);
	}

	public async setUsage(usage: { suggester: SuggestionUsageStats; seeder: SuggestionUsageStats }): Promise<void> {
		const ctx = this.runtime.getContext();
		if (!ctx?.hasUI) return;
		if (usage.suggester.calls <= 0 && usage.seeder.calls <= 0) {
			ctx.ui.setStatus("suggester-usage", undefined);
			return;
		}
		ctx.ui.setStatus("suggester-usage", ctx.ui.theme.fg("dim", formatUsage(usage)));
	}
}
