import { CURRENT_CONFIG_SCHEMA_VERSION } from "./migrations.js";
import type {
	InferenceConfig,
	LoggingConfig,
	PromptSuggesterConfig,
	ReseedConfig,
	SeedConfig,
	SteeringConfig,
	SuggestionConfig,
} from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isPositiveInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isThinkingLevel(value: unknown): boolean {
	return ["minimal", "low", "medium", "high", "xhigh", "session-default"].includes(String(value));
}

function isModelSetting(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function isSchemaVersion(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value === CURRENT_CONFIG_SCHEMA_VERSION;
}

function isLoggingLevel(value: unknown): boolean {
	return ["debug", "info", "warn", "error"].includes(String(value));
}

type ValidatorMap<T> = {
	[K in keyof T]: (value: unknown) => boolean;
};

interface SectionNormalizationResult<T> {
	value: Partial<T>;
	changed: boolean;
	hasAny: boolean;
}

const seedValidators: ValidatorMap<SeedConfig> = {
	maxDiffChars: isPositiveInteger,
};

const reseedValidators: ValidatorMap<ReseedConfig> = {
	enabled: isBoolean,
	checkOnSessionStart: isBoolean,
	checkAfterEveryTurn: isBoolean,
	turnCheckInterval: isNonNegativeInteger,
};

const suggestionValidators: ValidatorMap<SuggestionConfig> = {
	noSuggestionToken: (value) => typeof value === "string",
	customInstruction: (value) => typeof value === "string",
	fastPathContinueOnError: isBoolean,
	maxAssistantTurnChars: isPositiveInteger,
	maxRecentUserPrompts: isPositiveInteger,
	maxRecentUserPromptChars: isPositiveInteger,
	maxToolSignals: isPositiveInteger,
	maxToolSignalChars: isPositiveInteger,
	maxTouchedFiles: isPositiveInteger,
	maxUnresolvedQuestions: isPositiveInteger,
	maxAbortContextChars: isPositiveInteger,
	maxSuggestionChars: isPositiveInteger,
	prefillOnlyWhenEditorEmpty: isBoolean,
};

const steeringValidators: ValidatorMap<SteeringConfig> = {
	historyWindow: isPositiveInteger,
	acceptedThreshold: (value) => typeof value === "number" && isPositiveNumber(value) && value <= 1,
	maxChangedExamples: isPositiveInteger,
};

const loggingValidators: ValidatorMap<LoggingConfig> = {
	level: isLoggingLevel,
};

const inferenceValidators: ValidatorMap<InferenceConfig> = {
	seederModel: isModelSetting,
	suggesterModel: isModelSetting,
	seederThinking: isThinkingLevel,
	suggesterThinking: isThinkingLevel,
};

function normalizeSection<T extends object>(
	input: unknown,
	defaults: T,
	validators: ValidatorMap<T>,
	includeDefaults: boolean,
): SectionNormalizationResult<T> {
	const source = isObject(input) ? input : undefined;
	let changed = input !== undefined && !isObject(input);

	if (source) {
		const supportedKeys = new Set(Object.keys(defaults as Record<string, unknown>));
		for (const key of Object.keys(source)) {
			if (!supportedKeys.has(key)) {
				changed = true;
			}
		}
	}

	const result: Partial<T> = {};
	let hasAny = false;
	const mutableResult = result as Record<string, unknown>;
	const defaultEntries = defaults as Record<string, unknown>;
	for (const key of Object.keys(defaultEntries) as Array<keyof T & string>) {
		const raw = source?.[key];
		if (raw === undefined) {
			if (includeDefaults) {
				mutableResult[key] = defaultEntries[key];
			}
			continue;
		}

		const validator = validators[key];
		if (validator(raw)) {
			mutableResult[key] = raw;
			hasAny = true;
		} else {
			changed = true;
			if (includeDefaults) {
				mutableResult[key] = defaultEntries[key];
			}
		}
	}

	return {
		value: result,
		changed,
		hasAny,
	};
}

function hasUnknownTopLevelKeys(config: Record<string, unknown>, defaults: PromptSuggesterConfig): boolean {
	const supportedKeys = new Set(Object.keys(defaults));
	for (const key of Object.keys(config)) {
		if (!supportedKeys.has(key)) return true;
	}
	return false;
}

export function normalizeConfig(
	config: unknown,
	defaults: PromptSuggesterConfig,
): { config: PromptSuggesterConfig; changed: boolean } {
	const source = isObject(config) ? config : undefined;
	let changed = config !== undefined && !isObject(config);
	if (source) {
		changed = changed || source.schemaVersion !== defaults.schemaVersion || hasUnknownTopLevelKeys(source, defaults);
	}

	const seed = normalizeSection(source?.seed, defaults.seed, seedValidators, true);
	const reseed = normalizeSection(source?.reseed, defaults.reseed, reseedValidators, true);
	const suggestion = normalizeSection(source?.suggestion, defaults.suggestion, suggestionValidators, true);
	const steering = normalizeSection(source?.steering, defaults.steering, steeringValidators, true);
	const logging = normalizeSection(source?.logging, defaults.logging, loggingValidators, true);
	const inference = normalizeSection(source?.inference, defaults.inference, inferenceValidators, true);

	changed =
		changed ||
		seed.changed ||
		reseed.changed ||
		suggestion.changed ||
		steering.changed ||
		logging.changed ||
		inference.changed;

	return {
		config: {
			schemaVersion: defaults.schemaVersion,
			seed: seed.value as SeedConfig,
			reseed: reseed.value as ReseedConfig,
			suggestion: suggestion.value as SuggestionConfig,
			steering: steering.value as SteeringConfig,
			logging: logging.value as LoggingConfig,
			inference: inference.value as InferenceConfig,
		},
		changed,
	};
}

export function normalizeOverrideConfig(
	config: unknown,
	defaults: PromptSuggesterConfig,
): { config: Record<string, unknown>; changed: boolean } {
	const source = isObject(config) ? config : undefined;
	let changed = !isObject(config);
	if (source) {
		changed = changed || source.schemaVersion !== defaults.schemaVersion || hasUnknownTopLevelKeys(source, defaults);
	}

	const seed = normalizeSection(source?.seed, defaults.seed, seedValidators, false);
	const reseed = normalizeSection(source?.reseed, defaults.reseed, reseedValidators, false);
	const suggestion = normalizeSection(source?.suggestion, defaults.suggestion, suggestionValidators, false);
	const steering = normalizeSection(source?.steering, defaults.steering, steeringValidators, false);
	const logging = normalizeSection(source?.logging, defaults.logging, loggingValidators, false);
	const inference = normalizeSection(source?.inference, defaults.inference, inferenceValidators, false);

	changed =
		changed ||
		seed.changed ||
		reseed.changed ||
		suggestion.changed ||
		steering.changed ||
		logging.changed ||
		inference.changed;

	const normalized: Record<string, unknown> = {
		schemaVersion: defaults.schemaVersion,
	};
	if (seed.hasAny) normalized.seed = seed.value;
	if (reseed.hasAny) normalized.reseed = reseed.value;
	if (suggestion.hasAny) normalized.suggestion = suggestion.value;
	if (steering.hasAny) normalized.steering = steering.value;
	if (logging.hasAny) normalized.logging = logging.value;
	if (inference.hasAny) normalized.inference = inference.value;

	return {
		config: normalized,
		changed,
	};
}

export function validateConfig(config: unknown): config is PromptSuggesterConfig {
	if (!isObject(config)) return false;
	if (!isSchemaVersion(config.schemaVersion)) return false;
	if (!isObject(config.seed) || !isObject(config.reseed) || !isObject(config.suggestion)) return false;
	if (!isObject(config.steering) || !isObject(config.logging) || !isObject(config.inference)) return false;

	const { seed, reseed, suggestion, steering, logging, inference } = config;
	if (!isPositiveInteger(seed.maxDiffChars)) return false;

	if (!isBoolean(reseed.enabled)) return false;
	if (!isBoolean(reseed.checkOnSessionStart)) return false;
	if (!isBoolean(reseed.checkAfterEveryTurn)) return false;
	if (!isNonNegativeInteger(reseed.turnCheckInterval)) return false;

	if (typeof suggestion.noSuggestionToken !== "string") return false;
	if (typeof suggestion.customInstruction !== "string") return false;
	if (!isBoolean(suggestion.fastPathContinueOnError)) return false;
	if (!isPositiveInteger(suggestion.maxAssistantTurnChars)) return false;
	if (!isPositiveInteger(suggestion.maxRecentUserPrompts)) return false;
	if (!isPositiveInteger(suggestion.maxRecentUserPromptChars)) return false;
	if (!isPositiveInteger(suggestion.maxToolSignals)) return false;
	if (!isPositiveInteger(suggestion.maxToolSignalChars)) return false;
	if (!isPositiveInteger(suggestion.maxTouchedFiles)) return false;
	if (!isPositiveInteger(suggestion.maxUnresolvedQuestions)) return false;
	if (!isPositiveInteger(suggestion.maxAbortContextChars)) return false;
	if (!isPositiveInteger(suggestion.maxSuggestionChars)) return false;
	if (!isBoolean(suggestion.prefillOnlyWhenEditorEmpty)) return false;

	if (!isPositiveInteger(steering.historyWindow)) return false;
	const acceptedThreshold = steering.acceptedThreshold;
	if (typeof acceptedThreshold !== "number" || !isPositiveNumber(acceptedThreshold) || acceptedThreshold > 1) return false;
	if (!isPositiveInteger(steering.maxChangedExamples)) return false;

	if (!isModelSetting(inference.seederModel)) return false;
	if (!isModelSetting(inference.suggesterModel)) return false;
	if (!isThinkingLevel(inference.seederThinking)) return false;
	if (!isThinkingLevel(inference.suggesterThinking)) return false;

	return isLoggingLevel(logging.level);
}
