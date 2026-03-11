import type { SeedArtifact, SeedDraft, ReseedTrigger } from "../../domain/seed.js";
import type { SuggestionUsage } from "../../domain/suggestion.js";
import type { ModelRoleSettings } from "../../domain/state.js";
import type { SuggestionPromptContext } from "../services/prompt-context-builder.js";

export interface ModelClient {
	generateSeed(input: {
		reseedTrigger: ReseedTrigger;
		previousSeed: SeedArtifact | null;
		settings?: ModelRoleSettings;
	}): Promise<SeedDraft>;

	generateSuggestion(
		context: SuggestionPromptContext,
		settings?: ModelRoleSettings,
	): Promise<{
		text: string;
		usage?: SuggestionUsage;
	}>;
}
