import type { Logger } from "../ports/logger.js";
import type { SeedStore } from "../ports/seed-store.js";
import type { StateStore } from "../ports/state-store.js";
import type { StalenessChecker } from "../services/staleness-checker.js";
import type { ReseedRunner } from "./reseed-runner.js";
import type { SuggestionSink } from "./turn-end.js";

export interface SessionStartOrchestratorDeps {
	seedStore: SeedStore;
	stateStore: StateStore;
	stalenessChecker: StalenessChecker;
	reseedRunner: ReseedRunner;
	suggestionSink: SuggestionSink;
	logger: Logger;
	checkForStaleness: boolean;
}

export class SessionStartOrchestrator {
	public constructor(private readonly deps: SessionStartOrchestratorDeps) {}

	public async handle(): Promise<void> {
		const state = await this.deps.stateStore.load();
		await this.deps.suggestionSink.setUsage(state.suggestionUsage);
		if (state.lastSuggestion) {
			await this.deps.suggestionSink.showSuggestion(state.lastSuggestion.text, { restore: true });
		}

		if (!this.deps.checkForStaleness) return;
		const seed = await this.deps.seedStore.load();
		const staleness = await this.deps.stalenessChecker.check(seed);
		this.deps.logger.debug("stale.check.completed", {
			stale: staleness.stale,
			reason: staleness.trigger?.reason,
		});
		if (staleness.stale && staleness.trigger) {
			await this.deps.reseedRunner.trigger(staleness.trigger);
		}
	}
}
