import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutoprompterConfig } from "./types.js";
import { validateConfig } from "./schema.js";

export interface ConfigLoader {
	load(): Promise<AutoprompterConfig>;
}


function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
	if (!isObject(base) || !isObject(override)) {
		return (override as T) ?? base;
	}

	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = result[key];
		if (isObject(existing) && isObject(value)) {
			result[key] = deepMerge(existing, value);
		} else if (value !== undefined) {
			result[key] = value;
		}
	}
	return result as T;
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		return JSON.parse(raw);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Failed to load config ${filePath}: ${(error as Error).message}`);
	}
}

async function readRequiredConfig(filePath: string): Promise<AutoprompterConfig> {
	let parsed: unknown;
	try {
		const raw = await fs.readFile(filePath, "utf8");
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Failed to load required default config ${filePath}: ${(error as Error).message}`);
	}

	if (!validateConfig(parsed)) {
		throw new Error(`Default config at ${filePath} is invalid.`);
	}
	return parsed;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
	if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
	return undefined;
}

function parseInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function envOverrides(): unknown {
	const enabled = parseBoolean(process.env.PI_AUTOPROMPTER_RESEED_ENABLED);
	const checkOnStart = parseBoolean(process.env.PI_AUTOPROMPTER_CHECK_ON_SESSION_START);
	const checkAfterTurn = parseBoolean(process.env.PI_AUTOPROMPTER_CHECK_AFTER_EVERY_TURN);
	const maxAssistantTurnChars = parseInteger(process.env.PI_AUTOPROMPTER_SUGGESTION_MAX_ASSISTANT_TURN_CHARS);
	const loggingLevel = process.env.PI_AUTOPROMPTER_LOG_LEVEL;
	const noSuggestionToken = process.env.PI_AUTOPROMPTER_NO_SUGGESTION_TOKEN;

	return {
		reseed: {
			...(enabled !== undefined ? { enabled } : {}),
			...(checkOnStart !== undefined ? { checkOnSessionStart: checkOnStart } : {}),
			...(checkAfterTurn !== undefined ? { checkAfterEveryTurn: checkAfterTurn } : {}),
		},
		suggestion: {
			...(noSuggestionToken !== undefined ? { noSuggestionToken } : {}),
			...(maxAssistantTurnChars !== undefined ? { maxAssistantTurnChars } : {}),
		},
		logging: {
			...(loggingLevel !== undefined ? { level: loggingLevel as AutoprompterConfig["logging"]["level"] } : {}),
		},
	};
}

export class FileConfigLoader implements ConfigLoader {
	public constructor(
		private readonly cwd: string = process.cwd(),
		private readonly homeDir: string = os.homedir(),
	) {}

	public async load(): Promise<AutoprompterConfig> {
		const defaultPath = path.join(this.cwd, "config", "autoprompter.config.example.json");
		const userPath = path.join(this.homeDir, ".pi", "autoprompter", "config.json");
		const projectPath = path.join(this.cwd, ".pi", "autoprompter", "config.json");

		const [defaultConfig, userConfig, projectConfig] = await Promise.all([
			readRequiredConfig(defaultPath),
			readJsonIfExists(userPath),
			readJsonIfExists(projectPath),
		]);
		const merged = deepMerge(
			deepMerge(deepMerge(defaultConfig, userConfig), projectConfig),
			envOverrides(),
		);

		if (!validateConfig(merged)) {
			throw new Error(
				`Invalid autoprompter config. Base defaults from ${defaultPath}; overrides from ${userPath}, ${projectPath}, and PI_AUTOPROMPTER_* env.`,
			);
		}
		return merged;
	}
}
