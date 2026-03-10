import type { ExtensionAPI, ExtensionContext, InputEvent } from "@mariozechner/pi-coding-agent";
import { createAppComposition, type AppComposition } from "./composition/root.js";
import { PiExtensionAdapter } from "./infra/pi/extension-adapter.js";
import { GhostSuggestionEditor } from "./infra/pi/ghost-suggestion-editor.js";

function renderStatus(seed: Awaited<ReturnType<AppComposition["stores"]["seedStore"]["load"]>>, state: Awaited<ReturnType<AppComposition["stores"]["stateStore"]["load"]>>): string {
	const steeringSummary = {
		exact: state.steeringHistory.filter((event) => event.classification === "accepted_exact").length,
		edited: state.steeringHistory.filter((event) => event.classification === "accepted_edited").length,
		changed: state.steeringHistory.filter((event) => event.classification === "changed_course").length,
	};

	return [
		"Autoprompter status",
		`- seed: ${seed ? `present (${seed.generatedAt})` : "missing"}`,
		`- key files: ${seed?.keyFiles.map((file) => file.path).join(", ") || "(none)"}`,
		`- last reseed reason: ${seed?.lastReseedReason ?? "(none)"}`,
		`- last suggestion: ${state.lastSuggestion?.text ?? "(none)"}`,
		`- steering history: exact=${steeringSummary.exact}, edited=${steeringSummary.edited}, changed=${steeringSummary.changed}`,
	].join("\n");
}

export default function autoprompter(pi: ExtensionAPI) {
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
			ctx.ui.notify("autoprompter reseed queued", "info");
		},
		onStatusCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			const [seed, state] = await Promise.all([
				composition.stores.seedStore.load(),
				composition.stores.stateStore.load(),
			]);
			pi.sendMessage(
				{
					customType: "autoprompter-status",
					content: renderStatus(seed, state),
					display: true,
				},
				{ triggerTurn: false },
			);
		},
		onClearCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			const state = await composition.stores.stateStore.load();
			await composition.stores.stateStore.save({
				...state,
				lastSuggestion: undefined,
			});
			composition.runtimeRef.setSuggestion(undefined);
			ctx.ui.setWidget("autoprompter", undefined, { placement: "belowEditor" });
			ctx.ui.setStatus("autoprompter", undefined);
			ctx.ui.notify("autoprompter suggestion cleared", "info");
		},
	});

	adapter.register();
}
