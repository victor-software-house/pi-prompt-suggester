export type TurnStatus = "success" | "error" | "aborted";

export interface SuggestionUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costTotal: number;
}

export interface TurnContext {
	turnId: string;
	sourceLeafId: string;
	assistantText: string;
	status: TurnStatus;
	occurredAt: string;
	recentUserPrompts: string[];
	toolSignals: string[];
	touchedFiles: string[];
	unresolvedQuestions: string[];
	abortContextNote?: string;
}

export interface PromptSuggestion {
	kind: "suggestion";
	text: string;
	usage?: SuggestionUsage;
}

export interface NoSuggestion {
	kind: "no_suggestion";
	text: string;
	usage?: SuggestionUsage;
}

export type SuggestionResult = PromptSuggestion | NoSuggestion;
