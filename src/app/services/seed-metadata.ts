import { createHash } from "node:crypto";
import type { PromptSuggesterConfig } from "../../config/types.js";
import { CURRENT_GENERATOR_VERSION, SEEDER_PROMPT_VERSION, SUGGESTION_PROMPT_VERSION } from "../../domain/seed.js";

export function computeConfigFingerprint(config: PromptSuggesterConfig): string {
	const hash = createHash("sha256");
	hash.update(
		JSON.stringify({
			seed: config.seed,
			reseed: config.reseed,
			suggestion: config.suggestion,
			steering: config.steering,
			logging: config.logging,
			inference: config.inference,
			versions: {
				generator: CURRENT_GENERATOR_VERSION,
				seederPrompt: SEEDER_PROMPT_VERSION,
				suggestionPrompt: SUGGESTION_PROMPT_VERSION,
			},
		}),
	);
	return `sha256:${hash.digest("hex")}`;
}
