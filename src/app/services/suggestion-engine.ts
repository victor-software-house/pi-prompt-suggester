import type { PromptSuggesterConfig } from "../../config/types.js";
import type { SeedArtifact } from "../../domain/seed.js";
import type { SuggestionResult, TurnContext } from "../../domain/suggestion.js";
import type { ModelInvocationSettings } from "../ports/model-client.js";
import type { SteeringSlice } from "../../domain/steering.js";
import type { ModelClient } from "../ports/model-client.js";
import type { PromptContextBuilder } from "./prompt-context-builder.js";
import type { TranscriptPromptContextBuilder } from "./transcript-prompt-context-builder.js";

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

function stableSamplePercent(seed: string): number {
	let hash = 0;
	for (let i = 0; i < seed.length; i += 1) {
		hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
	}
	return hash % 100;
}

export interface SuggestionEngineDeps {
	config: PromptSuggesterConfig;
	modelClient: ModelClient;
	promptContextBuilder: PromptContextBuilder;
	transcriptPromptContextBuilder?: TranscriptPromptContextBuilder;
}

export class SuggestionEngine {
	public constructor(private readonly deps: SuggestionEngineDeps) {}

	public async suggest(
		turn: TurnContext,
		seed: SeedArtifact | null,
		steering: SteeringSlice,
		settings?: ModelInvocationSettings,
		overrideConfig?: PromptSuggesterConfig,
	): Promise<SuggestionResult> {
		const config = overrideConfig ?? this.deps.config;
		if (config.suggestion.fastPathContinueOnError && turn.status !== "success") {
			return {
				kind: "suggestion",
				text: "continue",
			};
		}

		const raw = await this.generateWithBestAvailableStrategy(turn, seed, steering, settings, config);
		const normalized = normalizeSuggestion(raw.text, config.suggestion.maxSuggestionChars);
		if (!normalized || normalized === config.suggestion.noSuggestionToken) {
			return {
				kind: "no_suggestion",
				text: config.suggestion.noSuggestionToken,
				usage: raw.usage,
			};
		}

		return {
			kind: "suggestion",
			text: normalized,
			usage: raw.usage,
		};
	}

	private async generateWithBestAvailableStrategy(
		turn: TurnContext,
		seed: SeedArtifact | null,
		steering: SteeringSlice,
		settings: ModelInvocationSettings | undefined,
		config: PromptSuggesterConfig,
	) {
		if (config.suggestion.strategy === "transcript-cache" && this.deps.transcriptPromptContextBuilder) {
			const sampledOut =
				config.suggestion.transcriptRolloutPercent < 100 &&
				stableSamplePercent(turn.turnId || turn.sourceLeafId) >= config.suggestion.transcriptRolloutPercent;
			if (!sampledOut) {
				try {
					const transcriptContext = this.deps.transcriptPromptContextBuilder.build(seed, steering, config);
					const overContextLimit =
						typeof transcriptContext.contextUsagePercent === "number" &&
						transcriptContext.contextUsagePercent > config.suggestion.transcriptMaxContextPercent;
					const overMessageLimit = transcriptContext.transcriptMessageCount > config.suggestion.transcriptMaxMessages;
					const overCharLimit = transcriptContext.transcriptCharCount > config.suggestion.transcriptMaxChars;
					if (!overContextLimit && !overMessageLimit && !overCharLimit) {
						return await this.deps.modelClient.generateSuggestion(transcriptContext, settings);
					}
				} catch {
					// Fall back to the compact strategy below.
				}
			}
		}

		const context = this.deps.promptContextBuilder.build(turn, seed, steering, config);
		return await this.deps.modelClient.generateSuggestion(context, settings);
	}
}
