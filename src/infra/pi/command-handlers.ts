import { promises as fs } from "node:fs";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { LoggedEvent } from "../../app/ports/event-log.js";
import type { AppComposition } from "../../composition/root.js";
import type { PromptSuggesterConfig, ThinkingLevel } from "../../config/types.js";

type ModelRole = "seeder" | "suggester";

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

	return [
		"Suggester status",
		`- seed: ${seed ? `present (${seed.generatedAt})` : "missing"}`,
		`- key files: ${seed?.keyFiles.map((file) => `${file.path} [${file.category}]`).join(", ") || "(none)"}`,
		`- last reseed reason: ${seed?.lastReseedReason ?? "(none)"}`,
		`- implementation status: ${seed?.implementationStatusSummary?.slice(0, 140) ?? "(none)"}`,
		`- active session model: ${activeModel}`,
		`- models (config): seeder=${config.inference.seederModel}, suggester=${config.inference.suggesterModel}`,
		`- thinking (config): seeder=${config.inference.seederThinking}, suggester=${config.inference.suggesterThinking}`,
		`- prompt suggester usage: calls=${state.suggestionUsage.calls}, totalTokens=${state.suggestionUsage.totalTokens}, totalCost=$${state.suggestionUsage.costTotal.toFixed(4)}`,
		`- logs: .pi/suggester/logs/events.ndjson (use /suggester seed-trace)`,
		`- last suggestion: ${state.lastSuggestion?.text ?? "(none)"}`,
		`- steering history: exact=${steeringSummary.exact}, edited=${steeringSummary.edited}, changed=${steeringSummary.changed}`,
	].join("\n");
}

function projectOverridePath(cwd: string): string {
	return path.join(cwd, ".pi", "suggester", "config.json");
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

async function applyConfigChange(
	ctx: ExtensionCommandContext,
	cwd: string,
	key: keyof PromptSuggesterConfig["inference"],
	value: string,
): Promise<void> {
	await setProjectInferenceValue(cwd, key, value);
	ctx.ui.notify(`suggester config updated: inference.${key}=${value}. Reloading...`, "info");
	await ctx.reload();
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
		await applyConfigChange(ctx, ctx.cwd, key, SESSION_DEFAULT);
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

	await applyConfigChange(ctx, ctx.cwd, key, resolved.canonicalRef);
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
		await applyConfigChange(ctx, ctx.cwd, key, SESSION_DEFAULT);
		return;
	}

	const rawLevel = tokens[1]?.trim().toLowerCase();
	if (!rawLevel || ![...THINKING_LEVELS, SESSION_DEFAULT].includes(rawLevel as ThinkingLevel | typeof SESSION_DEFAULT)) {
		ctx.ui.notify("Thinking level must be one of: minimal, low, medium, high, xhigh, session-default", "error");
		return;
	}

	await applyConfigChange(ctx, ctx.cwd, key, rawLevel);
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
