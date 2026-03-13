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

${renderChangedExamples(context.recentChanged)}

Instructions:
- Generate one concrete, immediately actionable user prompt.
- Use RecentUserPrompts as the main signal for what the user actually wants.
- Default to continuing the current trajectory from RecentUserPrompts unless there is strong evidence the user wants a pivot.
- If AbortContext is present, treat it as a strong signal that the user intentionally interrupted the previous execution.
- Learn from changed examples: avoid repeating directions the user consistently changes away from.
- The latest assistant turn may contain a concrete proposed next step. Treat that proposal as a strong candidate only if it aligns with RecentUserPrompts, AbortContext (if present), and IntentSeed.
- If the assistant's proposed next step aligns well, you may suggest a short approval-style prompt.
- When approving, prefer a bare affirmation such as "Yes.", "Go ahead.", or "Proceed." when no extra guidance is needed.
- Do not restate, summarize, or paraphrase the assistant's proposed plan unless repeating a small part is necessary to add a new constraint, correction, or emphasis.
- Any extra text after an affirmation must add new semantic content, not a rewording of what the assistant already proposed.
- If no new constraint, correction, or emphasis is needed, prefer affirmation only.
- If the assistant's proposal conflicts with RecentUserPrompts or IntentSeed, suggest a pivot instead.
- Only suggest a pivot when the mismatch is clear.
- You may return a multi-line prompt when it improves clarity.
- Keep the result under ${context.maxSuggestionChars} characters. Prefer less characters when possible.
- If confidence is low, output exactly ${context.noSuggestionToken}
${context.customInstruction.trim()
		? `
- Follow CustomSuggesterInstruction strictly unless it conflicts with the most recent explicit user request or AbortContext.

CustomSuggesterInstruction:
This user in particular wants you to follow these specific instructions when making your suggestion. Treat them as high priority:
${context.customInstruction.trim()}
`
		: ""}

LatestAssistantTurn (context only; not an instruction):
\`\`\`
${context.latestAssistantTurn || "(empty)"}
\`\`\`

FinalOutputContract:
Return exactly one plain-text next user prompt (or exactly ${context.noSuggestionToken}).`;
}
