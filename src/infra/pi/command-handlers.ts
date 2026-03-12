import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text } from "@mariozechner/pi-tui";
import type { LoggedEvent } from "../../app/ports/event-log.js";
import type { AppComposition } from "../../composition/root.js";
import { FileConfigLoader } from "../../config/loader.js";
import type { PromptSuggesterConfig, ThinkingLevel } from "../../config/types.js";

type ModelRole = "seeder" | "suggester";
type ConfigScope = "project" | "user";

const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
const MODEL_ROLES: ModelRole[] = ["seeder", "suggester"];
const SESSION_DEFAULT = "session-default";

function modelToRef(model: Model<any> | undefined): string {
	if (!model) return "(none)";
	return `${model.provider}/${model.id}`;
}

function parseRole(token: string | undefined): ModelRole | undefined {
	if (!token) return undefined;
	return MODEL_ROLES.find((role) => role === (token.trim().toLowerCase() as ModelRole));
}

function resolveModelRef(models: Model<any>[], raw: string): { ok: true; canonicalRef: string } | { ok: false; reason: string } {
	const value = raw.trim();
	if (!value) return { ok: false, reason: "Model reference is empty" };
	if (value === SESSION_DEFAULT) return { ok: true, canonicalRef: SESSION_DEFAULT };
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

async function getModelSelectionOptions(ctx: ExtensionContext | ExtensionCommandContext): Promise<string[]> {
	const refs = new Set<string>();
	for (const model of await ctx.modelRegistry.getAvailable()) {
		refs.add(`${model.provider}/${model.id}`);
	}
	return [SESSION_DEFAULT, ...Array.from(refs).sort((a, b) => a.localeCompare(b))];
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

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function summarizeInstruction(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "(none)";
	return trimmed.replace(/\s+/g, " ").slice(0, 80);
}

function parseConfigScope(token: string | undefined): ConfigScope | undefined {
	if (!token) return undefined;
	if (token === "project" || token === "user") return token;
	return undefined;
}

function parseConfigValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error("Missing config value.");
	}

	try {
		return JSON.parse(trimmed);
	} catch {
		if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
			return trimmed.slice(1, -1);
		}
		return trimmed;
	}
}

function setPathValue(target: Record<string, unknown>, pathSegments: string[], value: unknown): void {
	let cursor: Record<string, unknown> = target;
	for (let index = 0; index < pathSegments.length - 1; index += 1) {
		const segment = pathSegments[index];
		const existing = cursor[segment];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
			cursor[segment] = {};
		}
		cursor = cursor[segment] as Record<string, unknown>;
	}
	cursor[pathSegments[pathSegments.length - 1]] = value;
}

export function renderSeedTrace(events: LoggedEvent[]): string {
	if (events.length === 0) {
		return "Suggester seed trace\n- no seeder events found in persistent logs.";
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
		const detailBits = [
			run ? `run=${run}` : undefined,
			step !== undefined ? `step=${step}` : undefined,
			tool ? `tool=${tool}` : undefined,
			reason ? `reason=${reason}` : undefined,
		].filter(Boolean);
		const detail = detailBits.length > 0 ? ` (${detailBits.join(", ")})` : "";
		const previewSuffix = preview ? ` | ${preview.slice(0, 180)}` : "";
		return `- ${time} ${event.message}${detail}${previewSuffix}`;
	});

	return [
		"Suggester seed trace",
		`- events shown: ${lines.length}`,
		latestRunId ? `- latest run: ${latestRunId}` : "- latest run: (unknown)",
		"- log file: .pi/suggester/logs/events.ndjson",
		...lines,
	].join("\n");
}

