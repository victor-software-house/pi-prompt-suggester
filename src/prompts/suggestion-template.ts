import type { SuggestionPromptContext } from "../app/services/prompt-context-builder.js";

function renderExamples(
	title: string,
	examples: Array<{ suggestedPrompt: string; actualUserPrompt: string; classification?: string; similarity?: number }>,
): string {
	if (examples.length === 0) return `${title}:\n(none)`;
	return `${title}:\n${examples
		.map((example) => {
			const suffix = example.classification ? ` [${example.classification}, sim=${example.similarity?.toFixed(2) ?? "n/a"}]` : "";
			return `- suggested: ${JSON.stringify(example.suggestedPrompt)}\n  user_sent: ${JSON.stringify(example.actualUserPrompt)}${suffix}`;
		})
		.join("\n")}`;
}

export function renderSuggestionPrompt(context: SuggestionPromptContext): string {
	const intentSeed = context.intentSeed
		? JSON.stringify(
				{
					projectIntentSummary: context.intentSeed.projectIntentSummary,
					topObjectives: context.intentSeed.topObjectives,
					constraints: context.intentSeed.constraints,
					openQuestions: context.intentSeed.openQuestions,
					keyFiles: context.intentSeed.keyFiles.map((file) => ({
						path: file.path,
						whyImportant: file.whyImportant,
					})),
				},
				null,
				2,
			)
		: "none";

	return `Role:
You generate the single best next user prompt for this pi coding-agent session.

Task:
Given the latest assistant completion, recent trajectory, and steering history, output the one prompt the user is most likely to want next.

LatestAssistantTurn:
${context.latestAssistantTurn || "(empty)"}

TurnStatus:
${context.turnStatus}

AbortContext:
${context.abortContextNote ?? "(none)"}

RecentUserPrompts:
${context.recentUserPrompts.length > 0 ? context.recentUserPrompts.map((prompt) => `- ${prompt}`).join("\n") : "(none)"}

ToolSignals:
${context.toolSignals.length > 0 ? context.toolSignals.map((signal) => `- ${signal}`).join("\n") : "(none)"}

TouchedFiles:
${context.touchedFiles.length > 0 ? context.touchedFiles.map((file) => `- ${file}`).join("\n") : "(none)"}

UnresolvedQuestions:
${context.unresolvedQuestions.length > 0 ? context.unresolvedQuestions.map((item) => `- ${item}`).join("\n") : "(none)"}

IntentSeed:
${intentSeed}

${renderExamples("RecentSteeringAccepted", context.recentAccepted)}

${renderExamples("RecentSteeringChanged", context.recentChanged)}

Instructions:
- Generate one concrete, immediately actionable user prompt.
- Preserve current trajectory unless the latest assistant output strongly suggests a pivot.
- If AbortContext is present, treat it as a strong signal that the user intentionally interrupted the previous execution.
- Learn from changed examples: avoid repeating rejected phrasing or direction.
- Prefer specific next actions over generic meta-prompts.
- You may return a multi-line prompt when it improves clarity.
- Keep the result under 1000 characters.
- If confidence is low, output exactly ${context.noSuggestionToken}
- Return plain text only. No explanation. No JSON.`;
}
