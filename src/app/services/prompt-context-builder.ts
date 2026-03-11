import type { PromptSuggesterConfig } from "../../config/types.js";
import type { SeedArtifact } from "../../domain/seed.js";
import type { TurnContext } from "../../domain/suggestion.js";
import type { SteeringSlice } from "../../domain/steering.js";

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}…`;
}

export interface SuggestionFeedbackHint {
	hint: string;
	includeRejectedSuggestionText: boolean;
	rejectedSuggestionText?: string;
}

export interface SuggestionPromptContext {
	latestAssistantTurn: string;
	turnStatus: TurnContext["status"];
	intentSeed: SeedArtifact | null;
	recentUserPrompts: string[];
	toolSignals: string[];
	touchedFiles: string[];
	unresolvedQuestions: string[];
	abortContextNote?: string;
	recentChanged: SteeringSlice["recentChanged"];
	rejectionHints: SuggestionFeedbackHint[];
	noSuggestionToken: string;
	maxSuggestionChars: number;
}

export class PromptContextBuilder {
	public constructor(private readonly config: PromptSuggesterConfig) {}

	public build(
		turn: TurnContext,
		seed: SeedArtifact | null,
		steering: SteeringSlice,
		rejectionHints: SuggestionFeedbackHint[] = [],
	): SuggestionPromptContext {
		return {
			latestAssistantTurn: truncate(turn.assistantText, this.config.suggestion.maxAssistantTurnChars),
			turnStatus: turn.status,
			intentSeed: seed,
			recentUserPrompts: turn.recentUserPrompts
				.slice(0, this.config.suggestion.maxRecentUserPrompts)
				.map((prompt) => truncate(prompt, this.config.suggestion.maxRecentUserPromptChars)),
			toolSignals: turn.toolSignals
				.slice(0, this.config.suggestion.maxToolSignals)
				.map((signal) => truncate(signal, this.config.suggestion.maxToolSignalChars)),
			touchedFiles: turn.touchedFiles.slice(0, this.config.suggestion.maxTouchedFiles),
			unresolvedQuestions: turn.unresolvedQuestions.slice(0, this.config.suggestion.maxUnresolvedQuestions),
			abortContextNote: turn.abortContextNote
				? truncate(turn.abortContextNote, this.config.suggestion.maxAbortContextChars)
				: undefined,
			recentChanged: steering.recentChanged.slice(0, this.config.steering.maxChangedExamples),
			rejectionHints,
			noSuggestionToken: this.config.suggestion.noSuggestionToken,
			maxSuggestionChars: this.config.suggestion.maxSuggestionChars,
		};
	}
}
