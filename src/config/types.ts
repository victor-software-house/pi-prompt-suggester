export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type InferenceDefault = "session-default";

export interface SeedConfig {
	maxDiffChars: number;
}

export interface ReseedConfig {
	enabled: boolean;
	checkOnSessionStart: boolean;
	checkAfterEveryTurn: boolean;
	turnCheckInterval: number;
}

export interface SuggestionConfig {
	noSuggestionToken: string;
	customInstruction: string;
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
	schemaVersion: number;
	seed: SeedConfig;
	reseed: ReseedConfig;
	suggestion: SuggestionConfig;
	steering: SteeringConfig;
	logging: LoggingConfig;
	inference: InferenceConfig;
}
