import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
	const seededPromptTokens = state.seederUsage.last?.inputTokens ?? 0;
	const compactUsageLine = `suggester usage: ↑${formatTokens(combinedInput)} ↓${formatTokens(combinedOutput)} R${formatTokens(combinedCacheRead)} $${combinedCost.toFixed(3)} (${state.suggestionUsage.calls} sugg, ${state.seederUsage.calls} seed), seeded prompt: ${seededPromptTokens} tok`;

	return [
		"Suggester status",
		`- seed: ${seed ? `present (${seed.generatedAt})` : "missing"}`,
		`- key files: ${seed?.keyFiles.map((file) => `${file.path} [${file.category}]`).join(", ") || "(none)"}`,
		`- last reseed reason: ${seed?.lastReseedReason ?? "(none)"}`,
		`- implementation status: ${seed?.implementationStatusSummary?.slice(0, 140) ?? "(none)"}`,
		`- active session model: ${activeModel}`,
		`- config schemaVersion: ${config.schemaVersion}`,
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

async function setProjectInferenceValue(
	cwd: string,
	key: keyof PromptSuggesterConfig["inference"],
	value: string,
): Promise<void> {
	const filePath = projectOverridePath(cwd);
	const current = await readJsonIfExists(filePath);
	const inference =
		current.inference && typeof current.inference === "object" && !Array.isArray(current.inference)
			? { ...(current.inference as Record<string, unknown>) }
			: {};
	inference[key] = value;
	await writeJson(filePath, {
		...current,
		inference,
	});
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
	await setProjectInferenceValue(ctx.cwd, key, value);
	await refreshCompositionConfig(ctx, composition);
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

	const rawModelRef = tokens.slice(1).join(" ").trim();
	if (!rawModelRef) {
		ctx.ui.notify("Missing model reference.", "error");
		return;
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
			ctx.ui.notify("schemaVersion is managed by migrations and cannot be set manually.", "error");
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
