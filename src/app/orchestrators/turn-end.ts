import type { PromptSuggesterConfig } from "../../config/types.js";
import { toInvocationThinkingLevel } from "../../config/inference.js";
import type { TurnContext } from "../../domain/suggestion.js";
import { addUsageStats } from "../../domain/usage.js";
import type { SuggestionUsageStats } from "../../domain/state.js";
import type { SuggesterVariantStore } from "../../infra/pi/suggester-variant-store.js";
import type { Logger } from "../ports/logger.js";
import type { SeedStore } from "../ports/seed-store.js";
import type { StateStore } from "../ports/state-store.js";
import type { SuggestionEngine } from "../services/suggestion-engine.js";
import type { StalenessChecker } from "../services/staleness-checker.js";
import type { ReseedRunner } from "./reseed-runner.js";

export interface SuggestionSink {
	showSuggestion(text: string, options?: { restore?: boolean; generationId?: number }): Promise<void>;
	clearSuggestion(options?: { generationId?: number }): Promise<void>;
	setUsage(usage: { suggester: SuggestionUsageStats; seeder: SuggestionUsageStats }): Promise<void>;
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
	variantStore?: SuggesterVariantStore;
}

export class TurnEndOrchestrator {
	public constructor(private readonly deps: TurnEndOrchestratorDeps) {}

	public async handle(turn: TurnContext, generationId?: number): Promise<void> {
		this.deps.logger.info("suggestion.turn.received", {
			turnId: turn.turnId,
			status: turn.status,
			generationId,
		});

		const [seed, state] = await Promise.all([this.deps.seedStore.load(), this.deps.stateStore.load()]);
		let turnsSinceLastStalenessCheck = state.turnsSinceLastStalenessCheck;
		if (this.deps.checkForStaleness && this.deps.config.reseed.checkAfterEveryTurn) {
			const interval = this.deps.config.reseed.turnCheckInterval;
			if (interval > 0) {
				turnsSinceLastStalenessCheck += 1;
				if (turnsSinceLastStalenessCheck >= interval) {
					const staleness = await this.deps.stalenessChecker.check(seed);
					this.deps.logger.debug("stale.check.completed", {
						stale: staleness.stale,
						reason: staleness.trigger?.reason,
						via: "turn_interval",
						interval,
					});
					turnsSinceLastStalenessCheck = 0;
					if (staleness.stale && staleness.trigger) {
						void this.deps.reseedRunner.trigger(staleness.trigger);
					}
				}
			} else {
				turnsSinceLastStalenessCheck = 0;
			}
		} else {
			turnsSinceLastStalenessCheck = 0;
		}
		const steering = {
			recentChanged: state.steeringHistory.filter((event) => event.classification === "changed_course").reverse(),
		};
		const effectiveConfig = this.deps.variantStore?.getEffectiveConfig(this.deps.config) ?? this.deps.config;
		const suggestion = await this.deps.suggestionEngine.suggest(
			turn,
			seed,
			steering,
			{
				modelRef:
					effectiveConfig.inference.suggesterModel === "session-default"
						? undefined
						: effectiveConfig.inference.suggesterModel,
				thinkingLevel: toInvocationThinkingLevel(effectiveConfig.inference.suggesterThinking),
			},
			effectiveConfig,
		);
		const nextUsage = suggestion.usage ? addUsageStats(state.suggestionUsage, suggestion.usage) : state.suggestionUsage;
		if (suggestion.usage) {
			await this.deps.stateStore.recordUsage("suggester", suggestion.usage);
		}

		if (suggestion.kind === "no_suggestion") {
			this.deps.logger.info("suggestion.none", {
				turnId: turn.turnId,
				status: turn.status,
				tokens: suggestion.usage?.totalTokens,
				cost: suggestion.usage?.costTotal,
			});
			await this.deps.suggestionSink.clearSuggestion({ generationId });
			await this.deps.suggestionSink.setUsage({ suggester: nextUsage, seeder: state.seederUsage });
			await this.deps.stateStore.save({
				...state,
				lastSuggestion: undefined,
				suggestionUsage: nextUsage,
				turnsSinceLastStalenessCheck,
			});
			return;
		}

		await this.deps.suggestionSink.showSuggestion(suggestion.text, { generationId });
		await this.deps.suggestionSink.setUsage({ suggester: nextUsage, seeder: state.seederUsage });
		await this.deps.stateStore.save({
			...state,
			lastSuggestion: {
				text: suggestion.text,
				shownAt: turn.occurredAt,
				turnId: turn.turnId,
				sourceLeafId: turn.sourceLeafId,
			},
			suggestionUsage: nextUsage,
			turnsSinceLastStalenessCheck,
		});
		this.deps.logger.info("suggestion.generated", {
			turnId: turn.turnId,
			tokens: suggestion.usage?.totalTokens,
			cost: suggestion.usage?.costTotal,
			preview: suggestion.text.slice(0, 200),
		});
	}
}
