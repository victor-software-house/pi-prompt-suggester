import type { PromptSuggesterConfig, ThinkingLevel } from "../../config/types.js";
import type { SuggestionUsage, TurnContext } from "../../domain/suggestion.js";
import type { RejectionHintState, SuggestionUsageStats } from "../../domain/state.js";
import type { Logger } from "../ports/logger.js";
import type { SeedStore } from "../ports/seed-store.js";
import type { StateStore } from "../ports/state-store.js";
import type { SuggestionEngine } from "../services/suggestion-engine.js";
import type { StalenessChecker } from "../services/staleness-checker.js";
import type { ReseedRunner } from "./reseed-runner.js";

export interface SuggestionSink {
	showSuggestion(text: string, options?: { restore?: boolean; generationId?: number }): Promise<void>;
	clearSuggestion(options?: { generationId?: number }): Promise<void>;
	setUsage(usage: SuggestionUsageStats): Promise<void>;
}

export interface TurnEndOrchestratorDeps {
	config: PromptSuggesterConfig;
	seedStore: SeedStore;
	stateStore: StateStore;
	stalenessChecker: StalenessChecker;
	reseedRunner: ReseedRunner;
	suggestionEngine: SuggestionEngine;
	suggestionSink: SuggestionSink;
	logger: Logger;
	checkForStaleness: boolean;
}

function accumulateUsage(current: SuggestionUsageStats, usage: SuggestionUsage): SuggestionUsageStats {
	return {
		calls: current.calls + 1,
		inputTokens: current.inputTokens + usage.inputTokens,
		outputTokens: current.outputTokens + usage.outputTokens,
		cacheReadTokens: current.cacheReadTokens + usage.cacheReadTokens,
		cacheWriteTokens: current.cacheWriteTokens + usage.cacheWriteTokens,
		totalTokens: current.totalTokens + usage.totalTokens,
		costTotal: current.costTotal + usage.costTotal,
		last: usage,
	};
}

function toThinking(value: string): ThinkingLevel | undefined {
	return value === "session-default" ? undefined : (value as ThinkingLevel);
}

function consumeHints(hints: RejectionHintState[]): RejectionHintState[] {
	return hints
		.map((hint) =>
			hint.remainingUses > 0
				? {
					...hint,
					remainingUses: hint.remainingUses - 1,
				}
				: hint,
		)
		.filter((hint) => hint.remainingUses > 0);
}

function toHintPromptContext(hints: RejectionHintState[]) {
	return hints.map((hint) => ({
		hint: hint.hint,
		includeRejectedSuggestionText: hint.includeRejectedSuggestionText,
		rejectedSuggestionText: hint.rejectedSuggestionText,
	}));
}

