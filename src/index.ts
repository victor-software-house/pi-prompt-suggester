import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent } from "@mariozechner/pi-coding-agent";
import { createAppComposition, type AppComposition } from "./composition/root.js";
import { buildLatestHistoricalTurnContext } from "./app/services/conversation-signals.js";
import { PiExtensionAdapter } from "./infra/pi/extension-adapter.js";
import { GhostSuggestionEditor } from "./infra/pi/ghost-suggestion-editor.js";
import {
	handleConfigCommand,
	handleModelCommand,
	handleSeedTraceCommand,
	handleSettingsUiCommand,
	handleThinkingCommand,
	renderStatus,
} from "./infra/pi/command-handlers.js";
import { refreshSuggesterUi } from "./infra/pi/ui-adapter.js";

async function handleHintBasedRegeneration(
	ctx: ExtensionCommandContext,
	composition: AppComposition,
	includeRejectedSuggestionText: boolean,
): Promise<void> {
	const turn = composition.runtimeRef.getLastTurnContext();
	if (!turn) {
		ctx.ui.notify("No recent turn context available yet. Run after at least one assistant completion.", "warning");
		return;
	}
	const state = await composition.stores.stateStore.load();
	if (!state.lastSuggestion?.text) {
		ctx.ui.notify("No active suggestion to reject.", "warning");
		return;
	}

	const hint = await ctx.ui.editor(
		includeRejectedSuggestionText ? "Hint for next suggestion (with rejected text)" : "Hint for next suggestion",
		"",
	);
	if (hint === undefined) {
		ctx.ui.notify("Hint canceled.", "info");
		return;
	}
	if (!hint.trim()) {
		ctx.ui.notify("Hint is empty. Nothing changed.", "warning");
		return;
	}

	const generationId = composition.runtimeRef.bumpEpoch();
	await composition.orchestrators.agentEnd.regenerateFromHint({
		turn,
		hint,
		includeRejectedSuggestionText,
		generationId,
	});
}

