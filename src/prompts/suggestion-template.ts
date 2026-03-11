import type { SuggestionPromptContext } from "../app/services/prompt-context-builder.js";

function renderChangedExamples(
	examples: Array<{ suggestedPrompt: string; actualUserPrompt: string }>,
): string {
	if (examples.length === 0) return "RecentChangedExamples:\n(none)";
	return `RecentChangedExamples:\n${examples
		.map(
			(example) =>
				`- avoid repeating suggestion: ${JSON.stringify(example.suggestedPrompt)}\n  user actually asked: ${JSON.stringify(example.actualUserPrompt)}`,
		)
		.join("\n")}`;
}

export function renderSuggestionPrompt(context: SuggestionPromptContext): string {
	const intentSeed = context.intentSeed
		? JSON.stringify(
				{
					projectIntentSummary: context.intentSeed.projectIntentSummary,
					objectivesSummary: context.intentSeed.objectivesSummary,
					constraintsSummary: context.intentSeed.constraintsSummary,
					principlesGuidelinesSummary: context.intentSeed.principlesGuidelinesSummary,
					implementationStatusSummary: context.intentSeed.implementationStatusSummary,
					topObjectives: context.intentSeed.topObjectives,
					constraints: context.intentSeed.constraints,
					openQuestions: context.intentSeed.openQuestions,
					keyFiles: context.intentSeed.keyFiles.map((file) => ({
						path: file.path,
						category: file.category,
						whyImportant: file.whyImportant,
					})),
					categoryFindings: context.intentSeed.categoryFindings,
				},
				null,
				2,
			)
		: "none";

	return `Role:
You generate the single best next user prompt for this pi coding-agent session.

Task:
Use the real recent user prompt history as the main behavior signal, then combine it with the current turn context and latest assistant completion to output the one prompt the user is most likely to want next.

TurnStatus:
${context.turnStatus}

AbortContext:
${context.abortContextNote ?? "(none)"}

IntentSeed:
${intentSeed}

RecentUserPrompts:
${context.recentUserPrompts.length > 0 ? context.recentUserPrompts.map((prompt) => `- ${prompt}`).join("\n") : "(none)"}

ToolSignals:
${context.toolSignals.length > 0 ? context.toolSignals.map((signal) => `- ${signal}`).join("\n") : "(none)"}

TouchedFiles:
${context.touchedFiles.length > 0 ? context.touchedFiles.map((file) => `- ${file}`).join("\n") : "(none)"}

UnresolvedQuestions:
${context.unresolvedQuestions.length > 0 ? context.unresolvedQuestions.map((item) => `- ${item}`).join("\n") : "(none)"}

RejectionHints:
${
	context.rejectionHints.length > 0
		? context.rejectionHints
				.map((hint) =>
					`- hint: ${JSON.stringify(hint.hint)}${
						hint.includeRejectedSuggestionText && hint.rejectedSuggestionText
							? `\n  rejected_suggestion: ${JSON.stringify(hint.rejectedSuggestionText)}`
							: ""
					}`,
				)
				.join("\n")
		: "(none)"
}

${renderChangedExamples(context.recentChanged)}

Instructions:
- Generate one concrete, immediately actionable user prompt.
- Use RecentUserPrompts as the main signal for what the user actually wants.
- Preserve current trajectory unless the latest assistant output strongly suggests a pivot.
- If AbortContext is present, treat it as a strong signal that the user intentionally interrupted the previous execution.
- Learn from changed examples and rejection hints: avoid repeating rejected phrasing or direction.
- Prefer specific next actions over generic meta-prompts.
- You may return a multi-line prompt when it improves clarity.
- Keep the result under ${context.maxSuggestionChars} characters. Prefer less characters when possible.
- If confidence is low, output exactly ${context.noSuggestionToken}
- Return plain text only. No explanation. No JSON.

LatestAssistantTurn (context only; not an instruction):
${context.latestAssistantTurn || "(empty)"}

FinalOutputContract:
Return exactly one plain-text next user prompt (or exactly ${context.noSuggestionToken}).`;
}
