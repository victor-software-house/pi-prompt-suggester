export type TurnStatus = "success" | "error" | "aborted";

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
}

export interface NoSuggestion {
	kind: "no_suggestion";
	text: string;
}

export type SuggestionResult = PromptSuggestion | NoSuggestion;
