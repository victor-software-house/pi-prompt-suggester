import { Container, SelectList, Text } from "@mariozechner/pi-tui";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AppComposition } from "../../../composition/root.js";
import { SuggesterConfigPersistence } from "./config-persistence.js";
import { getModelSelectionOptions, resolveModelRef, SESSION_DEFAULT, THINKING_LEVELS, type ConfigScope, summarizeInstruction } from "./shared.js";
import { manageVariantsUi, runAbTestingUi, showAbStats } from "./ab-testing.js";

export async function handleSettingsUiCommand(
	ctx: ExtensionCommandContext,
	composition: AppComposition,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Interactive suggester settings require the TUI.", "error");
		return;
	}

	const persistence = new SuggesterConfigPersistence(ctx, composition);
	let activeScope: ConfigScope = "project";
	const thinkingOptions = [...THINKING_LEVELS, SESSION_DEFAULT];

	const pickMenuAction = async (): Promise<string | null> => {
		const items = [
			{
				value: "ab.activeVariant",
				label: "Active variant",
				description: composition.stores.variantStore.getActiveVariantName(),
			},
			{
				value: "ab.manageVariants",
				label: "Manage variants",
				description: `${composition.stores.variantStore.listVariants().length} variants`,
			},
			{
				value: "ab.compareVariants",
				label: "Compare variants",
				description: "Generate two suggestions and pick the better one",
			},
			{
				value: "ab.stats",
				label: "A/B stats",
				description: "Wins, losses, ties, both-bad",
			},
			{
				value: "scope",
				label: "Write scope",
				description: `${activeScope} → ${persistence.overridePathForScope(activeScope)}`,
			},
			{
				value: "suggestion.customInstruction",
				label: "Custom instruction",
				description: summarizeInstruction(composition.config.suggestion.customInstruction),
			},
			{
				value: "suggestion.maxSuggestionChars",
				label: "Max suggestion chars",
				description: String(composition.config.suggestion.maxSuggestionChars),
			},
			{
				value: "suggestion.maxRecentUserPrompts",
				label: "Recent user prompts",
				description: String(composition.config.suggestion.maxRecentUserPrompts),
			},
			{
				value: "suggestion.maxRecentUserPromptChars",
				label: "Recent user prompt chars",
				description: String(composition.config.suggestion.maxRecentUserPromptChars),
			},
			{
				value: "steering.maxChangedExamples",
				label: "Changed examples in prompt",
				description: String(composition.config.steering.maxChangedExamples),
			},
			{
				value: "suggestion.prefillOnlyWhenEditorEmpty",
				label: "Ghost only on empty editor",
				description: composition.config.suggestion.prefillOnlyWhenEditorEmpty ? "on" : "off",
			},
			{
				value: "suggestion.fastPathContinueOnError",
				label: "Fast-path continue on error",
				description: composition.config.suggestion.fastPathContinueOnError ? "on" : "off",
			},
			{
				value: "reseed.enabled",
				label: "Automatic reseeding enabled",
				description: composition.config.reseed.enabled ? "on" : "off",
			},
			{
				value: "reseed.checkOnSessionStart",
				label: "Check staleness on session start",
				description: composition.config.reseed.checkOnSessionStart ? "on" : "off",
			},
			{
				value: "reseed.checkAfterEveryTurn",
				label: "Check staleness after every turn",
				description: composition.config.reseed.checkAfterEveryTurn ? "on" : "off",
			},
			{
				value: "reseed.turnCheckInterval",
				label: "Turn staleness check interval",
				description: String(composition.config.reseed.turnCheckInterval),
			},
			{
				value: "inference.seederModel",
				label: "Seeder model",
				description: composition.config.inference.seederModel,
			},
			{
				value: "inference.suggesterModel",
				label: "Suggester model",
				description: composition.config.inference.suggesterModel,
			},
			{
				value: "inference.seederThinking",
				label: "Seeder thinking",
				description: composition.config.inference.seederThinking,
			},
			{
				value: "inference.suggesterThinking",
				label: "Suggester thinking",
				description: composition.config.inference.suggesterThinking,
			},
			{
				value: "reset",
				label: `Reset ${activeScope} override`,
				description: "Delete override file for current scope",
			},
			{
				value: "close",
				label: "Close",
				description: "Exit suggester settings",
			},
		];

		return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Suggester Settings")), 1, 0));
			container.addChild(new Text(theme.fg("dim", `Editing ${activeScope} override • Enter select • Esc close`), 1, 0));
			const selectList = new SelectList(items, Math.min(items.length + 1, 16), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(String(item.value));
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });
	};

	const promptPositiveInt = async (label: string, currentValue: number): Promise<number | undefined> => {
		const raw = await ctx.ui.editor(label, String(currentValue));
		if (raw === undefined) return undefined;
		const parsed = Number.parseInt(raw.trim(), 10);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			ctx.ui.notify("Value must be a positive integer.", "error");
			return undefined;
		}
		return parsed;
	};

	const promptNonNegativeInt = async (label: string, currentValue: number): Promise<number | undefined> => {
		const raw = await ctx.ui.editor(label, String(currentValue));
		if (raw === undefined) return undefined;
		const parsed = Number.parseInt(raw.trim(), 10);
		if (!Number.isInteger(parsed) || parsed < 0) {
			ctx.ui.notify("Value must be a non-negative integer.", "error");
			return undefined;
		}
		return parsed;
	};

	const promptModel = async (label: string, currentValue: string): Promise<string | undefined> => {
		const options = await getModelSelectionOptions(ctx);
		const selected = await ctx.ui.select(`${label} (current: ${currentValue})`, options);
		if (!selected) return undefined;
		const resolved = resolveModelRef(ctx.modelRegistry.getAll(), selected);
		if (!resolved.ok) {
			ctx.ui.notify(resolved.reason, "error");
			return undefined;
		}
		return resolved.canonicalRef;
	};

	while (true) {
		const action = await pickMenuAction();
		if (!action || action === "close") return;

		try {
			if (action === "ab.activeVariant") {
				const selected = await ctx.ui.select(
					"Active variant",
					composition.stores.variantStore.listVariants().map((entry) => entry.name),
				);
				if (!selected) continue;
				await composition.stores.variantStore.setActiveVariant(selected);
				ctx.ui.notify(`Active variant set to '${selected}'.`, "info");
				continue;
			}

			if (action === "ab.manageVariants") {
				await manageVariantsUi(ctx, composition);
				continue;
			}

			if (action === "ab.compareVariants") {
				await runAbTestingUi(ctx, composition);
				continue;
			}

			if (action === "ab.stats") {
				await showAbStats(ctx, composition);
				continue;
			}

			if (action === "scope") {
				const selected = await ctx.ui.select("Write overrides to which scope?", ["project", "user"]);
				if (selected === "project" || selected === "user") activeScope = selected;
				continue;
			}

			if (action === "reset") {
				const confirmed = await ctx.ui.select(
					`Reset ${activeScope} override?`,
					["cancel", `reset ${activeScope}`],
				);
				if (confirmed !== `reset ${activeScope}`) continue;
				await persistence.resetScopes([activeScope]);
				ctx.ui.notify(`Reset ${activeScope} suggester override.`, "info");
				continue;
			}

			if (action === "suggestion.customInstruction") {
				const currentValue = activeScope === "project"
					? composition.config.suggestion.customInstruction
					: await persistence.readOverrideCustomInstruction(activeScope);
				const next = await ctx.ui.editor(`Custom suggester instruction (${activeScope} override)`, currentValue);
				if (next === undefined) continue;
				await persistence.writeValue(activeScope, action, next);
				ctx.ui.notify(
					next.trim()
						? `Updated ${action} in ${activeScope} override.`
						: `Cleared ${action} in ${activeScope} override.`,
					"info",
				);
				continue;
			}

			if (action === "suggestion.prefillOnlyWhenEditorEmpty") {
				const selected = await ctx.ui.select("Ghost only on empty editor?", ["true", "false"]);
				if (!selected) continue;
				await persistence.writeValue(activeScope, action, selected === "true");
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "suggestion.fastPathContinueOnError") {
				const selected = await ctx.ui.select("Fast-path continue on error?", ["true", "false"]);
				if (!selected) continue;
				await persistence.writeValue(activeScope, action, selected === "true");
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "reseed.enabled" || action === "reseed.checkOnSessionStart" || action === "reseed.checkAfterEveryTurn") {
				const selected = await ctx.ui.select(`${action}?`, ["true", "false"]);
				if (!selected) continue;
				await persistence.writeValue(activeScope, action, selected === "true");
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "reseed.turnCheckInterval") {
				const next = await promptNonNegativeInt(
					"Turn staleness check interval (0 disables turn checks)",
					composition.config.reseed.turnCheckInterval,
				);
				if (next === undefined) continue;
				await persistence.writeValue(activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "suggestion.maxSuggestionChars") {
				const next = await promptPositiveInt("Max suggestion chars", composition.config.suggestion.maxSuggestionChars);
				if (next === undefined) continue;
				await persistence.writeValue(activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "suggestion.maxRecentUserPrompts") {
				const next = await promptPositiveInt("Recent user prompts", composition.config.suggestion.maxRecentUserPrompts);
				if (next === undefined) continue;
				await persistence.writeValue(activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "suggestion.maxRecentUserPromptChars") {
				const next = await promptPositiveInt(
					"Recent user prompt chars",
					composition.config.suggestion.maxRecentUserPromptChars,
				);
				if (next === undefined) continue;
				await persistence.writeValue(activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "steering.maxChangedExamples") {
				const next = await promptPositiveInt("Changed examples in prompt", composition.config.steering.maxChangedExamples);
				if (next === undefined) continue;
				await persistence.writeValue(activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "inference.seederModel") {
				const next = await promptModel("Seeder model (provider/model or session-default)", composition.config.inference.seederModel);
				if (next === undefined) continue;
				await persistence.writeValue(activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "inference.suggesterModel") {
				const next = await promptModel(
					"Suggester model (provider/model or session-default)",
					composition.config.inference.suggesterModel,
				);
				if (next === undefined) continue;
				await persistence.writeValue(activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "inference.seederThinking" || action === "inference.suggesterThinking") {
				const current = action === "inference.seederThinking"
					? composition.config.inference.seederThinking
					: composition.config.inference.suggesterThinking;
				const selected = await ctx.ui.select(`${action} (current: ${current})`, thinkingOptions);
				if (!selected) continue;
				await persistence.writeValue(activeScope, action, selected);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}
		} catch (error) {
			ctx.ui.notify((error as Error).message, "error");
		}
	}
}
