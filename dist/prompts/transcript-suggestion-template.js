function renderChangedExamples(examples) {
    if (examples.length === 0)
        return "(none)";
    return examples
        .map((example) => `- instead of ${JSON.stringify(example.suggestedPrompt)}\n  the user wrote: ${JSON.stringify(example.actualUserPrompt)}`)
        .join("\n");
}
function renderSeedSuffix(context) {
    const seed = context.intentSeed;
    if (!seed)
        return "(none)";
    return JSON.stringify({
        projectIntentSummary: seed.projectIntentSummary,
        objectivesSummary: seed.objectivesSummary,
        constraintsSummary: seed.constraintsSummary,
        principlesGuidelinesSummary: seed.principlesGuidelinesSummary,
        implementationStatusSummary: seed.implementationStatusSummary,
        topObjectives: seed.topObjectives,
        constraints: seed.constraints,
        openQuestions: seed.openQuestions,
        keyFiles: seed.keyFiles.map((file) => ({
            path: file.path,
            category: file.category,
            whyImportant: file.whyImportant,
        })),
        categoryFindings: seed.categoryFindings,
    }, null, 2);
}
export function renderTranscriptSuggestionPrompt(context) {
    return `You are predicting the next user message in an existing pi conversation.

Return only the user's next message text.
Do not continue as the assistant.
Do not explain the prediction.
If no plausible next user message is clear, return exactly ${context.noSuggestionToken}.

Additional project guidance:
${renderSeedSuffix(context)}

Recent user corrections:
${renderChangedExamples(context.recentChanged)}
${context.customInstruction.trim()
        ? `

Additional user preference:
${context.customInstruction.trim()}`
        : ""}

Guidance:
- Use the conversation above as the primary signal.
- Prefer a short user reply when that fits, including simple confirmations like "Yes.", "Go ahead.", or "Proceed.".
- Only add more detail when the user is likely to add a correction, constraint, or pivot.
- Learn from Recent user corrections and avoid repeating directions the user moved away from.
- Keep the result under ${context.maxSuggestionChars} characters. Prefer fewer when possible.`;
}