export function renderStatus(
	seed: Awaited<ReturnType<AppComposition["stores"]["seedStore"]["load"]>>,
	state: Awaited<ReturnType<AppComposition["stores"]["stateStore"]["load"]>>,
	config: PromptSuggesterConfig,
	ctx?: ExtensionContext,
): string {
	const steeringSummary = {
		exact: state.steeringHistory.filter((event) => event.classification === "accepted_exact").length,
		edited: state.steeringHistory.filter((event) => event.classification === "accepted_edited").length,
		changed: state.steeringHistory.filter((event) => event.classification === "changed_course").length,
	};
	const activeModel = modelToRef(ctx?.model);
	const combinedInput = state.suggestionUsage.inputTokens + state.seederUsage.inputTokens;
	const combinedOutput = state.suggestionUsage.outputTokens + state.seederUsage.outputTokens;
	const combinedCacheRead = state.suggestionUsage.cacheReadTokens + state.seederUsage.cacheReadTokens;
	const combinedCost = state.suggestionUsage.costTotal + state.seederUsage.costTotal;
	const suggesterPromptTokens = state.suggestionUsage.last?.inputTokens ?? 0;
	const compactUsageLine = `suggester usage: ↑${formatTokens(combinedInput)} ↓${formatTokens(combinedOutput)} R${formatTokens(combinedCacheRead)} $${combinedCost.toFixed(3)} (${state.suggestionUsage.calls} sugg, ${state.seederUsage.calls} seed), last suggester prompt: ${formatTokens(suggesterPromptTokens)} tok`;

	return [
		"Suggester status",
		`- seed: ${seed ? `present (${seed.generatedAt})` : "missing"}`,
		`- key files: ${seed?.keyFiles.map((file) => `${file.path} [${file.category}]`).join(", ") || "(none)"}`,
		`- last reseed reason: ${seed?.lastReseedReason ?? "(none)"}`,
		`- implementation status: ${seed?.implementationStatusSummary?.slice(0, 140) ?? "(none)"}`,
		`- active session model: ${activeModel}`,
		`- config schemaVersion: ${config.schemaVersion}`,
		`- custom instruction: ${summarizeInstruction(config.suggestion.customInstruction)}`,
		`- models (config): seeder=${config.inference.seederModel}, suggester=${config.inference.suggesterModel}`,
		`- thinking (config): seeder=${config.inference.seederThinking}, suggester=${config.inference.suggesterThinking}`,
		`- ${compactUsageLine}`,
		`- logs: .pi/suggester/logs/events.ndjson (use /suggester seed-trace)`,
		`- last suggestion: ${state.lastSuggestion?.text ?? "(none)"}`,
		`- steering history: exact=${steeringSummary.exact}, edited=${steeringSummary.edited}, changed=${steeringSummary.changed}`,
	].join("\n");
}

function projectOverridePath(cwd: string): string {
	return path.join(cwd, ".pi", "suggester", "config.json");
}

function userOverridePath(homeDir: string = os.homedir()): string {
	return path.join(homeDir, ".pi", "suggester", "config.json");
}

