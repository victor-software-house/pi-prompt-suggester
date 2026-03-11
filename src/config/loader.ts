import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptSuggesterConfig } from "./types.js";
import { validateConfig } from "./schema.js";

export interface ConfigLoader {
	load(): Promise<PromptSuggesterConfig>;
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

async function readRequiredConfig(filePath: string): Promise<PromptSuggesterConfig> {
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

const PACKAGE_DEFAULT_CONFIG_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../config/prompt-suggester.config.json",
);

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export class FileConfigLoader implements ConfigLoader {
	public constructor(
		private readonly cwd: string = process.cwd(),
		private readonly homeDir: string = os.homedir(),
	) {}

	public async load(): Promise<PromptSuggesterConfig> {
		const cwdDefaultPath = path.join(this.cwd, "config", "prompt-suggester.config.json");
		const defaultPath = (await pathExists(cwdDefaultPath)) ? cwdDefaultPath : PACKAGE_DEFAULT_CONFIG_PATH;
		const userPath = path.join(this.homeDir, ".pi", "suggester", "config.json");
		const projectPath = path.join(this.cwd, ".pi", "suggester", "config.json");

		const [defaultConfig, userConfig, projectConfig] = await Promise.all([
			readRequiredConfig(defaultPath),
			readJsonIfExists(userPath),
			readJsonIfExists(projectPath),
		]);
		const merged = deepMerge(deepMerge(defaultConfig, userConfig), projectConfig);

		if (!validateConfig(merged)) {
			throw new Error(
				`Invalid suggester config. Base defaults from ${defaultPath}; overrides from ${userPath} and ${projectPath}.`,
			);
		}
		return merged;
	}
}
