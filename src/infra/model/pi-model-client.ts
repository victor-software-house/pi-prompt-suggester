import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { completeSimple, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModelClient } from "../../app/ports/model-client.js";
import type { SuggestionPromptContext } from "../../app/services/prompt-context-builder.js";
import type { SuggestionUsage } from "../../domain/suggestion.js";
import type { ModelRoleSettings } from "../../domain/state.js";
import {
	REQUIRED_SEED_CATEGORIES,
	type SeedArtifact,
	type SeedCategoryFindings,
	type SeedDraft,
	type SeedKeyFileCategory,
} from "../../domain/seed.js";
import { renderSeederSystemPrompt, renderSeederUserPrompt } from "../../prompts/seeder-template.js";
import { renderSuggestionPrompt } from "../../prompts/suggestion-template.js";

const execFileAsync = promisify(execFile);
const IGNORED_DIRS = new Set([".git", "node_modules", ".pi", "dist", "build", "coverage"]);

export interface RuntimeContextProvider {
	getContext(): ExtensionContext | undefined;
}

type SeederToolName = "ls" | "find" | "grep" | "read";

type SeederModelResponse =
	| {
			type: "tool";
			tool: SeederToolName;
			arguments?: Record<string, unknown>;
			reason?: string;
	  }
	| {
			type: "final";
			seed: Record<string, unknown>;
	  };

interface SeederHistoryEntry {
	modelResponse: string;
	toolResult?: string;
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block && typeof block === "object" && "type" in block && (block as { type?: string }).type === "text") {
				return String((block as { text?: unknown }).text ?? "");
			}
			return "";
		})
		.join("\n")
		.trim();
}

function parseJsonObject(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		const match = trimmed.match(/\{[\s\S]*\}/);
		if (!match) throw new Error("Model did not return JSON");
		return JSON.parse(match[0]) as Record<string, unknown>;
	}
}

function coerceStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => String(entry)).map((entry) => entry.trim()).filter(Boolean);
}

function coerceCategory(value: unknown): SeedKeyFileCategory {
	const category = String(value ?? "other").trim();
	if (
		category === "vision" ||
		category === "architecture" ||
		category === "principles_guidelines" ||
		category === "code_entrypoint" ||
		category === "other"
	) {
		return category;
	}
	return "other";
}

function coerceCategoryFindings(value: unknown): SeedCategoryFindings | undefined {
	if (!value || typeof value !== "object") return undefined;
	const obj = value as Record<string, unknown>;
	const categories: Array<"vision" | "architecture" | "principles_guidelines"> = [
		"vision",
		"architecture",
		"principles_guidelines",
	];
	const findings = {} as SeedCategoryFindings;
	for (const category of categories) {
		const raw = obj[category];
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		findings[category] = {
			found: Boolean(entry.found),
			rationale: String(entry.rationale ?? "").trim(),
			files: coerceStringArray(entry.files),
		};
	}
	return Object.keys(findings).length > 0 ? findings : undefined;
}

function coerceSeedDraft(payload: Record<string, unknown>): SeedDraft {
	const keyFiles = Array.isArray(payload.keyFiles)
		? payload.keyFiles
				.map((entry) => {
					if (!entry || typeof entry !== "object") return null;
					const filePath = String((entry as { path?: unknown }).path ?? "").trim();
					const whyImportant = String((entry as { whyImportant?: unknown }).whyImportant ?? "").trim();
					if (!filePath) return null;
					return {
						path: filePath,
						whyImportant: whyImportant || "High-signal file",
						category: coerceCategory((entry as { category?: unknown }).category),
					};
				})
				.filter((entry): entry is { path: string; whyImportant: string; category: SeedKeyFileCategory } => entry !== null)
		: [];

	const topObjectives = coerceStringArray(payload.topObjectives);
	const constraints = coerceStringArray(payload.constraints);
	const objectivesSummary = String(payload.objectivesSummary ?? "").trim() || topObjectives.join("\n");
	const constraintsSummary = String(payload.constraintsSummary ?? "").trim() || constraints.join("\n");
	return {
		projectIntentSummary: String(payload.projectIntentSummary ?? payload.visionSummary ?? "").trim(),
		objectivesSummary,
		constraintsSummary,
		principlesGuidelinesSummary: String(payload.principlesGuidelinesSummary ?? payload.guidelinesSummary ?? "").trim(),
		implementationStatusSummary: String(payload.implementationStatusSummary ?? payload.statusSummary ?? "").trim(),
		topObjectives,
		constraints,
		keyFiles,
		categoryFindings: coerceCategoryFindings(payload.categoryFindings),
		openQuestions: coerceStringArray(payload.openQuestions),
		reseedNotes: String(payload.reseedNotes ?? "").trim() || undefined,
	};
}

