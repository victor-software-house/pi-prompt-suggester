import type { PromptSuggesterConfig, ThinkingLevel } from "../../config/types.js";
import type { SuggestionUsage, TurnContext } from "../../domain/suggestion.js";
import type { SuggestionUsageStats } from "../../domain/state.js";
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
				await this.deps.reseedRunner.trigger(staleness.trigger);
			}
		}

		const [seed, state] = await Promise.all([this.deps.seedStore.load(), this.deps.stateStore.load()]);
		const steering = {
			recentAccepted: state.steeringHistory.filter((event) => event.classification !== "changed_course").reverse(),
			recentChanged: state.steeringHistory.filter((event) => event.classification === "changed_course").reverse(),
		};
		const suggestion = await this.deps.suggestionEngine.suggest(turn, seed, steering, {
			modelRef:
				this.deps.config.inference.suggesterModel === "session-default"
					? undefined
					: this.deps.config.inference.suggesterModel,
			thinkingLevel: toThinking(this.deps.config.inference.suggesterThinking),
		});
		const nextUsage = suggestion.usage ? accumulateUsage(state.suggestionUsage, suggestion.usage) : state.suggestionUsage;

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
		});
		this.deps.logger.info("suggestion.generated", {
			turnId: turn.turnId,
			tokens: suggestion.usage?.totalTokens,
			cost: suggestion.usage?.costTotal,
			preview: suggestion.text.slice(0, 200),
		});
	}
}
