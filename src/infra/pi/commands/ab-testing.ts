import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { SelectList, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { AppComposition } from "../../../composition/root.js";
import { PromptContextBuilder } from "../../../app/services/prompt-context-builder.js";
import { SuggestionEngine } from "../../../app/services/suggestion-engine.js";
import { PiModelClient } from "../../model/pi-model-client.js";
import { toInvocationThinkingLevel } from "../../../config/inference.js";
import type { InferenceDefault, ThinkingLevel } from "../../../config/types.js";
import type { AbWinner, SuggesterVariant } from "../suggester-variant-store.js";
import { getModelSelectionOptions, resolveModelRef, SESSION_DEFAULT, THINKING_LEVELS } from "./shared.js";

function summarizeVariant(variant: SuggesterVariant): string {
	const parts: string[] = [];
	if (variant.customInstruction?.trim()) parts.push(`instr: ${variant.customInstruction.trim().replace(/\s+/g, " ").slice(0, 36)}`);
	if (variant.suggesterModel) parts.push(`model: ${variant.suggesterModel}`);
	if (variant.suggesterThinking) parts.push(`thinking: ${variant.suggesterThinking}`);
	if (variant.maxSuggestionChars) parts.push(`max: ${variant.maxSuggestionChars}`);
	return parts.join(" · ") || "inherits defaults";
}

async function promptPositiveIntOrClear(
	ctx: ExtensionCommandContext,
	label: string,
	currentValue: number | undefined,
): Promise<number | undefined | null> {
	const raw = await ctx.ui.editor(label, currentValue ? String(currentValue) : "");
	if (raw === undefined) return undefined;
	if (!raw.trim()) return null;
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		ctx.ui.notify("Value must be a positive integer or blank to inherit.", "error");
		return undefined;
	}
	return parsed;
}

async function promptVariantModel(
	ctx: ExtensionCommandContext,
	currentValue: string | undefined,
): Promise<string | undefined | null> {
	const options = ["(inherit)", ...(await getModelSelectionOptions(ctx))];
	const selected = await ctx.ui.select(`Suggester model (current: ${currentValue ?? "inherit"})`, options);
	if (!selected) return undefined;
	if (selected === "(inherit)") return null;
	const resolved = resolveModelRef(ctx.modelRegistry.getAll(), selected);
	if (!resolved.ok) {
		ctx.ui.notify(resolved.reason, "error");
		return undefined;
	}
	return resolved.canonicalRef;
}

async function promptVariantThinking(
	ctx: ExtensionCommandContext,
	currentValue: string | undefined,
): Promise<ThinkingLevel | InferenceDefault | undefined | null> {
	const selected = await ctx.ui.select(
		`Suggester thinking (current: ${currentValue ?? "inherit"})`,
		["(inherit)", ...THINKING_LEVELS, SESSION_DEFAULT],
	);
	if (!selected) return undefined;
	return selected === "(inherit)" ? null : (selected as ThinkingLevel | InferenceDefault);
}