function parseSeederResponse(text: string): SeederModelResponse {
	const parsed = parseJsonObject(text);
	const type = String(parsed.type ?? "").trim();
	if (type === "tool") {
		const tool = String(parsed.tool ?? "").trim() as SeederToolName;
		if (!tool || !["ls", "find", "grep", "read"].includes(tool)) {
			throw new Error(`Invalid seeder tool: ${tool || "(empty)"}`);
		}
		return {
			type: "tool",
			tool,
			arguments: (parsed.arguments ?? {}) as Record<string, unknown>,
			reason: String(parsed.reason ?? "").trim() || undefined,
		};
	}
	if (type === "final") {
		if (!parsed.seed || typeof parsed.seed !== "object") {
			throw new Error("Seeder final response missing seed object");
		}
		return {
			type: "final",
			seed: parsed.seed as Record<string, unknown>,
		};
	}
	throw new Error(`Invalid seeder response type: ${type || "(empty)"}`);
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "::DOUBLE_STAR::")
		.replace(/\*/g, "[^/]*")
		.replace(/::DOUBLE_STAR::/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

function validateSeedCoverage(draft: SeedDraft): { ok: boolean; reason?: string } {
	const findings = draft.categoryFindings;
	if (!findings) {
		return { ok: false, reason: "Missing categoryFindings. Provide explicit findings for vision/architecture/principles_guidelines." };
	}

	for (const category of REQUIRED_SEED_CATEGORIES) {
		const finding = findings[category as "vision" | "architecture" | "principles_guidelines"];
		if (!finding) {
			return { ok: false, reason: `Missing categoryFindings.${category}` };
		}
		if (!finding.rationale.trim()) {
			return { ok: false, reason: `categoryFindings.${category}.rationale is empty` };
		}
		const hasCategoryFile = draft.keyFiles.some((file) => file.category === category);
		if (finding.found && !hasCategoryFile) {
			return {
				ok: false,
				reason: `categoryFindings.${category}.found=true but no keyFiles are marked as ${category}`,
			};
		}
	}

	return { ok: true };
}

export class PiModelClient implements ModelClient {
	private readonly cwd: string;

	public constructor(private readonly runtime: RuntimeContextProvider, cwd: string = process.cwd()) {
		this.cwd = cwd;
	}

	public async generateSeed(input: {
		reseedTrigger: import("../../domain/seed.js").ReseedTrigger;
		previousSeed: SeedArtifact | null;
		settings?: ModelRoleSettings;
	}): Promise<SeedDraft> {
		const systemPrompt = renderSeederSystemPrompt();
		const history: SeederHistoryEntry[] = [];
		const maxSteps = 16;

		for (let step = 1; step <= maxSteps; step += 1) {
			const prompt = renderSeederUserPrompt({
				reseedTrigger: input.reseedTrigger,
				previousSeed: input.previousSeed,
				cwd: this.cwd,
				step,
				maxSteps,
				history,
			});
			const responseText = await this.completePrompt(prompt, systemPrompt, input.settings);
			const response = parseSeederResponse(responseText.text);

			if (response.type === "final") {
				const draft = coerceSeedDraft(response.seed);
				if (!draft.projectIntentSummary) throw new Error("Seeder final response missing projectIntentSummary");
				if (!draft.objectivesSummary) throw new Error("Seeder final response missing objectivesSummary");
				if (!draft.constraintsSummary) throw new Error("Seeder final response missing constraintsSummary");
				if (!draft.principlesGuidelinesSummary) throw new Error("Seeder final response missing principlesGuidelinesSummary");
				if (!draft.implementationStatusSummary) throw new Error("Seeder final response missing implementationStatusSummary");
				if (draft.keyFiles.length === 0) throw new Error("Seeder final response produced no keyFiles");
				const validation = validateSeedCoverage(draft);
				if (validation.ok) {
					return draft;
				}
				history.push({
					modelResponse: responseText.text,
					toolResult: `Validation failed: ${validation.reason}. Continue exploring and/or explicitly report not-found categories in categoryFindings.`,
				});
				continue;
			}

			const toolResult = await this.executeSeederTool(response.tool, response.arguments ?? {});
			history.push({
				modelResponse: responseText.text,
				toolResult,
			});
		}

		throw new Error("Seeder exceeded max exploration steps without returning final seed");
	}

	public async generateSuggestion(
		context: SuggestionPromptContext,
		settings?: ModelRoleSettings,
	): Promise<{ text: string; usage?: SuggestionUsage }> {
		return await this.completePrompt(renderSuggestionPrompt(context), undefined, settings);
	}

	private async completePrompt(
		prompt: string,
		systemPrompt?: string,
		settings?: ModelRoleSettings,
	): Promise<{ text: string; usage?: SuggestionUsage }> {
		const ctx = this.runtime.getContext();
		if (!ctx?.model) {
			throw new Error("No active model available for autoprompter");
		}

		const model = this.resolveModelForCall(ctx.model, settings?.modelRef, ctx.modelRegistry.getAll());
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		};

		const response = await completeSimple(
			model,
			{
				systemPrompt:
					systemPrompt ??
					"You are the internal model used by pi-autoprompter. Follow the user prompt exactly and return only the requested format.",
				messages: [userMessage],
			},
			{
				apiKey,
				reasoning: settings?.thinkingLevel,
			},
		);
		const text = extractText(response.content);
		if (!text) throw new Error("Model returned empty text");
		return {
			text,
			usage: {
				inputTokens: Number(response.usage?.input ?? 0),
				outputTokens: Number(response.usage?.output ?? 0),
				cacheReadTokens: Number(response.usage?.cacheRead ?? 0),
				cacheWriteTokens: Number(response.usage?.cacheWrite ?? 0),
				totalTokens: Number(response.usage?.totalTokens ?? 0),
				costTotal: Number(response.usage?.cost?.total ?? 0),
			},
		};
	}

	private resolveModelForCall(currentModel: Model<any>, modelRef: string | undefined, allModels: Model<any>[]): Model<any> {
		const normalized = (modelRef ?? "").trim();
		if (!normalized) return currentModel;
		if (normalized.includes("/")) {
			const [provider, ...rest] = normalized.split("/");
			const id = rest.join("/");
			const exact = allModels.find((entry) => entry.provider === provider && entry.id === id);
			if (exact) return exact;
			throw new Error(`Configured autoprompter model not found: ${normalized}`);
		}
		const candidates = allModels.filter((entry) => entry.id === normalized);
		if (candidates.length === 1) return candidates[0];
		if (candidates.length > 1) {
			throw new Error(
				`Configured autoprompter model '${normalized}' is ambiguous. Use provider/id, e.g. ${candidates[0].provider}/${candidates[0].id}`,
			);
		}
		throw new Error(`Configured autoprompter model not found: ${normalized}`);
	}

	private async executeSeederTool(tool: SeederToolName, args: Record<string, unknown>): Promise<string> {
		switch (tool) {
			case "ls":
				return await this.toolLs(args);
			case "find":
				return await this.toolFind(args);
			case "grep":
				return await this.toolGrep(args);
			case "read":
				return await this.toolRead(args);
			default:
				return "Unsupported tool";
		}
	}

	private resolvePath(inputPath: unknown): string {
		const value = typeof inputPath === "string" && inputPath.trim().length > 0 ? inputPath.trim() : ".";
		const clean = value.replace(/^@/, "");
		const absolute = path.resolve(this.cwd, clean);
		if (absolute !== this.cwd && !absolute.startsWith(`${this.cwd}${path.sep}`)) {
			throw new Error(`Path escapes repository root: ${value}`);
		}
		return absolute;
	}

	private async toolLs(args: Record<string, unknown>): Promise<string> {
		const absolute = this.resolvePath(args.path);
		const limit = Math.min(500, Math.max(1, Number(args.limit ?? 200)));
		const entries = await fs.readdir(absolute, { withFileTypes: true });
		const lines = entries
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, limit)
			.map((entry) => `${entry.isDirectory() ? "d" : "f"} ${path.relative(this.cwd, path.join(absolute, entry.name)) || "."}`);
		return truncate(lines.join("\n") || "(empty)", 8000);
	}

	private async toolFind(args: Record<string, unknown>): Promise<string> {
		const absolute = this.resolvePath(args.path);
		const pattern = String(args.pattern ?? "").trim();
		if (!pattern) throw new Error("find requires pattern");
		const limit = Math.min(500, Math.max(1, Number(args.limit ?? 200)));
		const matcher = globToRegExp(pattern.includes("*") || pattern.includes("?") ? pattern : `**/*${pattern}*`);
		const results: string[] = [];

		const walk = async (dir: string): Promise<void> => {
			if (results.length >= limit) return;
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (results.length >= limit) break;
				if (entry.isDirectory()) {
					if (IGNORED_DIRS.has(entry.name)) continue;
					await walk(path.join(dir, entry.name));
					continue;
				}
				const rel = path.relative(this.cwd, path.join(dir, entry.name));
				if (matcher.test(rel.replaceAll("\\", "/"))) results.push(rel);
			}
		};

		await walk(absolute);
		return truncate(results.join("\n") || "(no matches)", 8000);
	}

	private async toolGrep(args: Record<string, unknown>): Promise<string> {
		const searchPath = this.resolvePath(args.path);
		const pattern = String(args.pattern ?? "").trim();
		if (!pattern) throw new Error("grep requires pattern");
		const limit = Math.min(200, Math.max(1, Number(args.limit ?? 80)));
		const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(limit)];
		if (args.ignoreCase === true) rgArgs.push("-i");
		if (args.literal === true) rgArgs.push("-F");
		if (typeof args.glob === "string" && args.glob.trim()) rgArgs.push("-g", args.glob.trim());
		rgArgs.push(pattern, searchPath);

		try {
			const { stdout } = await execFileAsync("rg", rgArgs, {
				cwd: this.cwd,
				maxBuffer: 1024 * 1024 * 10,
			});
			return truncate(stdout.trim() || "(no matches)", 8000);
		} catch (error) {
			const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
			if (String(err.code) === "1") return "(no matches)";
			const stdout = typeof err.stdout === "string" ? err.stdout.trim() : "";
			const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
			return truncate([stdout, stderr].filter(Boolean).join("\n") || "(grep failed)", 8000);
		}
	}

	private async toolRead(args: Record<string, unknown>): Promise<string> {
		const absolute = this.resolvePath(args.path);
		const offset = Math.max(1, Number(args.offset ?? 1));
		const limit = Math.min(1200, Math.max(1, Number(args.limit ?? 220)));
		const raw = await fs.readFile(absolute, "utf8");
		const lines = raw.split(/\r?\n/);
		const start = offset - 1;
		const sliced = lines.slice(start, start + limit);
		const numbered = sliced.map((line, index) => `${start + index + 1}: ${line}`);
		return truncate(numbered.join("\n") || "(empty)", 12000);
	}
}
