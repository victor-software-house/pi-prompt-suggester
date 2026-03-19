import test from "node:test";
import assert from "node:assert/strict";
import { SuggestionEngine } from "../../dist/app/services/suggestion-engine.js";

function createConfig(overrides = {}) {
	return {
		schemaVersion: 7,
		seed: { maxDiffChars: 3000 },
		reseed: { enabled: true, checkOnSessionStart: true, checkAfterEveryTurn: true, turnCheckInterval: 10 },
		suggestion: {
			noSuggestionToken: "[no suggestion]",
			customInstruction: "",
			fastPathContinueOnError: true,
			maxAssistantTurnChars: 100000,
			maxRecentUserPrompts: 20,
			maxRecentUserPromptChars: 500,
			maxToolSignals: 8,
			maxToolSignalChars: 240,
			maxTouchedFiles: 8,
			maxUnresolvedQuestions: 6,
			maxAbortContextChars: 280,
			maxSuggestionChars: 200,
			prefillOnlyWhenEditorEmpty: true,
			strategy: "compact",
			transcriptMaxContextPercent: 70,
			transcriptMaxMessages: 120,
			transcriptMaxChars: 120000,
			transcriptRolloutPercent: 100,
			...(overrides.suggestion ?? {}),
		},
		steering: { historyWindow: 20, acceptedThreshold: 0.82, maxChangedExamples: 3 },
		logging: { level: "info" },
		inference: {
			seederModel: "session-default",
			suggesterModel: "session-default",
			seederThinking: "session-default",
			suggesterThinking: "session-default",
		},
	};
}

const turn = {
	turnId: "turn-1",
	sourceLeafId: "leaf-1",
	assistantText: "I can do that.",
	status: "success",
	occurredAt: "2026-03-15T00:00:00.000Z",
	recentUserPrompts: ["Fix the tests"],
	toolSignals: [],
	touchedFiles: [],
	unresolvedQuestions: [],
};

function createPromptContextBuilder() {
	return {
		build() {
			return {
				latestAssistantTurn: "compact",
				turnStatus: "success",
				intentSeed: null,
				recentUserPrompts: [],
				toolSignals: [],
				touchedFiles: [],
				unresolvedQuestions: [],
				recentChanged: [],
				customInstruction: "",
				noSuggestionToken: "[no suggestion]",
				maxSuggestionChars: 200,
			};
		},
	};
}

test("SuggestionEngine returns no_suggestion when model returns empty text", async () => {
	const engine = new SuggestionEngine({
		config: createConfig(),
		modelClient: {
			async generateSuggestion() {
				return { text: "", usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, costTotal: 0.001 } };
			},
		},
		promptContextBuilder: createPromptContextBuilder(),
	});

	const result = await engine.suggest(turn, null, { recentChanged: [] });
	assert.equal(result.kind, "no_suggestion");
	assert.ok(result.usage, "usage should still be reported for empty-text responses");
	assert.equal(result.usage.inputTokens, 10);
});

test("SuggestionEngine returns no_suggestion when model returns whitespace-only text", async () => {
	const engine = new SuggestionEngine({
		config: createConfig(),
		modelClient: {
			async generateSuggestion() {
				return { text: "   \n  \n   ", usage: undefined };
			},
		},
		promptContextBuilder: createPromptContextBuilder(),
	});

	const result = await engine.suggest(turn, null, { recentChanged: [] });
	assert.equal(result.kind, "no_suggestion");
});

test("SuggestionEngine returns no_suggestion when model returns only the no-suggestion token", async () => {
	const engine = new SuggestionEngine({
		config: createConfig(),
		modelClient: {
			async generateSuggestion() {
				return { text: "[no suggestion]", usage: undefined };
			},
		},
		promptContextBuilder: createPromptContextBuilder(),
	});

	const result = await engine.suggest(turn, null, { recentChanged: [] });
	assert.equal(result.kind, "no_suggestion");
	assert.equal(result.text, "[no suggestion]");
});

test("SuggestionEngine propagates model error when no fallback strategy is available", async () => {
	const engine = new SuggestionEngine({
		config: createConfig({ suggestion: { strategy: "transcript-cache" } }),
		modelClient: {
			async generateSuggestion() {
				throw new Error("provider timeout");
			},
		},
		promptContextBuilder: createPromptContextBuilder(),
		transcriptPromptContextBuilder: {
			build() {
				return {
					systemPrompt: "system",
					transcriptMessages: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "hello" }] }],
					transcriptMessageCount: 1,
					transcriptCharCount: 5,
					contextUsagePercent: 10,
					intentSeed: null,
					recentChanged: [],
					customInstruction: "",
					noSuggestionToken: "[no suggestion]",
					maxSuggestionChars: 200,
				};
			},
		},
	});

	// transcript-cache path throws, falls back to compact which also throws
	// The engine should propagate the error (error boundary is in the adapter/orchestrator layer)
	await assert.rejects(
		() => engine.suggest(turn, null, { recentChanged: [] }),
		{ message: "provider timeout" },
	);
});

test("SuggestionEngine transcript-cache error falls back to compact", async () => {
	let callCount = 0;
	const engine = new SuggestionEngine({
		config: createConfig({ suggestion: { strategy: "transcript-cache" } }),
		modelClient: {
			async generateSuggestion(context) {
				callCount += 1;
				if ("transcriptMessages" in context) {
					throw new Error("transcript provider error");
				}
				return { text: "fallback suggestion", usage: undefined };
			},
		},
		promptContextBuilder: createPromptContextBuilder(),
		transcriptPromptContextBuilder: {
			build() {
				return {
					systemPrompt: "system",
					transcriptMessages: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "hello" }] }],
					transcriptMessageCount: 1,
					transcriptCharCount: 5,
					contextUsagePercent: 10,
					intentSeed: null,
					recentChanged: [],
					customInstruction: "",
					noSuggestionToken: "[no suggestion]",
					maxSuggestionChars: 200,
				};
			},
		},
	});

	const result = await engine.suggest(turn, null, { recentChanged: [] });
	assert.equal(result.kind, "suggestion");
	assert.equal(result.text, "fallback suggestion");
	assert.equal(result.metadata.strategy, "compact");
	assert.ok(result.metadata.fallbackReason.startsWith("transcript_error:"));
	assert.equal(callCount, 2);
});
