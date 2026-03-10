import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SuggestionSink } from "../../app/orchestrators/turn-end.js";

export interface UiContextLike {
	getContext(): ExtensionContext | undefined;
	getEpoch(): number;
	getSuggestion(): string | undefined;
	setSuggestion(text: string | undefined): void;
	prefillOnlyWhenEditorEmpty: boolean;
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
			"autoprompter",
			theme.fg("accent", options?.restore ? "✦ restored prompt suggestion" : "✦ prompt suggestion"),
		);

		if (canGhostInEditor) {
			this.runtime.setSuggestion(text);
			ctx.ui.setWidget("autoprompter", undefined);
			return;
		}

		this.runtime.setSuggestion(undefined);
		ctx.ui.setWidget(
			"autoprompter",
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
		ctx.ui.setWidget("autoprompter", undefined);
		ctx.ui.setStatus("autoprompter", undefined);
	}
}
