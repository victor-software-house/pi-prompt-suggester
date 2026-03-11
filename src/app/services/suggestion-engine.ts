import type { PromptSuggesterConfig } from "../../config/types.js";
import type { SeedArtifact } from "../../domain/seed.js";
import type { SuggestionResult, TurnContext } from "../../domain/suggestion.js";
import type { ModelInvocationSettings } from "../ports/model-client.js";
import type { SteeringSlice } from "../../domain/steering.js";
import type { ModelClient } from "../ports/model-client.js";
import type { PromptContextBuilder } from "./prompt-context-builder.js";

function normalizeSuggestion(value: string, maxChars: number): string {
	const normalizedLineEndings = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const trimmedTrailing = normalizedLineEndings
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return trimmedTrailing.length > maxChars ? trimmedTrailing.slice(0, maxChars).trimEnd() : trimmedTrailing;
}

export interface SuggestionEngineDeps {
	config: PromptSuggesterConfig;
	modelClient: ModelClient;
	promptContextBuilder: PromptContextBuilder;
}

export class SuggestionEngine {
	public constructor(private readonly deps: SuggestionEngineDeps) {}

	public async suggest(
		turn: TurnContext,
		seed: SeedArtifact | null,
		steering: SteeringSlice,
		settings?: ModelInvocationSettings,
	): Promise<SuggestionResult> {
		if (this.deps.config.suggestion.fastPathContinueOnError && turn.status === "error") {
			return {
				kind: "suggestion",
				text: "continue",
			};
		}

		const context = this.deps.promptContextBuilder.build(turn, seed, steering);
		const raw = await this.deps.modelClient.generateSuggestion(context, settings);
		const normalized = normalizeSuggestion(raw.text, this.deps.config.suggestion.maxSuggestionChars);
		if (!normalized || normalized === this.deps.config.suggestion.noSuggestionToken) {
			return {
				kind: "no_suggestion",
				text: this.deps.config.suggestion.noSuggestionToken,
				usage: raw.usage,
			};
		}

		return {
			kind: "suggestion",
			text: normalized,
			usage: raw.usage,
		};
	}
}
