import { Key, matchesKey, wrapTextWithAnsi } from "@mariozechner/pi-tui";
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

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export class PiSuggestionSink implements SuggestionSink {
	private widgetSuggestion: string | undefined;
	private widgetWrappedLines: string[] = [];
	private widgetScrollOffset = 0;
	private widgetLastWrapWidth = 0;
	private widgetInputUnsubscribe: (() => void) | undefined;
	private widgetInputContext: ExtensionContext | undefined;

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

		const statusLabel = options?.restore ? "✦ restored prompt suggestion" : "✦ prompt suggestion";
		const statusHint = canGhostInEditor ? " · Space accepts" : " · Alt+Enter accepts";
		ctx.ui.setStatus("suggester", theme.fg("accent", `${statusLabel}${statusHint}`));

		if (canGhostInEditor) {
			this.runtime.setSuggestion(text);
			this.clearWidget(ctx);
			return;
		}

		this.runtime.setSuggestion(undefined);
		this.showScrollableWidget(ctx, text);
	}

	public async clearSuggestion(options?: { generationId?: number }): Promise<void> {
		if (options?.generationId !== undefined && options.generationId !== this.runtime.getEpoch()) return;
		const ctx = this.runtime.getContext();
		this.runtime.setSuggestion(undefined);
		if (!ctx?.hasUI) return;
		this.clearWidget(ctx);
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

	private clearWidget(ctx: ExtensionContext): void {
		this.widgetSuggestion = undefined;
		this.widgetWrappedLines = [];
		this.widgetScrollOffset = 0;
		this.widgetLastWrapWidth = 0;
		this.detachWidgetInputListener();
		ctx.ui.setWidget("suggester", undefined);
	}

	private showScrollableWidget(ctx: ExtensionContext, suggestion: string): void {
		const normalized = normalizeLineEndings(suggestion);
		if (this.widgetSuggestion !== normalized) {
			this.widgetSuggestion = normalized;
			this.widgetScrollOffset = 0;
		}
		this.ensureWidgetInputListener(ctx);
		this.renderScrollableWidget(ctx);
	}

	private ensureWidgetInputListener(ctx: ExtensionContext): void {
		if (this.widgetInputUnsubscribe && this.widgetInputContext === ctx) return;
		if (this.widgetInputUnsubscribe && this.widgetInputContext !== ctx) {
			this.widgetInputUnsubscribe();
			this.widgetInputUnsubscribe = undefined;
		}
		this.widgetInputContext = ctx;
		this.widgetInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			const currentCtx = this.runtime.getContext();
			if (!currentCtx?.hasUI || !this.widgetSuggestion) return undefined;

			if (matchesKey(data, Key.alt("enter"))) {
				const accepted = this.widgetSuggestion;
				currentCtx.ui.setEditorText(accepted);
				this.runtime.setSuggestion(undefined);
				this.clearWidget(currentCtx);
				currentCtx.ui.setStatus("suggester", currentCtx.ui.theme.fg("accent", "✦ prompt suggestion accepted"));
				return { consume: true };
			}

			const wrapWidth = this.computeWrapWidth();
			if (wrapWidth !== this.widgetLastWrapWidth) {
				this.widgetWrappedLines = wrapTextWithAnsi(this.widgetSuggestion, wrapWidth);
				this.widgetLastWrapWidth = wrapWidth;
				this.widgetScrollOffset = Math.min(this.widgetScrollOffset, this.maxScrollOffset());
				this.renderScrollableWidget(currentCtx);
			}

			if (matchesKey(data, Key.alt("down")) || matchesKey(data, Key.alt("j"))) {
				return this.scrollWidget(currentCtx, 1);
			}
			if (matchesKey(data, Key.alt("up")) || matchesKey(data, Key.alt("k"))) {
				return this.scrollWidget(currentCtx, -1);
			}
			if (matchesKey(data, Key.pageDown)) {
				return this.scrollWidget(currentCtx, this.pageStep());
			}
			if (matchesKey(data, Key.pageUp)) {
				return this.scrollWidget(currentCtx, -this.pageStep());
			}
			if (matchesKey(data, Key.home)) {
				return this.scrollWidgetTo(currentCtx, 0);
			}
			if (matchesKey(data, Key.end)) {
				return this.scrollWidgetTo(currentCtx, this.maxScrollOffset());
			}
			return undefined;
		});
	}

	private detachWidgetInputListener(): void {
		this.widgetInputUnsubscribe?.();
		this.widgetInputUnsubscribe = undefined;
		this.widgetInputContext = undefined;
	}

	private scrollWidget(ctx: ExtensionContext, delta: number): { consume: boolean } | undefined {
		if (delta === 0) return undefined;
		const next = Math.min(this.maxScrollOffset(), Math.max(0, this.widgetScrollOffset + delta));
		if (next === this.widgetScrollOffset) return { consume: true };
		this.widgetScrollOffset = next;
		this.renderScrollableWidget(ctx);
		return { consume: true };
	}

	private scrollWidgetTo(ctx: ExtensionContext, offset: number): { consume: boolean } | undefined {
		const next = Math.min(this.maxScrollOffset(), Math.max(0, offset));
		if (next === this.widgetScrollOffset) return { consume: true };
		this.widgetScrollOffset = next;
		this.renderScrollableWidget(ctx);
		return { consume: true };
	}

	private renderScrollableWidget(ctx: ExtensionContext): void {
		if (!this.widgetSuggestion) return;
		const wrapWidth = this.computeWrapWidth();
		if (wrapWidth !== this.widgetLastWrapWidth) {
			this.widgetWrappedLines = wrapTextWithAnsi(this.widgetSuggestion, wrapWidth);
			this.widgetLastWrapWidth = wrapWidth;
		}
		if (this.widgetWrappedLines.length === 0) {
			this.widgetWrappedLines = [""];
		}

		const viewportLines = this.viewportLines();
		this.widgetScrollOffset = Math.min(this.widgetScrollOffset, this.maxScrollOffset(viewportLines));
		const start = this.widgetScrollOffset;
		const visibleLines = this.widgetWrappedLines.slice(start, start + viewportLines);
		const shownStart = this.widgetWrappedLines.length === 0 ? 0 : start + 1;
		const shownEnd = Math.min(this.widgetWrappedLines.length, start + visibleLines.length);
		const hasOverflow = this.widgetWrappedLines.length > viewportLines;
		const scrollHint = hasOverflow
			? `(scroll ${shownStart}-${shownEnd}/${this.widgetWrappedLines.length}; Alt+↑/↓, Alt+K/J, PgUp/PgDn, Home/End, Alt+Enter accept)`
			: "(fits in widget; Alt+Enter accepts)";

		ctx.ui.setWidget(
			"suggester",
			[
				`${ctx.ui.theme.fg("accent", "Suggested next prompt")}`,
				...visibleLines,
				ctx.ui.theme.fg("dim", scrollHint),
				ctx.ui.theme.fg("dim", "(typed text no longer matches the suggestion, so it is shown below the editor)"),
			],
			{ placement: "belowEditor" },
		);
	}

	private computeWrapWidth(): number {
		return Math.max(20, (process.stdout.columns ?? 80) - 2);
	}

	private viewportLines(): number {
		const rows = process.stdout.rows ?? 24;
		return Math.max(4, Math.min(14, Math.floor(rows * 0.35)));
	}

	private pageStep(): number {
		return Math.max(3, this.viewportLines() - 1);
	}

	private maxScrollOffset(viewport = this.viewportLines()): number {
		return Math.max(0, this.widgetWrappedLines.length - viewport);
	}
}
