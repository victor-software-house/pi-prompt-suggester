import { promises as fs } from "node:fs";
import type { StateStore } from "../../app/ports/state-store.js";
import { CURRENT_RUNTIME_STATE_VERSION, INITIAL_RUNTIME_STATE, type RuntimeState } from "../../domain/state.js";
import { atomicWriteJson } from "./atomic-write.js";

export class JsonStateStore implements StateStore {
	public constructor(private readonly filePath: string) {}

	public async load(): Promise<RuntimeState> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as RuntimeState;
			return this.normalize(parsed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.normalize(INITIAL_RUNTIME_STATE);
			throw new Error(`Failed to read state file ${this.filePath}: ${(error as Error).message}`);
		}
	}

	public async save(state: RuntimeState): Promise<void> {
		await atomicWriteJson(this.filePath, this.normalize(state));
	}

	private normalize(state: RuntimeState): RuntimeState {
		const usage = state.suggestionUsage ?? INITIAL_RUNTIME_STATE.suggestionUsage;
		const modelSettings = state.modelSettings ?? INITIAL_RUNTIME_STATE.modelSettings;
		return {
			stateVersion: CURRENT_RUNTIME_STATE_VERSION,
			lastSuggestion: state.lastSuggestion,
			steeringHistory: Array.isArray(state.steeringHistory) ? state.steeringHistory : [],
			suggestionUsage: {
				calls: Number(usage.calls ?? 0),
				inputTokens: Number(usage.inputTokens ?? 0),
				outputTokens: Number(usage.outputTokens ?? 0),
				cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
				cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
				totalTokens: Number(usage.totalTokens ?? 0),
				costTotal: Number(usage.costTotal ?? 0),
				last: usage.last,
			},
			modelSettings: {
				seeder: {
					modelRef:
						typeof modelSettings.seeder?.modelRef === "string" && modelSettings.seeder.modelRef.trim().length > 0
							? modelSettings.seeder.modelRef.trim()
							: undefined,
					thinkingLevel:
						typeof modelSettings.seeder?.thinkingLevel === "string"
							? modelSettings.seeder.thinkingLevel
							: undefined,
				},
				suggester: {
					modelRef:
						typeof modelSettings.suggester?.modelRef === "string" && modelSettings.suggester.modelRef.trim().length > 0
							? modelSettings.suggester.modelRef.trim()
							: undefined,
					thinkingLevel:
						typeof modelSettings.suggester?.thinkingLevel === "string"
							? modelSettings.suggester.thinkingLevel
							: undefined,
				},
			},
		};
	}
}
