import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { SuggestionUsageStats } from "../../domain/state.js";
import type { SuggestionSink } from "../../app/orchestrators/turn-end.js";

export interface UiContextLike {
	getContext(): ExtensionContext | undefined;
	getEpoch(): number;
	getSuggestion(): string | undefined;
	setSuggestion(text: string | undefined): void;
	getPanelSuggestionStatus(): string | undefined;
	setPanelSuggestionStatus(text: string | undefined): void;
	getPanelLogStatus(): { level: "debug" | "info" | "warn" | "error"; text: string } | undefined;
	setPanelLogStatus(status: { level: "debug" | "info" | "warn" | "error"; text: string } | undefined): void;
	getSuggesterModelDisplay(): string | undefined;
	prefillOnlyWhenEditorEmpty: boolean;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatUsage(
	usage: { suggester: SuggestionUsageStats; seeder: SuggestionUsageStats },
	suggesterModelDisplay: string | undefined,
): string {
	const combinedInput = usage.suggester.inputTokens + usage.seeder.inputTokens;
	const combinedOutput = usage.suggester.outputTokens + usage.seeder.outputTokens;
	const combinedCacheRead = usage.suggester.cacheReadTokens + usage.seeder.cacheReadTokens;
	const combinedCost = usage.suggester.costTotal + usage.seeder.costTotal;
	const suffix = suggesterModelDisplay ? `, suggester: ${suggesterModelDisplay}` : "";
	return `suggester usage: ↑${formatTokens(combinedInput)} ↓${formatTokens(combinedOutput)} R${formatTokens(combinedCacheRead)} $${combinedCost.toFixed(3)} (${usage.suggester.calls} sugg, ${usage.seeder.calls} seed)${suffix}`;
}

function formatPanelLog(
	ctx: ExtensionContext,
	status: { level: "debug" | "info" | "warn" | "error"; text: string },
): string {
	const theme = ctx.ui.theme;
	if (status.level === "error") return theme.fg("error", status.text);
	if (status.level === "warn") return theme.fg("warning", status.text);
	if (status.level === "debug") return theme.fg("dim", status.text);
	return theme.fg("muted", status.text);
}

export function refreshSuggesterUi(runtime: UiContextLike): void {
	const ctx = runtime.getContext();
	if (!ctx?.hasUI) return;

	ctx.ui.setStatus("suggester", undefined);
	ctx.ui.setStatus("suggester-events", undefined);

	const suggestionStatus = runtime.getPanelSuggestionStatus();
	const logStatus = runtime.getPanelLogStatus();
	if (!suggestionStatus && !logStatus) {
		ctx.ui.setWidget("suggester-panel", undefined);
		return;
	}

	ctx.ui.setWidget(
		"suggester-panel",
		(_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const parts: string[] = [];
				if (suggestionStatus) parts.push(theme.fg("accent", suggestionStatus));
				if (logStatus) parts.push(formatPanelLog(ctx, logStatus));
				return wrapTextWithAnsi(parts.join(" "), Math.max(10, width));
			},
		}),
		{ placement: "belowEditor" },
	);
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
		this.runtime.setPanelSuggestionStatus(`${statusLabel}${statusHint}`);
		refreshSuggesterUi(this.runtime);
	}

	public async clearSuggestion(options?: { generationId?: number }): Promise<void> {
		if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch()) return;
		this.runtime.setSuggestion(undefined);
		this.runtime.setPanelSuggestionStatus(undefined);
		refreshSuggesterUi(this.runtime);
	}

	public async setUsage(usage: { suggester: SuggestionUsageStats; seeder: SuggestionUsageStats }): Promise<void> {
		const ctx = this.runtime.getContext();
		if (!ctx?.hasUI) return;
		if (usage.suggester.calls <= 0 && usage.seeder.calls <= 0) {
			ctx.ui.setStatus("suggester-usage", undefined);
			return;
		}
		ctx.ui.setStatus(
			"suggester-usage",
			ctx.ui.theme.fg("dim", formatUsage(usage, this.runtime.getSuggesterModelDisplay())),
		);
	}
}