function overridePathForScope(cwd: string, scope: ConfigScope): string {
	return scope === "user" ? userOverridePath() : projectOverridePath(cwd);
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown>> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

async function writeJson(filePath: string, value: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readOverrideCustomInstruction(cwd: string, scope: ConfigScope): Promise<string> {
	const raw = await readJsonIfExists(overridePathForScope(cwd, scope));
	const suggestion = raw.suggestion;
	if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return "";
	return typeof (suggestion as { customInstruction?: unknown }).customInstruction === "string"
		? String((suggestion as { customInstruction?: unknown }).customInstruction)
		: "";
}

async function writeOverrideValue(
	ctx: ExtensionCommandContext,
	composition: AppComposition,
	scope: ConfigScope,
	configPath: string,
	value: unknown,
): Promise<void> {
	const filePath = overridePathForScope(ctx.cwd, scope);
	let previousRaw: string | undefined;
	try {
		previousRaw = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Failed to read config override ${filePath}: ${(error as Error).message}`);
		}
	}

	let current: Record<string, unknown> = {};
	if (previousRaw !== undefined) {
		try {
			const parsed = JSON.parse(previousRaw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				current = parsed as Record<string, unknown>;
			} else {
				throw new Error(`Override config ${filePath} must be a JSON object.`);
			}
		} catch (error) {
			throw new Error(`Failed to parse config override ${filePath}: ${(error as Error).message}`);
		}
	}

	const next: Record<string, unknown> = JSON.parse(JSON.stringify(current));
	setPathValue(
		next,
		configPath
			.split(".")
			.map((segment) => segment.trim())
			.filter(Boolean),
		value,
	);

	try {
		await writeJson(filePath, next);
		await refreshCompositionConfig(ctx, composition);
	} catch (error) {
		try {
			if (previousRaw === undefined) {
				await fs.rm(filePath, { force: true });
			} else {
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs.writeFile(filePath, previousRaw, "utf8");
			}
		} catch {
			// Best-effort rollback only.
		}
		throw new Error(`Failed to apply config change: ${(error as Error).message}`);
	}
}

async function refreshCompositionConfig(ctx: ExtensionCommandContext, composition: AppComposition): Promise<void> {
	const next = await new FileConfigLoader(ctx.cwd).load();
	Object.assign(composition.config, next);
}

async function applyConfigChange(
	ctx: ExtensionCommandContext,
	composition: AppComposition,
	key: keyof PromptSuggesterConfig["inference"],
	value: string,
): Promise<void> {
	await writeOverrideValue(ctx, composition, "project", `inference.${key}`, value);
	ctx.ui.notify(`suggester config updated: inference.${key}=${value}`, "info");
}

export async function handleModelCommand(
	args: string,
	ctx: ExtensionCommandContext,
	composition: AppComposition,
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || tokens[0] === "show") {
		ctx.ui.notify(
			`suggester models (config): seeder=${composition.config.inference.seederModel}, suggester=${composition.config.inference.suggesterModel}`,
			"info",
		);
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
			"Usage: /suggester model [show] | [set] <seeder|suggester> <provider/model|model-id|session-default> | clear <seeder|suggester>",
			"error",
		);
		return;
	}

	const key = role === "seeder" ? "seederModel" : "suggesterModel";
	if (action === "clear" || (tokens[1] ?? "").toLowerCase() === "clear") {
		await applyConfigChange(ctx, composition, key, SESSION_DEFAULT);
		return;
	}

	let rawModelRef = tokens.slice(1).join(" ").trim();
	if (!rawModelRef) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Missing model reference.", "error");
			return;
		}
		const selected = await ctx.ui.select(
			`Select ${role} model`,
			await getModelSelectionOptions(ctx),
		);
		if (!selected) return;
		rawModelRef = selected;
	}
	const resolved = resolveModelRef(ctx.modelRegistry.getAll(), rawModelRef);
	if (!resolved.ok) {
		ctx.ui.notify(resolved.reason, "error");
		return;
	}

	await applyConfigChange(ctx, composition, key, resolved.canonicalRef);
}

export async function handleThinkingCommand(
	args: string,
	ctx: ExtensionCommandContext,
	composition: AppComposition,
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || tokens[0] === "show") {
		ctx.ui.notify(
			`suggester thinking (config): seeder=${composition.config.inference.seederThinking}, suggester=${composition.config.inference.suggesterThinking}`,
			"info",
		);
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
			"Usage: /suggester thinking [show] | [set] <seeder|suggester> <minimal|low|medium|high|xhigh|session-default> | clear <seeder|suggester>",
			"error",
		);
		return;
	}

	const key = role === "seeder" ? "seederThinking" : "suggesterThinking";
	if (action === "clear" || (tokens[1] ?? "").toLowerCase() === "clear") {
		await applyConfigChange(ctx, composition, key, SESSION_DEFAULT);
		return;
	}

	const rawLevel = tokens[1]?.trim().toLowerCase();
	if (!rawLevel || ![...THINKING_LEVELS, SESSION_DEFAULT].includes(rawLevel as ThinkingLevel | typeof SESSION_DEFAULT)) {
		ctx.ui.notify("Thinking level must be one of: minimal, low, medium, high, xhigh, session-default", "error");
		return;
	}

	await applyConfigChange(ctx, composition, key, rawLevel);
}

export async function handleInstructionCommand(
	args: string,
	ctx: ExtensionCommandContext,
	composition: AppComposition,
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || tokens[0] === "show") {
		ctx.ui.notify(
			[
				"suggester custom instruction",
				`- effective value: ${summarizeInstruction(composition.config.suggestion.customInstruction)}`,
				`- project override: ${projectOverridePath(ctx.cwd)}`,
				`- user override: ${userOverridePath()}`,
				"- edit in TUI: /suggesterSettings → Custom instruction",
				"- edit by command: /suggester instruction set [project|user]",
				"- clear: /suggester instruction clear [project|user]",
			].join("\n"),
			"info",
		);
		return;
	}

	const action = tokens[0]?.toLowerCase();
	const scope = parseConfigScope(tokens[1]?.toLowerCase()) ?? "project";
	if (action !== "set" && action !== "clear") {
		ctx.ui.notify("Usage: /suggester instruction [show|set [project|user]|clear [project|user]]", "error");
		return;
	}

	if (action === "clear") {
		await writeOverrideValue(ctx, composition, scope, "suggestion.customInstruction", "");
		ctx.ui.notify(`Cleared custom instruction in ${scope} override.`, "info");
		return;
	}

	const initialValue = scope === "project"
		? composition.config.suggestion.customInstruction
		: await readOverrideCustomInstruction(ctx.cwd, scope);
	const next = await ctx.ui.editor(
		`Custom suggester instruction (${scope} override)`,
		initialValue,
	);
	if (next === undefined) {
		ctx.ui.notify("Custom instruction edit canceled.", "info");
		return;
	}

	await writeOverrideValue(ctx, composition, scope, "suggestion.customInstruction", next);
	ctx.ui.notify(
		next.trim()
			? `Updated custom instruction in ${scope} override.`
			: `Cleared custom instruction in ${scope} override.`,
		"info",
	);
}

export async function handleConfigCommand(
	args: string,
	ctx: ExtensionCommandContext,
	composition: AppComposition,
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || tokens[0] === "show") {
		ctx.ui.notify(
			[
				"suggester config",
				`- effective schemaVersion=${composition.config.schemaVersion}`,
				`- project override: ${projectOverridePath(ctx.cwd)}`,
				`- user override: ${userOverridePath()}`,
				"- set value: /suggester config set [project|user] <path> <json-or-string>",
				"- reset to defaults: /suggester config reset [project|user|all]",
			].join("\n"),
			"info",
		);
		return;
	}

	if (tokens[0] === "set") {
		let index = 1;
		const parsedScope = parseConfigScope(tokens[index]?.toLowerCase());
		const scope: ConfigScope = parsedScope ?? "project";
		if (parsedScope) index += 1;

		const configPath = tokens[index]?.trim();
		if (!configPath) {
			ctx.ui.notify(
				"Usage: /suggester config set [project|user] <path> <json-or-string>",
				"error",
			);
			return;
		}
		if (configPath === "schemaVersion" || configPath.startsWith("schemaVersion.")) {
			ctx.ui.notify("schemaVersion is managed automatically and cannot be set manually.", "error");
			return;
		}

		const pathSegments = configPath
			.split(".")
			.map((segment) => segment.trim())
			.filter(Boolean);
		if (pathSegments.length === 0) {
			ctx.ui.notify("Config path is invalid.", "error");
			return;
		}

		const rawValue = tokens.slice(index + 1).join(" ");
		let parsedValue: unknown;
		try {
			parsedValue = parseConfigValue(rawValue);
		} catch (error) {
			ctx.ui.notify((error as Error).message, "error");
			return;
		}

		const filePath = overridePathForScope(ctx.cwd, scope);
		let previousRaw: string | undefined;
		try {
			previousRaw = await fs.readFile(filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				ctx.ui.notify(`Failed to read config override ${filePath}: ${(error as Error).message}`, "error");
				return;
			}
		}

		let current: Record<string, unknown> = {};
		if (previousRaw !== undefined) {
			try {
				const parsed = JSON.parse(previousRaw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					current = parsed as Record<string, unknown>;
				} else {
					ctx.ui.notify(`Override config ${filePath} must be a JSON object.`, "error");
					return;
				}
			} catch (error) {
				ctx.ui.notify(`Failed to parse config override ${filePath}: ${(error as Error).message}`, "error");
				return;
			}
		}

		const next: Record<string, unknown> = JSON.parse(JSON.stringify(current));
		setPathValue(next, pathSegments, parsedValue);

		try {
			await writeJson(filePath, next);
			await refreshCompositionConfig(ctx, composition);
		} catch (error) {
			try {
				if (previousRaw === undefined) {
					await fs.rm(filePath, { force: true });
				} else {
					await fs.mkdir(path.dirname(filePath), { recursive: true });
					await fs.writeFile(filePath, previousRaw, "utf8");
				}
			} catch {
				// Best-effort rollback only.
			}
			ctx.ui.notify(`Failed to apply config change: ${(error as Error).message}`, "error");
			return;
		}

		ctx.ui.notify(
			`suggester config updated (${scope}): ${configPath}=${JSON.stringify(parsedValue)}`,
			"info",
		);
		return;
	}

	if (tokens[0] !== "reset") {
		ctx.ui.notify(
			"Usage: /suggester config [show|set [project|user] <path> <json-or-string>|reset [project|user|all]]",
			"error",
		);
		return;
	}

	const scopeToken = tokens[1]?.toLowerCase();
	const singleScope = parseConfigScope(scopeToken);
	const targets =
		scopeToken === "all"
			? [projectOverridePath(ctx.cwd), userOverridePath()]
			: singleScope
				? [overridePathForScope(ctx.cwd, singleScope)]
				: scopeToken
					? undefined
					: [projectOverridePath(ctx.cwd)];
	if (!targets) {
		ctx.ui.notify("Usage: /suggester config reset [project|user|all]", "error");
		return;
	}

	const removed: string[] = [];
	for (const target of targets) {
		try {
			await fs.rm(target, { force: true });
			removed.push(target);
		} catch (error) {
			ctx.ui.notify(`Failed to reset config at ${target}: ${(error as Error).message}`, "error");
			return;
		}
	}

	await refreshCompositionConfig(ctx, composition);
	ctx.ui.notify(
		[
			"suggester config reset to defaults",
			`- removed overrides: ${removed.join(", ")}`,
			`- effective schemaVersion=${composition.config.schemaVersion}`,
		].join("\n"),
		"info",
	);
}

export async function handleSettingsUiCommand(
	ctx: ExtensionCommandContext,
	composition: AppComposition,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Interactive suggester settings require the TUI.", "error");
		return;
	}

	let activeScope: ConfigScope = "project";
	const thinkingOptions = [...THINKING_LEVELS, SESSION_DEFAULT];

	const pickMenuAction = async (): Promise<string | null> => {
		const items = [
			{
				value: "scope",
				label: "Write scope",
				description: `${activeScope} → ${overridePathForScope(ctx.cwd, activeScope)}`,
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
				await fs.rm(overridePathForScope(ctx.cwd, activeScope), { force: true });
				await refreshCompositionConfig(ctx, composition);
				ctx.ui.notify(`Reset ${activeScope} suggester override.`, "info");
				continue;
			}

			if (action === "suggestion.customInstruction") {
				const currentValue = activeScope === "project"
					? composition.config.suggestion.customInstruction
					: await readOverrideCustomInstruction(ctx.cwd, activeScope);
				const next = await ctx.ui.editor(`Custom suggester instruction (${activeScope} override)`, currentValue);
				if (next === undefined) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, next);
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
				await writeOverrideValue(ctx, composition, activeScope, action, selected === "true");
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "suggestion.fastPathContinueOnError") {
				const selected = await ctx.ui.select("Fast-path continue on error?", ["true", "false"]);
				if (!selected) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, selected === "true");
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "reseed.enabled" || action === "reseed.checkOnSessionStart" || action === "reseed.checkAfterEveryTurn") {
				const selected = await ctx.ui.select(`${action}?`, ["true", "false"]);
				if (!selected) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, selected === "true");
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "reseed.turnCheckInterval") {
				const next = await promptNonNegativeInt("Turn staleness check interval (0 disables turn checks)", composition.config.reseed.turnCheckInterval);
				if (next === undefined) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "suggestion.maxSuggestionChars") {
				const next = await promptPositiveInt("Max suggestion chars", composition.config.suggestion.maxSuggestionChars);
				if (next === undefined) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "suggestion.maxRecentUserPrompts") {
				const next = await promptPositiveInt("Recent user prompts", composition.config.suggestion.maxRecentUserPrompts);
				if (next === undefined) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "suggestion.maxRecentUserPromptChars") {
				const next = await promptPositiveInt("Recent user prompt chars", composition.config.suggestion.maxRecentUserPromptChars);
				if (next === undefined) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "steering.maxChangedExamples") {
				const next = await promptPositiveInt("Changed examples in prompt", composition.config.steering.maxChangedExamples);
				if (next === undefined) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "inference.seederModel") {
				const next = await promptModel("Seeder model (provider/model or session-default)", composition.config.inference.seederModel);
				if (next === undefined) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "inference.suggesterModel") {
				const next = await promptModel("Suggester model (provider/model or session-default)", composition.config.inference.suggesterModel);
				if (next === undefined) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, next);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}

			if (action === "inference.seederThinking" || action === "inference.suggesterThinking") {
				const current = action === "inference.seederThinking"
					? composition.config.inference.seederThinking
					: composition.config.inference.suggesterThinking;
				const selected = await ctx.ui.select(`${action} (current: ${current})`, thinkingOptions);
				if (!selected) continue;
				await writeOverrideValue(ctx, composition, activeScope, action, selected);
				ctx.ui.notify(`Updated ${action} in ${activeScope} override.`, "info");
				continue;
			}
		} catch (error) {
			ctx.ui.notify((error as Error).message, "error");
		}
	}
}

export async function handleSeedTraceCommand(
	args: string,
	pi: ExtensionAPI,
	composition: AppComposition,
): Promise<void> {
	const limit = parsePositiveInt(args.trim() || undefined, 240);
	const events = await composition.eventLog.readRecent(limit, { messagePrefix: "seeder." });
	pi.sendMessage(
		{
			customType: "prompt-suggester-seed-trace",
			content: renderSeedTrace(events),
			display: true,
		},
		{ triggerTurn: false },
	);
}
