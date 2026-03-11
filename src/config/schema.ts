import type { AutoprompterConfig } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validateConfig(config: unknown): config is AutoprompterConfig {
	if (!isObject(config)) return false;
	if (!isObject(config.seed) || !isObject(config.reseed) || !isObject(config.suggestion)) return false;
	if (!isObject(config.steering) || !isObject(config.logging)) return false;

	const { seed, reseed, suggestion, steering, logging } = config;
	if (!Array.isArray(seed.keyFileGlobs) || !seed.keyFileGlobs.every((value) => typeof value === "string")) return false;
	if (!isPositiveInteger(seed.maxDiffChars)) return false;

	if (typeof reseed.enabled !== "boolean") return false;
	if (typeof reseed.checkOnSessionStart !== "boolean") return false;
	if (typeof reseed.checkAfterEveryTurn !== "boolean") return false;
	if (!isPositiveInteger(reseed.maxConcurrentJobs)) return false;

	if (typeof suggestion.noSuggestionToken !== "string") return false;
	if (typeof suggestion.fastPathContinueOnError !== "boolean") return false;
	if (!isPositiveInteger(suggestion.maxAssistantTurnChars)) return false;
	if (!isPositiveInteger(suggestion.maxRecentUserPrompts)) return false;
	if (!isPositiveInteger(suggestion.maxRecentUserPromptChars)) return false;
	if (!isPositiveInteger(suggestion.maxToolSignals)) return false;
	if (!isPositiveInteger(suggestion.maxToolSignalChars)) return false;
	if (!isPositiveInteger(suggestion.maxSuggestionChars)) return false;
	if (typeof suggestion.prefillOnlyWhenEditorEmpty !== "boolean") return false;

	if (!isPositiveInteger(steering.historyWindow)) return false;
	const acceptedThreshold = steering.acceptedThreshold;
	if (typeof acceptedThreshold !== "number" || !isPositiveNumber(acceptedThreshold) || acceptedThreshold > 1) return false;
	if (!isPositiveInteger(steering.maxAcceptedExamples)) return false;
	if (!isPositiveInteger(steering.maxChangedExamples)) return false;

	return ["debug", "info", "warn", "error"].includes(String(logging.level));
}
