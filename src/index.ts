import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent } from "@mariozechner/pi-coding-agent";
import { createAppComposition, type AppComposition } from "./composition/root.js";
import type { LoggedEvent } from "./app/ports/event-log.js";
import type { ModelRole, ThinkingLevel } from "./domain/state.js";
import { PiExtensionAdapter } from "./infra/pi/extension-adapter.js";
import { GhostSuggestionEditor } from "./infra/pi/ghost-suggestion-editor.js";

const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
const MODEL_ROLES: ModelRole[] = ["seeder", "suggester"];

function modelToRef(model: Model<any> | undefined): string {
	if (!model) return "(none)";
	return `${model.provider}/${model.id}`;
}

function parseRole(token: string | undefined): ModelRole | undefined {
	if (!token) return undefined;
	return MODEL_ROLES.find((role) => role === token.trim().toLowerCase() as ModelRole);
}

function resolveModelRef(models: Model<any>[], raw: string): { ok: true; canonicalRef: string } | { ok: false; reason: string } {
	const value = raw.trim();
	if (!value) return { ok: false, reason: "Model reference is empty" };
	if (value.includes("/")) {
		const [provider, ...rest] = value.split("/");
		const id = rest.join("/");
		const match = models.find((model) => model.provider === provider && model.id === id);
		if (!match) return { ok: false, reason: `Model not found: ${value}` };
		return { ok: true, canonicalRef: `${match.provider}/${match.id}` };
	}

	const matches = models.filter((model) => model.id === value);
	if (matches.length === 0) return { ok: false, reason: `No model with id '${value}' found` };
	if (matches.length > 1) {
		return {
			ok: false,
			reason: `Model id '${value}' is ambiguous. Use provider/id. Matches: ${matches
				.slice(0, 6)
				.map((model) => `${model.provider}/${model.id}`)
				.join(", ")}`,
		};
	}
	const match = matches[0];
	return { ok: true, canonicalRef: `${match.provider}/${match.id}` };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value;
}

function renderSeedTrace(events: LoggedEvent[]): string {
	if (events.length === 0) {
		return "Autoprompter seed trace\n- no seeder events found in persistent logs.";
	}

	const withRunId = events.filter((event) => typeof event.meta?.runId === "string");
	const latestRunId = asString(withRunId.at(-1)?.meta?.runId);
	const scoped = latestRunId ? events.filter((event) => event.meta?.runId === latestRunId) : events;
	const lines = scoped.slice(-80).map((event) => {
		const time = event.at.split("T")[1]?.replace("Z", "") ?? event.at;
		const run = asString(event.meta?.runId);
		const step = event.meta?.step;
		const reason = asString(event.meta?.reason);
		const tool = asString(event.meta?.tool);
		const preview = asString(event.meta?.toolResultPreview) ?? asString(event.meta?.modelResponsePreview);
		const detailBits = [run ? `run=${run}` : undefined, step !== undefined ? `step=${step}` : undefined, tool ? `tool=${tool}` : undefined, reason ? `reason=${reason}` : undefined].filter(Boolean);
		const detail = detailBits.length > 0 ? ` (${detailBits.join(", ")})` : "";
		const previewSuffix = preview ? ` | ${preview.slice(0, 180)}` : "";
		return `- ${time} ${event.message}${detail}${previewSuffix}`;
	});

	return [
		"Autoprompter seed trace",
		`- events shown: ${lines.length}`,
		latestRunId ? `- latest run: ${latestRunId}` : "- latest run: (unknown)",
		"- log file: .pi/autoprompter/logs/events.ndjson",
		...lines,
	].join("\n");
}

function renderStatus(
	seed: Awaited<ReturnType<AppComposition["stores"]["seedStore"]["load"]>>,
	state: Awaited<ReturnType<AppComposition["stores"]["stateStore"]["load"]>>,
	ctx?: ExtensionContext,
): string {
	const steeringSummary = {
		exact: state.steeringHistory.filter((event) => event.classification === "accepted_exact").length,
		edited: state.steeringHistory.filter((event) => event.classification === "accepted_edited").length,
		changed: state.steeringHistory.filter((event) => event.classification === "changed_course").length,
	};
	const activeModel = modelToRef(ctx?.model);
	const seederModel = state.modelSettings.seeder.modelRef ?? `default(${activeModel})`;
	const suggesterModel = state.modelSettings.suggester.modelRef ?? `default(${activeModel})`;
	const seederThinking = state.modelSettings.seeder.thinkingLevel ?? "default(session)";
	const suggesterThinking = state.modelSettings.suggester.thinkingLevel ?? "default(session)";

	return [
		"Autoprompter status",
		`- seed: ${seed ? `present (${seed.generatedAt})` : "missing"}`,
		`- key files: ${seed?.keyFiles.map((file) => `${file.path} [${file.category}]`).join(", ") || "(none)"}`,
		`- last reseed reason: ${seed?.lastReseedReason ?? "(none)"}`,
		`- implementation status: ${seed?.implementationStatusSummary?.slice(0, 140) ?? "(none)"}`,
		`- models: seeder=${seederModel}, suggester=${suggesterModel}`,
		`- thinking: seeder=${seederThinking}, suggester=${suggesterThinking}`,
		`- prompt suggester usage: calls=${state.suggestionUsage.calls}, totalTokens=${state.suggestionUsage.totalTokens}, totalCost=$${state.suggestionUsage.costTotal.toFixed(4)}`,
		`- logs: .pi/autoprompter/logs/events.ndjson (use /autoprompter seed-trace)`,
		`- last suggestion: ${state.lastSuggestion?.text ?? "(none)"}`,
		`- steering history: exact=${steeringSummary.exact}, edited=${steeringSummary.edited}, changed=${steeringSummary.changed}`,
	].join("\n");
}

