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

function formatUsage(usage: SuggestionUsageStats): string {
	const lastPromptTokens = usage.last?.inputTokens ?? 0;
	const lastTokens = usage.last?.totalTokens ?? 0;
	const lastCost = usage.last?.costTotal ?? 0;
	return `↳ suggester usage prompt ${lastPromptTokens} tok · last ${lastTokens} tok $${lastCost.toFixed(4)} · total ${usage.totalTokens} tok $${usage.costTotal.toFixed(4)} (${usage.calls} calls)`;
}

export class PiSuggestionSink implements SuggestionSink {
	public constructor(private readonly runtime: UiContextLike) {}

	public async showSuggestion(text: string, options?: { restore?: boolean; generationId?: number }): Promise<void> {
		if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch()) return;
		const ctx = this.runtime.getContext();
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
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

		ctx.ui.setStatus(
			"suggester",
			theme.fg("accent", options?.restore ? "✦ restored prompt suggestion" : "✦ prompt suggestion"),
		);

		if (canGhostInEditor) {
			this.runtime.setSuggestion(text);
			ctx.ui.setWidget("suggester", undefined);
			return;
		}

		this.runtime.setSuggestion(undefined);
		ctx.ui.setWidget(
			"suggester",
			[
				`${theme.fg("accent", "Suggested next prompt")}`,
				text,
				theme.fg("dim", "(typed text no longer matches the suggestion, so it is shown below the editor)"),
			],
			{ placement: "belowEditor" },
		);
	}

	public async clearSuggestion(options?: { generationId?: number }): Promise<void> {
		if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch()) return;
		const ctx = this.runtime.getContext();
		this.runtime.setSuggestion(undefined);
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget("suggester", undefined);
		ctx.ui.setStatus("suggester", undefined);
	}

	public async setUsage(usage: SuggestionUsageStats): Promise<void> {
		const ctx = this.runtime.getContext();
		if (!ctx?.hasUI) return;
		if (usage.calls <= 0) {
			ctx.ui.setStatus("suggester-usage", undefined);
			return;
		}
		ctx.ui.setStatus("suggester-usage", ctx.ui.theme.fg("dim", formatUsage(usage)));
	}
}
