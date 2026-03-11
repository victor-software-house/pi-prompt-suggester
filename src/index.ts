import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent } from "@mariozechner/pi-coding-agent";
import { createAppComposition, type AppComposition } from "./composition/root.js";
import { PiExtensionAdapter } from "./infra/pi/extension-adapter.js";
import { GhostSuggestionEditor } from "./infra/pi/ghost-suggestion-editor.js";
import {
	handleModelCommand,
	handleSeedTraceCommand,
	handleThinkingCommand,
	renderStatus,
} from "./infra/pi/command-handlers.js";
import { installWrappedFooter } from "./infra/pi/wrapped-footer.js";

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
			composition.runtimeRef.bumpEpoch();
			if (ctx.hasUI) {
				installWrappedFooter(ctx);
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
			await composition.orchestrators.sessionStart.handle();
		},
		onAgentEnd: async (turn, ctx) => {
			if (!turn) return;
			const composition = await setRuntimeContext(ctx);
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