function createHintId(): string {
	return `hint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TurnEndOrchestrator {
	public constructor(private readonly deps: TurnEndOrchestratorDeps) {}

	public async handle(turn: TurnContext, generationId?: number): Promise<void> {
		this.deps.logger.info("suggestion.turn.received", {
			turnId: turn.turnId,
			status: turn.status,
			generationId,
		});
		if (this.deps.checkForStaleness) {
			const currentSeed = await this.deps.seedStore.load();
			const staleness = await this.deps.stalenessChecker.check(currentSeed);
			if (staleness.stale && staleness.trigger) {
				void this.deps.reseedRunner.trigger(staleness.trigger);
			}
		}

		const [seed, state] = await Promise.all([this.deps.seedStore.load(), this.deps.stateStore.load()]);
		const steering = {
			recentAccepted: state.steeringHistory.filter((event) => event.classification !== "changed_course").reverse(),
			recentChanged: state.steeringHistory.filter((event) => event.classification === "changed_course").reverse(),
		};
		const activeHints = state.rejectionHints.filter((hint) => hint.remainingUses > 0);
		const suggestion = await this.deps.suggestionEngine.suggest(
			turn,
			seed,
			steering,
			{
				modelRef:
					this.deps.config.inference.suggesterModel === "session-default"
						? undefined
						: this.deps.config.inference.suggesterModel,
				thinkingLevel: toThinking(this.deps.config.inference.suggesterThinking),
			},
			{
				feedbackHints: toHintPromptContext(activeHints),
			},
		);
		const nextUsage = suggestion.usage ? accumulateUsage(state.suggestionUsage, suggestion.usage) : state.suggestionUsage;
		const nextHints = consumeHints(state.rejectionHints);

		if (suggestion.kind === "no_suggestion") {
			this.deps.logger.info("suggestion.none", {
				turnId: turn.turnId,
				status: turn.status,
				tokens: suggestion.usage?.totalTokens,
				cost: suggestion.usage?.costTotal,
			});
			await this.deps.suggestionSink.clearSuggestion({ generationId });
			await this.deps.suggestionSink.setUsage(nextUsage);
			await this.deps.stateStore.save({
				...state,
				lastSuggestion: undefined,
				suggestionUsage: nextUsage,
				rejectionHints: nextHints,
			});
			return;
		}

		await this.deps.suggestionSink.showSuggestion(suggestion.text, { generationId });
		await this.deps.suggestionSink.setUsage(nextUsage);
		await this.deps.stateStore.save({
			...state,
			lastSuggestion: {
				text: suggestion.text,
				shownAt: turn.occurredAt,
				turnId: turn.turnId,
				sourceLeafId: turn.sourceLeafId,
			},
			suggestionUsage: nextUsage,
			rejectionHints: nextHints,
		});
		this.deps.logger.info("suggestion.generated", {
			turnId: turn.turnId,
			tokens: suggestion.usage?.totalTokens,
			cost: suggestion.usage?.costTotal,
			preview: suggestion.text.slice(0, 200),
		});
	}

	public async regenerateFromHint(input: {
		turn: TurnContext;
		hint: string;
		includeRejectedSuggestionText: boolean;
		generationId?: number;
	}): Promise<void> {
		const [seed, state] = await Promise.all([this.deps.seedStore.load(), this.deps.stateStore.load()]);
		const hint = input.hint.trim();
		if (!hint) return;
		const priorSuggestion = state.lastSuggestion?.text;
		const newHint: RejectionHintState = {
			id: createHintId(),
			hint,
			includeRejectedSuggestionText: input.includeRejectedSuggestionText,
			rejectedSuggestionText:
				input.includeRejectedSuggestionText && priorSuggestion ? priorSuggestion : undefined,
			remainingUses: this.deps.config.feedback.hintLifetimeSuggestions,
			createdAt: new Date().toISOString(),
		};
		const boundedHints = [...state.rejectionHints, newHint].slice(-this.deps.config.feedback.maxStoredHints);
		const steering = {
			recentAccepted: state.steeringHistory.filter((event) => event.classification !== "changed_course").reverse(),
			recentChanged: state.steeringHistory.filter((event) => event.classification === "changed_course").reverse(),
		};
		const suggestion = await this.deps.suggestionEngine.suggest(
			input.turn,
			seed,
			steering,
			{
				modelRef:
					this.deps.config.inference.suggesterModel === "session-default"
						? undefined
						: this.deps.config.inference.suggesterModel,
				thinkingLevel: toThinking(this.deps.config.inference.suggesterThinking),
			},
			{
				feedbackHints: toHintPromptContext(boundedHints),
				maxSuggestionChars: this.deps.config.feedback.maxHintedSuggestionChars,
			},
		);

		const nextHints = consumeHints(boundedHints);
		const nextUsage = suggestion.usage ? accumulateUsage(state.suggestionUsage, suggestion.usage) : state.suggestionUsage;
		const rejectionSteeringEvent = state.lastSuggestion
			? {
					turnId: state.lastSuggestion.turnId,
					suggestedPrompt: state.lastSuggestion.text,
					actualUserPrompt: `[hint] ${hint}`,
					classification: "changed_course" as const,
					similarity: 0,
					timestamp: new Date().toISOString(),
				}
			: undefined;
		const nextSteering = rejectionSteeringEvent
			? [...state.steeringHistory, rejectionSteeringEvent].slice(-this.deps.config.steering.historyWindow)
			: state.steeringHistory;

		if (suggestion.kind === "no_suggestion") {
			await this.deps.suggestionSink.clearSuggestion({ generationId: input.generationId });
			await this.deps.suggestionSink.setUsage(nextUsage);
			await this.deps.stateStore.save({
				...state,
				lastSuggestion: undefined,
				steeringHistory: nextSteering,
				suggestionUsage: nextUsage,
				rejectionHints: nextHints,
			});
			this.deps.logger.info("suggestion.hint.rejected.no_suggestion", {
				turnId: input.turn.turnId,
				hint,
				includeRejectedSuggestionText: input.includeRejectedSuggestionText,
			});
			return;
		}

		await this.deps.suggestionSink.showSuggestion(suggestion.text, { generationId: input.generationId });
		await this.deps.suggestionSink.setUsage(nextUsage);
		await this.deps.stateStore.save({
			...state,
			lastSuggestion: {
				text: suggestion.text,
				shownAt: new Date().toISOString(),
				turnId: input.turn.turnId,
				sourceLeafId: input.turn.sourceLeafId,
			},
			steeringHistory: nextSteering,
			suggestionUsage: nextUsage,
			rejectionHints: nextHints,
		});
		this.deps.logger.info("suggestion.hint.rejected.regenerated", {
			turnId: input.turn.turnId,
			hint,
			includeRejectedSuggestionText: input.includeRejectedSuggestionText,
			tokens: suggestion.usage?.totalTokens,
		});
	}
}
