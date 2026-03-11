export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type InferenceDefault = "session-default";

export interface SeedConfig {
	keyFileGlobs: string[];
	maxDiffChars: number;
}

export interface ReseedConfig {
	enabled: boolean;
	checkOnSessionStart: boolean;
	checkAfterEveryTurn: boolean;
}

export interface SuggestionConfig {
	noSuggestionToken: string;
	fastPathContinueOnError: boolean;
	maxAssistantTurnChars: number;
	maxRecentUserPrompts: number;
	maxRecentUserPromptChars: number;
	maxToolSignals: number;
	maxToolSignalChars: number;
	maxTouchedFiles: number;
	maxUnresolvedQuestions: number;
	maxAbortContextChars: number;
	maxSuggestionChars: number;
	prefillOnlyWhenEditorEmpty: boolean;
}

export interface SteeringConfig {
	historyWindow: number;
	acceptedThreshold: number;
	maxAcceptedExamples: number;
	maxChangedExamples: number;
}

export interface LoggingConfig {
	level: "debug" | "info" | "warn" | "error";
}

export interface InferenceConfig {
	seederModel: string;
	suggesterModel: string;
	seederThinking: ThinkingLevel | InferenceDefault;
	suggesterThinking: ThinkingLevel | InferenceDefault;
}

export interface PromptSuggesterConfig {
	seed: SeedConfig;
	reseed: ReseedConfig;
	suggestion: SuggestionConfig;
	steering: SteeringConfig;
	logging: LoggingConfig;
	inference: InferenceConfig;
}