async function handleModelCommand(args: string, ctx: ExtensionCommandContext, composition: AppComposition): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || tokens[0] === "show") {
		const state = await composition.stores.stateStore.load();
		const activeModel = modelToRef(ctx.model);
		const seederModel = state.modelSettings.seeder.modelRef ?? `default(${activeModel})`;
		const suggesterModel = state.modelSettings.suggester.modelRef ?? `default(${activeModel})`;
		ctx.ui.notify(`autoprompter models: seeder=${seederModel}, suggester=${suggesterModel}`, "info");
		return;
	}

	let action: "set" | "clear" = "set";
	if (tokens[0] === "set" || tokens[0] === "clear") {
		action = tokens[0] as "set" | "clear";
		tokens.shift();
	}

	const role = parseRole(tokens[0]);
	if (!role) {
		ctx.ui.notify("Usage: /autoprompter model [show] | [set] <seeder|suggester> <provider/model|model-id> | clear <seeder|suggester>", "error");
		return;
	}

	const state = await composition.stores.stateStore.load();
	if (action === "clear" || (tokens[1] ?? "").toLowerCase() === "clear") {
		await composition.stores.stateStore.save({
			...state,
			modelSettings: {
				...state.modelSettings,
				[role]: {
					...state.modelSettings[role],
					modelRef: undefined,
				},
			},
		});
		ctx.ui.notify(`autoprompter ${role} model override cleared`, "info");
		return;
	}

	const rawModelRef = tokens.slice(1).join(" ").trim();
	if (!rawModelRef) {
		ctx.ui.notify("Missing model reference. Usage: /autoprompter model <seeder|suggester> <provider/model|model-id>", "error");
		return;
	}
	const resolved = resolveModelRef(ctx.modelRegistry.getAll(), rawModelRef);
	if (!resolved.ok) {
		ctx.ui.notify(resolved.reason, "error");
		return;
	}

	await composition.stores.stateStore.save({
		...state,
		modelSettings: {
			...state.modelSettings,
			[role]: {
				...state.modelSettings[role],
				modelRef: resolved.canonicalRef,
			},
		},
	});
	ctx.ui.notify(`autoprompter ${role} model set to ${resolved.canonicalRef}`, "info");
}

async function handleThinkingCommand(args: string, ctx: ExtensionCommandContext, composition: AppComposition): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || tokens[0] === "show") {
		const state = await composition.stores.stateStore.load();
		const seederThinking = state.modelSettings.seeder.thinkingLevel ?? "default(session)";
		const suggesterThinking = state.modelSettings.suggester.thinkingLevel ?? "default(session)";
		ctx.ui.notify(`autoprompter thinking: seeder=${seederThinking}, suggester=${suggesterThinking}`, "info");
		return;
	}

	let action: "set" | "clear" = "set";
	if (tokens[0] === "set" || tokens[0] === "clear") {
		action = tokens[0] as "set" | "clear";
		tokens.shift();
	}

	const role = parseRole(tokens[0]);
	if (!role) {
		ctx.ui.notify(
			"Usage: /autoprompter thinking [show] | [set] <seeder|suggester> <minimal|low|medium|high|xhigh> | clear <seeder|suggester>",
			"error",
		);
		return;
	}

	const state = await composition.stores.stateStore.load();
	if (action === "clear" || (tokens[1] ?? "").toLowerCase() === "clear") {
		await composition.stores.stateStore.save({
			...state,
			modelSettings: {
				...state.modelSettings,
				[role]: {
					...state.modelSettings[role],
					thinkingLevel: undefined,
				},
			},
		});
		ctx.ui.notify(`autoprompter ${role} thinking override cleared`, "info");
		return;
	}

	const rawLevel = tokens[1]?.trim().toLowerCase() as ThinkingLevel | undefined;
	if (!rawLevel || !THINKING_LEVELS.includes(rawLevel)) {
		ctx.ui.notify("Thinking level must be one of: minimal, low, medium, high, xhigh", "error");
		return;
	}

	await composition.stores.stateStore.save({
		...state,
		modelSettings: {
			...state.modelSettings,
			[role]: {
				...state.modelSettings[role],
				thinkingLevel: rawLevel,
			},
		},
	});
	ctx.ui.notify(`autoprompter ${role} thinking set to ${rawLevel}`, "info");
}

async function handleSeedTraceCommand(args: string, pi: ExtensionAPI, composition: AppComposition): Promise<void> {
	const limit = parsePositiveInt(args.trim() || undefined, 240);
	const events = await composition.eventLog.readRecent(limit, { messagePrefix: "seeder." });
	pi.sendMessage(
		{
			customType: "autoprompter-seed-trace",
			content: renderSeedTrace(events),
			display: true,
		},
		{ triggerTurn: false },
	);
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
					content: renderStatus(seed, state, ctx),
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
			ctx.ui.notify("autoprompter seed trace sent to chat", "info");
		},
	});

	adapter.register();
}
