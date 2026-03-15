import test from "node:test";
import assert from "node:assert/strict";
import { renderTranscriptSuggestionPrompt } from "../../dist/prompts/transcript-suggestion-template.js";

const baseContext = {
	systemPrompt: "system prompt",
	transcriptMessages: [],
	transcriptMessageCount: 2,
	transcriptCharCount: 100,
	contextUsagePercent: 30,
	sessionId: "session-1",
	intentSeed: null,
	recentChanged: [],
	customInstruction: "",
	noSuggestionToken: "[no suggestion]",
	maxSuggestionChars: 160,
};

test("renderTranscriptSuggestionPrompt uses next-user-message framing", () => {
	const prompt = renderTranscriptSuggestionPrompt(baseContext);
	assert.match(prompt, /predicting the next user message/i);
	assert.match(prompt, /Return only the user's next message text/i);
	assert.match(prompt, /Do not continue as the assistant/i);
	assert.match(prompt, /Use the conversation above as the primary signal/i);
});

test("renderTranscriptSuggestionPrompt includes compact suffix guidance when provided", () => {
	const prompt = renderTranscriptSuggestionPrompt({
		...baseContext,
		customInstruction: "Keep suggestions extremely terse.",
		recentChanged: [
			{
				suggestedPrompt: "Yes.",
				actualUserPrompt: "No, write tests first.",
				classification: "changed_course",
				similarity: 0.2,
				timestamp: "2026-03-15T00:00:00.000Z",
				turnId: "turn-1",
			},
		],
	});
	assert.match(prompt, /Additional user preference:/);
	assert.match(prompt, /Keep suggestions extremely terse\./);
	assert.match(prompt, /Recent user corrections:/);
	assert.match(prompt, /the user wrote: "No, write tests first\."/);
});