export default function suggester(pi: ExtensionAPI) {
	let compositionPromise: Promise<AppComposition> | undefined;

	function installGhostEditor(ctx: ExtensionContext, composition: AppComposition): void {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, kb) =>
			new GhostSuggestionEditor(
				tui,
				theme,
				kb,
				() => composition.runtimeRef.getSuggestion(),
				() => composition.runtimeRef.getSuggestionRevision(),
			),
		);
	}

	function scheduleGhostEditorReassertion(ctx: ExtensionContext, composition: AppComposition): void {
		const delaysMs = [50, 250, 1000, 3000, 8000];
		for (const delay of delaysMs) {
			setTimeout(() => {
				const active = composition.runtimeRef.getContext();
				if (active !== ctx) return;
				installGhostEditor(ctx, composition);
			}, delay);
		}
	}

	async function getComposition(): Promise<AppComposition> {
		if (!compositionPromise) {
			compositionPromise = createAppComposition(pi).catch((error) => {
				compositionPromise = undefined;
				throw error;
			});
		}
		return await compositionPromise;
	}

	async function setRuntimeContext(ctx: ExtensionContext): Promise<AppComposition> {
		const composition = await getComposition();
		composition.runtimeRef.setContext(ctx);
		return composition;
	}

	const adapter = new PiExtensionAdapter(pi, {
		onSessionStart: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			const generationId = composition.runtimeRef.bumpEpoch();
			if (ctx.hasUI) {
				ctx.ui.setFooter(undefined);
				installGhostEditor(ctx, composition);
				scheduleGhostEditorReassertion(ctx, composition);
				refreshSuggesterUi({
					getContext: () => composition.runtimeRef.getContext(),
					getEpoch: () => composition.runtimeRef.getEpoch(),
					getSuggestion: () => composition.runtimeRef.getSuggestion(),
					setSuggestion: (text) => composition.runtimeRef.setSuggestion(text),
					getPanelSuggestionStatus: () => composition.runtimeRef.getPanelSuggestionStatus(),
					setPanelSuggestionStatus: (text) => composition.runtimeRef.setPanelSuggestionStatus(text),
					getPanelLogStatus: () => composition.runtimeRef.getPanelLogStatus(),
					setPanelLogStatus: (status) => composition.runtimeRef.setPanelLogStatus(status),
					getSuggesterModelDisplay: () => {
						const activeCtx = composition.runtimeRef.getContext();
						if (!activeCtx?.model) return undefined;

						let provider = activeCtx.model.provider;
						let modelId = activeCtx.model.id;
						const configuredModel = composition.config.inference.suggesterModel.trim();
						if (configuredModel && configuredModel !== "session-default") {
							if (configuredModel.includes("/")) {
								const [configuredProvider, ...rest] = configuredModel.split("/");
								provider = configuredProvider;
								modelId = rest.join("/");
							} else {
								const matches = activeCtx.modelRegistry.getAll().filter((model) => model.id === configuredModel);
								if (matches.length === 1) {
									provider = matches[0].provider;
									modelId = matches[0].id;
								} else {
									modelId = configuredModel;
								}
							}
						}

						const thinking = composition.config.inference.suggesterThinking === "session-default"
							? pi.getThinkingLevel()
							: composition.config.inference.suggesterThinking;
						const providerCount = new Set(activeCtx.modelRegistry.getAll().map((model) => model.provider)).size;
						const modelLabel = providerCount > 1 ? `(${provider}) ${modelId}` : modelId;
						const thinkingLabel = thinking === "off" ? "thinking off" : thinking;
						return `${modelLabel} • ${thinkingLabel}`;
					},
					prefillOnlyWhenEditorEmpty: composition.config.suggestion.prefillOnlyWhenEditorEmpty,
				});
			}
			await composition.orchestrators.sessionStart.handle();

			const sourceLeafId = ctx.sessionManager.getLeafId() ?? `turn-${Date.now()}`;
			if (composition.runtimeRef.getLastBootstrappedLeafId() === sourceLeafId) return;

			const state = await composition.stores.stateStore.load();
			if (state.lastSuggestion?.turnId === sourceLeafId) {
				composition.runtimeRef.markBootstrappedLeafId(sourceLeafId);
				return;
			}

			const branchEntries = ctx.sessionManager.getBranch();
			const branchMessages = branchEntries
				.filter((entry): entry is typeof branchEntries[number] & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);
			const historicalTurn = buildLatestHistoricalTurnContext({
				sourceLeafId,
				branchMessages,
			});
			if (!historicalTurn) return;

			composition.runtimeRef.markBootstrappedLeafId(sourceLeafId);
			composition.runtimeRef.setLastTurnContext(historicalTurn);
			await composition.orchestrators.agentEnd.handle(historicalTurn, generationId);
		},
		onAgentEnd: async (turn, ctx) => {
			if (!turn) return;
			const composition = await setRuntimeContext(ctx);
			if (ctx.hasUI) {
				installGhostEditor(ctx, composition);
			}
			composition.runtimeRef.setLastTurnContext(turn);
			const generationId = composition.runtimeRef.bumpEpoch();
			await composition.orchestrators.agentEnd.handle(turn, generationId);
		},
		onUserSubmit: async (event: InputEvent, ctx) => {
			const composition = await setRuntimeContext(ctx);
			composition.runtimeRef.bumpEpoch();
			await composition.orchestrators.userSubmit.handle({
				turnId: ctx.sessionManager.getLeafId() ?? `input-${Date.now()}`,
				userPrompt: event.text,
				source: event.source,
			});
		},
		onReseedCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			await composition.orchestrators.reseedRunner.trigger({
				reason: "manual",
				changedFiles: [],
			});
			ctx.ui.notify("suggester reseed queued", "info");
		},
		onStatusCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			const [seed, state] = await Promise.all([
				composition.stores.seedStore.load(),
				composition.stores.stateStore.load(),
			]);
			pi.sendMessage(
				{
					customType: "prompt-suggester-status",
					content: renderStatus(seed, state, composition.config, ctx),
					display: true,
				},
				{ triggerTurn: false },
			);
		},
		onModelCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleModelCommand(args, ctx, composition);
		},
		onThinkingCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleThinkingCommand(args, ctx, composition);
		},
		onConfigCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleConfigCommand(args, ctx, composition);
		},
		onSettingsUiCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleSettingsUiCommand(ctx, composition);
		},
		onSeedTraceCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleSeedTraceCommand(args, pi, composition);
			ctx.ui.notify("suggester seed trace sent to chat", "info");
		},
		onHintSuggestCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleHintBasedRegeneration(ctx, composition, false);
		},
		onQuoteSuggestCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleHintBasedRegeneration(ctx, composition, true);
		},
	});

	adapter.register();
}