async function editVariantUi(
	ctx: ExtensionCommandContext,
	composition: AppComposition,
	variantName: string,
): Promise<void> {
	const store = composition.stores.variantStore;
	let variant = { ...(store.getVariant(variantName) ?? {}) };

	while (true) {
		const items = [
			{ value: "customInstruction", label: "Custom instruction", description: variant.customInstruction?.trim() ? variant.customInstruction.trim().replace(/\s+/g, " ").slice(0, 60) : "inherit" },
			{ value: "suggesterModel", label: "Suggester model", description: variant.suggesterModel ?? "inherit" },
			{ value: "suggesterThinking", label: "Suggester thinking", description: variant.suggesterThinking ?? "inherit" },
			{ value: "maxSuggestionChars", label: "Max suggestion chars", description: variant.maxSuggestionChars ? String(variant.maxSuggestionChars) : "inherit" },
			{ value: "save", label: "Save", description: "Apply variant changes" },
			{ value: "back", label: "Back", description: "Discard / leave editor" },
		];
		const action = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const selectList = new SelectList(items, Math.min(items.length + 1, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(String(item.value));
			selectList.onCancel = () => done(null);
			return {
				render(width: number): string[] {
					return [
						theme.fg("accent", theme.bold(`Edit variant: ${variantName}`)),
						theme.fg("dim", "Enter select • Esc back"),
						"",
						...selectList.render(width),
					];
				},
				invalidate() {
					selectList.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });

		if (!action || action === "back") return;
		if (action === "save") {
			await store.updateVariant(variantName, variant);
			ctx.ui.notify(`Updated variant '${variantName}'.`, "info");
			return;
		}

		if (action === "customInstruction") {
			const next = await ctx.ui.editor(`Custom instruction for ${variantName} (blank = inherit)`, variant.customInstruction ?? "");
			if (next === undefined) continue;
			variant.customInstruction = next.trim() ? next : undefined;
			continue;
		}
		if (action === "suggesterModel") {
			const next = await promptVariantModel(ctx, variant.suggesterModel);
			if (next === undefined) continue;
			variant.suggesterModel = next ?? undefined;
			continue;
		}
		if (action === "suggesterThinking") {
			const next = await promptVariantThinking(ctx, variant.suggesterThinking);
			if (next === undefined) continue;
			variant.suggesterThinking = next ?? undefined;
			continue;
		}
		if (action === "maxSuggestionChars") {
			const next = await promptPositiveIntOrClear(ctx, `Max suggestion chars for ${variantName} (blank = inherit)`, variant.maxSuggestionChars);
			if (next === undefined) continue;
			variant.maxSuggestionChars = next ?? undefined;
		}
	}
}

export async function manageVariantsUi(
	ctx: ExtensionCommandContext,
	composition: AppComposition,
): Promise<void> {
	const store = composition.stores.variantStore;
	while (true) {
		const items = [
			...store.listVariants().map((entry) => ({
				value: `variant:${entry.name}`,
				label: entry.active ? `${entry.name} (active)` : entry.name,
				description: summarizeVariant(entry.variant),
			})),
			{ value: "create", label: "Create variant", description: "Create a named variant from the active variant" },
			{ value: "back", label: "Back", description: "Return to settings" },
		];
		const action = await ctx.ui.select("Manage variants", items.map((item) => item.label));
		if (!action || action === "Back") return;
		if (action === "Create variant") {
			const name = await ctx.ui.editor("New variant name", "");
			if (!name?.trim()) continue;
			await store.createVariant(name.trim());
			ctx.ui.notify(`Created variant '${name.trim()}'.`, "info");
			continue;
		}

		const entry = store.listVariants().find((item) => item.active ? `${item.name} (active)` === action : item.name === action);
		if (!entry) continue;
		const variantAction = await ctx.ui.select(`Variant: ${entry.name}`, ["Activate", "Edit", "Duplicate", "Rename", "Delete", "Back"]);
		if (!variantAction || variantAction === "Back") continue;
		if (variantAction === "Activate") {
			await store.setActiveVariant(entry.name);
			ctx.ui.notify(`Active variant set to '${entry.name}'.`, "info");
			continue;
		}
		if (variantAction === "Edit") {
			await editVariantUi(ctx, composition, entry.name);
			continue;
		}
		if (variantAction === "Duplicate") {
			const name = await ctx.ui.editor(`Duplicate ${entry.name} as`, `${entry.name}-copy`);
			if (!name?.trim()) continue;
			await store.duplicateVariant(entry.name, name.trim());
			ctx.ui.notify(`Duplicated '${entry.name}' to '${name.trim()}'.`, "info");
			continue;
		}
		if (variantAction === "Rename") {
			const name = await ctx.ui.editor(`Rename ${entry.name} to`, entry.name);
			if (!name?.trim() || name.trim() === entry.name) continue;
			await store.renameVariant(entry.name, name.trim());
			ctx.ui.notify(`Renamed variant to '${name.trim()}'.`, "info");
			continue;
		}
		if (variantAction === "Delete") {
			const confirmed = await ctx.ui.select(`Delete ${entry.name}?`, ["cancel", `delete ${entry.name}`]);
			if (confirmed !== `delete ${entry.name}`) continue;
			await store.deleteVariant(entry.name);
			ctx.ui.notify(`Deleted variant '${entry.name}'.`, "info");
		}
	}
}

async function generateSuggestionForVariant(
	ctx: ExtensionCommandContext,
	composition: AppComposition,
	variantName: string,
): Promise<string> {
	const turn = composition.runtimeRef.getLastTurnContext();
	if (!turn) throw new Error("No current suggestion context available yet. Wait for an assistant completion first.");
	const [seed, state] = await Promise.all([
		composition.stores.seedStore.load(),
		composition.stores.stateStore.load(),
	]);
	const effectiveConfig = composition.stores.variantStore.getEffectiveConfig(composition.config, variantName);
	const suggestionEngine = new SuggestionEngine({
		config: effectiveConfig,
		modelClient: new PiModelClient(composition.runtimeRef, undefined, ctx.cwd),
		promptContextBuilder: new PromptContextBuilder(effectiveConfig),
	});
	const steering = {
		recentChanged: state.steeringHistory.filter((event) => event.classification === "changed_course").reverse(),
	};
	const result = await suggestionEngine.suggest(
		turn,
		seed,
		steering,
		{
			modelRef:
				effectiveConfig.inference.suggesterModel === "session-default"
					? undefined
					: effectiveConfig.inference.suggesterModel,
			thinkingLevel: toInvocationThinkingLevel(effectiveConfig.inference.suggesterThinking),
		},
		effectiveConfig,
	);
	return result.text;
}

async function chooseComparisonWinner(
	ctx: ExtensionCommandContext,
	variantA: string,
	variantB: string,
	suggestionA: string,
	suggestionB: string,
): Promise<AbWinner | undefined> {
	const items = [
		{ value: "A", label: `A better (${variantA})` },
		{ value: "B", label: `B better (${variantB})` },
		{ value: "tie", label: "Tie" },
		{ value: "both_bad", label: "Both bad" },
	];
	return await ctx.ui.custom<AbWinner | undefined>((tui, theme, _kb, done) => {
		const selectList = new SelectList(items, items.length + 1, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value as AbWinner);
		selectList.onCancel = () => done(undefined);
		return {
			render(width: number): string[] {
				const lines: string[] = [
					theme.fg("accent", theme.bold(`Compare variants: ${variantA} vs ${variantB}`)),
					theme.fg("dim", "Pick the better suggestion for the current context."),
					"",
					theme.fg("accent", `A — ${variantA}`),
					...wrapTextWithAnsi(suggestionA || "(empty)", Math.max(20, width)),
					"",
					theme.fg("accent", `B — ${variantB}`),
					...wrapTextWithAnsi(suggestionB || "(empty)", Math.max(20, width)),
					"",
					...selectList.render(width),
				];
				return lines;
			},
			invalidate() {
				selectList.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });
}

export async function runVariantComparison(
	ctx: ExtensionCommandContext,
	composition: AppComposition,
	variantA: string,
	variantB: string,
): Promise<void> {
	if (variantA === variantB) throw new Error("Pick two different variants to compare.");
	if (!composition.stores.variantStore.getVariant(variantA)) throw new Error(`Unknown variant: ${variantA}`);
	if (!composition.stores.variantStore.getVariant(variantB)) throw new Error(`Unknown variant: ${variantB}`);
	const [suggestionA, suggestionB] = await Promise.all([
		generateSuggestionForVariant(ctx, composition, variantA),
		generateSuggestionForVariant(ctx, composition, variantB),
	]);
	const winner = await chooseComparisonWinner(ctx, variantA, variantB, suggestionA, suggestionB);
	if (!winner) return;
	const turnId = composition.runtimeRef.getLastTurnContext()?.turnId ?? `ab-${Date.now()}`;
	await composition.stores.variantStore.recordResult({
		at: new Date().toISOString(),
		turnId,
		variantA,
		variantB,
		suggestionA,
		suggestionB,
		winner,
	});
	ctx.ui.notify(`Saved comparison result: ${winner}.`, "info");
}

export async function showAbStats(ctx: ExtensionCommandContext, composition: AppComposition): Promise<void> {
	const stats = await composition.stores.variantStore.getStats();
	const names = Object.keys(stats).sort((a, b) => a.localeCompare(b));
	if (names.length === 0) {
		ctx.ui.notify("No A/B results yet.", "info");
		return;
	}
	ctx.ui.notify(
		[
			"suggester A/B stats",
			...names.map((name) => {
				const entry = stats[name];
				return `- ${name}: ${entry.wins}W ${entry.losses}L ${entry.ties}T ${entry.bothBad} bad (${entry.compared} compared)`;
			}),
		].join("\n"),
		"info",
	);
}

export async function handleVariantCommand(
	args: string,
	ctx: ExtensionCommandContext,
	composition: AppComposition,
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const store = composition.stores.variantStore;
	if (tokens.length === 0 || tokens[0] === "list" || tokens[0] === "show") {
		ctx.ui.notify(
			[
				`suggester variants (active: ${store.getActiveVariantName()})`,
				...store.listVariants().map((entry) => `- ${entry.active ? "* " : ""}${entry.name}: ${summarizeVariant(entry.variant)}`),
			].join("\n"),
			"info",
		);
		return;
	}
	if (tokens[0] === "use") {
		const name = tokens.slice(1).join(" ").trim();
		if (!name) {
			ctx.ui.notify("Usage: /suggester variant use <name>", "error");
			return;
		}
		await store.setActiveVariant(name);
		ctx.ui.notify(`Active variant set to '${name}'.`, "info");
		return;
	}
	if (tokens[0] === "create") {
		const name = tokens[1]?.trim();
		if (!name) {
			ctx.ui.notify("Usage: /suggester variant create <name>", "error");
			return;
		}
		await store.createVariant(name);
		ctx.ui.notify(`Created variant '${name}'.`, "info");
		return;
	}
	if (tokens[0] === "duplicate") {
		const source = tokens[1]?.trim();
		const target = tokens[2]?.trim();
		if (!source || !target) {
			ctx.ui.notify("Usage: /suggester variant duplicate <source> <target>", "error");
			return;
		}
		await store.duplicateVariant(source, target);
		ctx.ui.notify(`Duplicated '${source}' to '${target}'.`, "info");
		return;
	}
	if (tokens[0] === "rename") {
		const source = tokens[1]?.trim();
		const target = tokens[2]?.trim();
		if (!source || !target) {
			ctx.ui.notify("Usage: /suggester variant rename <old> <new>", "error");
			return;
		}
		await store.renameVariant(source, target);
		ctx.ui.notify(`Renamed '${source}' to '${target}'.`, "info");
		return;
	}
	if (tokens[0] === "delete") {
		const name = tokens[1]?.trim();
		if (!name) {
			ctx.ui.notify("Usage: /suggester variant delete <name>", "error");
			return;
		}
		await store.deleteVariant(name);
		ctx.ui.notify(`Deleted variant '${name}'.`, "info");
		return;
	}
	ctx.ui.notify("Usage: /suggester variant [list|use|create|duplicate|rename|delete] ...", "error");
}

export async function handleAbCommand(
	args: string,
	ctx: ExtensionCommandContext,
	composition: AppComposition,
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens[0] === "stats") {
		await showAbStats(ctx, composition);
		return;
	}
	if (tokens[0] !== "test") {
		ctx.ui.notify("Usage: /suggester ab test <variantA> <variantB> | stats", "error");
		return;
	}
	const variantA = tokens[1]?.trim();
	const variantB = tokens[2]?.trim();
	if (!variantA || !variantB) {
		ctx.ui.notify("Usage: /suggester ab test <variantA> <variantB>", "error");
		return;
	}
	await runVariantComparison(ctx, composition, variantA, variantB);
}

export async function runAbTestingUi(ctx: ExtensionCommandContext, composition: AppComposition): Promise<void> {
	const variants = composition.stores.variantStore.listVariants().map((entry) => entry.name);
	if (variants.length < 2) {
		ctx.ui.notify("Create at least two variants first.", "info");
		return;
	}
	const variantA = await ctx.ui.select("Variant A", variants);
		if (!variantA) return;
	const variantB = await ctx.ui.select("Variant B", variants.filter((name) => name !== variantA));
	if (!variantB) return;
	await runVariantComparison(ctx, composition, variantA, variantB);
}
