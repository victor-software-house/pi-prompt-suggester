import type { SteeringEvent } from "./steering.js";
import type { SuggestionUsage } from "./suggestion.js";

export const CURRENT_RUNTIME_STATE_VERSION = 6;

export interface LastSuggestionState {
	text: string;
	shownAt: string;
	turnId: string;
	sourceLeafId: string;
}

export interface SuggestionUsageStats {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costTotal: number;
	last?: SuggestionUsage;
}

export interface RejectionHintState {
	id: string;
	hint: string;
	includeRejectedSuggestionText: boolean;
	rejectedSuggestionText?: string;
	remainingUses: number;
	createdAt: string;
}

export interface RuntimeState {
	stateVersion: number;
	lastSuggestion?: LastSuggestionState;
	steeringHistory: SteeringEvent[];
	suggestionUsage: SuggestionUsageStats;
	seederUsage: SuggestionUsageStats;
	rejectionHints: RejectionHintState[];
}

export const INITIAL_RUNTIME_STATE: RuntimeState = {
	stateVersion: CURRENT_RUNTIME_STATE_VERSION,
	steeringHistory: [],
	suggestionUsage: {
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costTotal: 0,
	},
	seederUsage: {
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costTotal: 0,
	},
	rejectionHints: [],
};
