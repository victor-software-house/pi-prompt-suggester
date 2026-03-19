import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { formatTokens } from "./display.js";
function formatUsage(usage, suggesterModelDisplay) {
    const combinedInput = usage.suggester.inputTokens + usage.seeder.inputTokens;
    const combinedOutput = usage.suggester.outputTokens + usage.seeder.outputTokens;
    const combinedCacheRead = usage.suggester.cacheReadTokens + usage.seeder.cacheReadTokens;
    const combinedCost = usage.suggester.costTotal + usage.seeder.costTotal;
    const suffix = suggesterModelDisplay ? `, suggester: ${suggesterModelDisplay}` : "";
    return `suggester usage: ↑${formatTokens(combinedInput)} ↓${formatTokens(combinedOutput)} R${formatTokens(combinedCacheRead)} $${combinedCost.toFixed(3)} (${usage.suggester.calls} sugg, ${usage.seeder.calls} seed)${suffix}`;
}
function formatPanelLog(ctx, status) {
    const theme = ctx.ui.theme;
    if (status.level === "error")
        return theme.fg("error", status.text);
    if (status.level === "warn")
        return theme.fg("warning", status.text);
    if (status.level === "debug")
        return theme.fg("dim", status.text);
    return theme.fg("muted", status.text);
}
export function refreshSuggesterUi(runtime) {
    const ctx = runtime.getContext();
    if (!ctx?.hasUI)
        return;
    ctx.ui.setStatus("suggester", undefined);
    ctx.ui.setStatus("suggester-events", undefined);
    const suggestionStatus = runtime.getPanelSuggestionStatus();
    const logStatus = runtime.getPanelLogStatus();
    if (!suggestionStatus && !logStatus) {
        ctx.ui.setWidget("suggester-panel", undefined);
        return;
    }
    ctx.ui.setWidget("suggester-panel", (_tui, theme) => ({
        invalidate() { },
        render(width) {
            const parts = [];
            if (suggestionStatus)
                parts.push(theme.fg("accent", suggestionStatus));
            if (logStatus)
                parts.push(formatPanelLog(ctx, logStatus));
            return wrapTextWithAnsi(parts.join(" "), Math.max(10, width));
        },
    }), { placement: "belowEditor" });
}
export class PiSuggestionSink {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    async showSuggestion(text, options) {
        if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch())
            return;
        const ctx = this.runtime.getContext();
        if (!ctx?.hasUI)
            return;
        const editorText = ctx.ui.getEditorText();
        const trimmedEditorText = editorText.trim();
        const isMultilineSuggestion = text.includes("\n");
        const prefixCompatible = !editorText.includes("\n") && text.startsWith(editorText);
        const canGhostInEditor = ctx.isIdle() &&
            !ctx.hasPendingMessages() &&
            (isMultilineSuggestion
                ? trimmedEditorText.length === 0
                : this.runtime.prefillOnlyWhenEditorEmpty
                    ? trimmedEditorText.length === 0
                    : trimmedEditorText.length === 0 || prefixCompatible);
        if (canGhostInEditor) {
            this.runtime.setSuggestion(text);
        }
        else {
            this.runtime.setSuggestion(undefined);
        }
        const statusLabel = options?.restore ? "✦ restored prompt suggestion" : "✦ prompt suggestion";
        const statusHint = canGhostInEditor ? " · Space accepts" : " · ghost hidden";
        this.runtime.setPanelSuggestionStatus(`${statusLabel}${statusHint}`);
        refreshSuggesterUi(this.runtime);
    }
    async clearSuggestion(options) {
        if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch())
            return;
        this.runtime.setSuggestion(undefined);
        this.runtime.setPanelSuggestionStatus(undefined);
        refreshSuggesterUi(this.runtime);
    }
    async setUsage(usage) {
        const ctx = this.runtime.getContext();
        if (!ctx?.hasUI)
            return;
        if (usage.suggester.calls <= 0 && usage.seeder.calls <= 0) {
            ctx.ui.setStatus("suggester-usage", undefined);
            return;
        }
        ctx.ui.setStatus("suggester-usage", ctx.ui.theme.fg("dim", formatUsage(usage, this.runtime.getSuggesterModelDisplay())));
    }
}
