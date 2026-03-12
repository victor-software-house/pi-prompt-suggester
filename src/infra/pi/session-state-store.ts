import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { StateStore } from "../../app/ports/state-store.js";
import { CURRENT_RUNTIME_STATE_VERSION, INITIAL_RUNTIME_STATE, type RuntimeState, type SuggestionUsageStats } from "../../domain/state.js";
import type { SuggestionUsage } from "../../domain/suggestion.js";
import { atomicWriteJson } from "../storage/atomic-write.js";

const LEGACY_STATE_CUSTOM_TYPE = "suggester-state";
const LEGACY_USAGE_CUSTOM_TYPE = "suggester-usage";
const STORE_SCHEMA_VERSION = 1;
const ROOT_STATE_KEY = "__root__";

interface SessionReadableManager {
	getBranch(): SessionEntry[];
	getEntries(): SessionEntry[];
	getSessionFile(): string | undefined;
	getSessionId(): string;
	getLeafId(): string | null;
	getCwd(): string;
}

interface UsageLedgerEntry {
	kind: "suggester" | "seeder";
	usage: SuggestionUsage;
	at?: string;
}

interface PersistedInteractionState {
	stateVersion: number;
	lastSuggestion?: RuntimeState["lastSuggestion"];
	steeringHistory: RuntimeState["steeringHistory"];
	turnsSinceLastStalenessCheck: number;
}

interface PersistedUsageState {
	schemaVersion: number;
	suggestionUsage: SuggestionUsageStats;
	seederUsage: SuggestionUsageStats;
	updatedAt: string;
}

interface PersistedSessionMetadata {
	schemaVersion: number;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	ignoreLegacyPiSessionEntries: true;
	legacyMigration: {
		performedAt: string;
		importedLegacyEntries: boolean;
		legacyStateEntryCount: number;
		legacyUsageEntryCount: number;
		note: string;
	};
}

interface SessionStorageContext {
	sessionId: string;
	sessionFile: string | undefined;
	storageDir?: string;
	interactionDir?: string;
	usageFile?: string;
	metaFile?: string;
	lookupKeys: string[];
	currentKey: string;
	persistent: boolean;
}

interface InMemorySessionState {
	interaction: PersistedInteractionState;
	usage: SuggestionUsageStatsPair;
}

interface SuggestionUsageStatsPair {
	suggester: SuggestionUsageStats;
	seeder: SuggestionUsageStats;
}

function emptyUsageStats(): SuggestionUsageStats {
	return {
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costTotal: 0,
	};
}

function emptyUsagePair(): SuggestionUsageStatsPair {
	return {
		suggester: emptyUsageStats(),
		seeder: emptyUsageStats(),
	};
}

function cloneUsageStats(stats: SuggestionUsageStats): SuggestionUsageStats {
	return {
		calls: stats.calls,
		inputTokens: stats.inputTokens,
		outputTokens: stats.outputTokens,
		cacheReadTokens: stats.cacheReadTokens,
		cacheWriteTokens: stats.cacheWriteTokens,
		totalTokens: stats.totalTokens,
		costTotal: stats.costTotal,
		last: stats.last ? { ...stats.last } : undefined,
	};
}

function cloneUsagePair(pair: SuggestionUsageStatsPair): SuggestionUsageStatsPair {
	return {
		suggester: cloneUsageStats(pair.suggester),
		seeder: cloneUsageStats(pair.seeder),
	};
}

function normalizeUsageStats(raw: unknown, fallback: SuggestionUsageStats): SuggestionUsageStats {
	const usage = (raw ?? fallback) as Partial<SuggestionUsageStats>;
	return {
		calls: Number(usage.calls ?? 0),
		inputTokens: Number(usage.inputTokens ?? 0),
		outputTokens: Number(usage.outputTokens ?? 0),
		cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
		cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
		totalTokens: Number(usage.totalTokens ?? 0),
		costTotal: Number(usage.costTotal ?? 0),
		last: usage.last,
	};
}

function addUsage(current: SuggestionUsageStats, usage: SuggestionUsage): SuggestionUsageStats {
	return {
		calls: current.calls + 1,
		inputTokens: current.inputTokens + usage.inputTokens,
		outputTokens: current.outputTokens + usage.outputTokens,
		cacheReadTokens: current.cacheReadTokens + usage.cacheReadTokens,
		cacheWriteTokens: current.cacheWriteTokens + usage.cacheWriteTokens,
		totalTokens: current.totalTokens + usage.totalTokens,
		costTotal: current.costTotal + usage.costTotal,
		last: usage,
	};
}

function parseUsage(raw: unknown): SuggestionUsage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const usage = raw as Partial<SuggestionUsage>;
	if (
		typeof usage.inputTokens !== "number" ||
		typeof usage.outputTokens !== "number" ||
		typeof usage.cacheReadTokens !== "number" ||
		typeof usage.cacheWriteTokens !== "number" ||
		typeof usage.totalTokens !== "number" ||
		typeof usage.costTotal !== "number"
	) {
		return undefined;
	}
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		totalTokens: usage.totalTokens,
		costTotal: usage.costTotal,
	};
}

function normalizeInteractionState(raw: unknown): PersistedInteractionState {
	const latest = (raw ?? INITIAL_RUNTIME_STATE) as Partial<RuntimeState> & { steeringHistory?: unknown };
	return {
		stateVersion: CURRENT_RUNTIME_STATE_VERSION,
		lastSuggestion: latest.lastSuggestion,
		steeringHistory: Array.isArray(latest.steeringHistory) ? latest.steeringHistory : [],
		turnsSinceLastStalenessCheck: Math.max(0, Number(latest.turnsSinceLastStalenessCheck ?? 0)),
	};
}

function toRuntimeState(interaction: PersistedInteractionState, usage: SuggestionUsageStatsPair): RuntimeState {
	return {
		stateVersion: CURRENT_RUNTIME_STATE_VERSION,
		lastSuggestion: interaction.lastSuggestion,
		steeringHistory: interaction.steeringHistory,
		suggestionUsage: cloneUsageStats(usage.suggester),
		seederUsage: cloneUsageStats(usage.seeder),
		turnsSinceLastStalenessCheck: interaction.turnsSinceLastStalenessCheck,
	};
}

function toPersistedInteractionState(state: RuntimeState): PersistedInteractionState {
	return normalizeInteractionState({
		stateVersion: CURRENT_RUNTIME_STATE_VERSION,
		lastSuggestion: state.lastSuggestion,
		steeringHistory: state.steeringHistory,
		turnsSinceLastStalenessCheck: state.turnsSinceLastStalenessCheck,
	});
}

function extractUsageTotals(entries: SessionEntry[]): {
	hasLedger: boolean;
	suggester: SuggestionUsageStats;
	seeder: SuggestionUsageStats;
	legacyUsageEntryCount: number;
} {
	let hasLedger = false;
	let legacyUsageEntryCount = 0;
	let suggester = emptyUsageStats();
	let seeder = emptyUsageStats();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LEGACY_USAGE_CUSTOM_TYPE) continue;
		legacyUsageEntryCount += 1;
		const data = entry.data as UsageLedgerEntry;
		const usage = parseUsage(data?.usage);
		if (!usage) continue;
		hasLedger = true;
		if (data.kind === "seeder") seeder = addUsage(seeder, usage);
		else suggester = addUsage(suggester, usage);
	}

	return { hasLedger, suggester, seeder, legacyUsageEntryCount };
}

function extractLegacyInteractionSnapshots(entries: SessionEntry[]): Map<string, PersistedInteractionState> {
	const snapshots = new Map<string, PersistedInteractionState>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LEGACY_STATE_CUSTOM_TYPE) continue;
		snapshots.set(entry.id, normalizeInteractionState(entry.data));
	}
	return snapshots;
}

function normalizeSessionKey(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export class SessionStateStore implements StateStore {
	private readonly inMemory = new Map<string, InMemorySessionState>();
	private readonly usageTasks = new Map<string, Promise<void>>();
	private readonly migrationTasks = new Map<string, Promise<void>>();

	public constructor(
		private readonly cwd: string,
		private readonly getSessionManager: () => SessionReadableManager | undefined,
	) {}

	public async load(): Promise<RuntimeState> {
		const context = this.getStorageContext();
		if (!context) return INITIAL_RUNTIME_STATE;

		if (!context.persistent) {
			const current = this.inMemory.get(context.sessionId);
			if (current) {
				return toRuntimeState(current.interaction, current.usage);
			}
			return INITIAL_RUNTIME_STATE;
		}

		await this.ensureMigrated(context);
		const interaction = await this.loadInteractionState(context);
		const usage = await this.loadUsageState(context);
		return toRuntimeState(interaction, usage);
	}

	public async save(state: RuntimeState): Promise<void> {
		const context = this.getStorageContext();
		if (!context) return;

		const interaction = toPersistedInteractionState(state);
		if (!context.persistent) {
			const current = this.inMemory.get(context.sessionId) ?? { interaction, usage: emptyUsagePair() };
			current.interaction = interaction;
			this.inMemory.set(context.sessionId, current);
			return;
		}

		await this.ensureMigrated(context);
		await fs.mkdir(context.interactionDir!, { recursive: true });
		await atomicWriteJson(this.stateFilePath(context.interactionDir!, context.currentKey), interaction);
	}

	public async recordUsage(kind: "suggester" | "seeder", usage: SuggestionUsage): Promise<void> {
		const context = this.getStorageContext();
		if (!context) return;

		if (!context.persistent) {
			const current = this.inMemory.get(context.sessionId) ?? {
				interaction: normalizeInteractionState(INITIAL_RUNTIME_STATE),
				usage: emptyUsagePair(),
			};
			current.usage = {
				...current.usage,
				[kind]: addUsage(current.usage[kind], usage),
			};
			this.inMemory.set(context.sessionId, current);
			return;
		}

		await this.ensureMigrated(context);
		const usageKey = context.usageFile!;
		const existingTask = this.usageTasks.get(usageKey) ?? Promise.resolve();
		const task = existingTask.then(async () => {
			const current = await this.loadUsageState(context);
			const next = {
				suggester: kind === "suggester" ? addUsage(current.suggester, usage) : current.suggester,
				seeder: kind === "seeder" ? addUsage(current.seeder, usage) : current.seeder,
			};
			await fs.mkdir(path.dirname(usageKey), { recursive: true });
			await atomicWriteJson(usageKey, {
				schemaVersion: STORE_SCHEMA_VERSION,
				suggestionUsage: next.suggester,
				seederUsage: next.seeder,
				updatedAt: new Date().toISOString(),
			} satisfies PersistedUsageState);
		});
		this.usageTasks.set(usageKey, task.finally(() => {
			if (this.usageTasks.get(usageKey) === task) this.usageTasks.delete(usageKey);
		}));
		await task;
	}

	private getStorageContext(): SessionStorageContext | undefined {
		const sessionManager = this.getSessionManager();
		if (!sessionManager) return undefined;

		const sessionId = normalizeSessionKey(sessionManager.getSessionId());
		const sessionFile = sessionManager.getSessionFile();
		const branch = sessionManager.getBranch();
		const lookupKeys = branch.map((entry: SessionEntry) => entry.id).reverse();
		lookupKeys.push(ROOT_STATE_KEY);
		const currentKey = sessionManager.getLeafId() ?? ROOT_STATE_KEY;
		if (!sessionFile) {
			return {
				sessionId,
				sessionFile,
				lookupKeys,
				currentKey,
				persistent: false,
			};
		}

		const storageDir = path.join(this.cwd, ".pi", "suggester", "sessions", sessionId);
		return {
			sessionId,
			sessionFile,
			storageDir,
			interactionDir: path.join(storageDir, "interaction"),
			usageFile: path.join(storageDir, "usage.json"),
			metaFile: path.join(storageDir, "meta.json"),
			lookupKeys,
			currentKey,
			persistent: true,
		};
	}

	private stateFilePath(interactionDir: string, key: string): string {
		return path.join(interactionDir, `${normalizeSessionKey(key)}.json`);
	}

	private async loadUsageState(context: SessionStorageContext): Promise<SuggestionUsageStatsPair> {
		const persisted = await readJson<PersistedUsageState>(context.usageFile!);
		if (!persisted) return emptyUsagePair();
		return {
			suggester: normalizeUsageStats(persisted.suggestionUsage, emptyUsageStats()),
			seeder: normalizeUsageStats(persisted.seederUsage, emptyUsageStats()),
		};
	}

	private async loadInteractionState(context: SessionStorageContext): Promise<PersistedInteractionState> {
		for (const key of context.lookupKeys) {
			const state = await readJson<PersistedInteractionState>(this.stateFilePath(context.interactionDir!, key));
			if (state) return normalizeInteractionState(state);
		}
		return normalizeInteractionState(INITIAL_RUNTIME_STATE);
	}

	private async ensureMigrated(context: SessionStorageContext): Promise<void> {
		const migrationKey = context.storageDir!;
		const existingTask = this.migrationTasks.get(migrationKey);
		if (existingTask) {
			await existingTask;
			return;
		}
		const task = this.performMigration(context).finally(() => {
			this.migrationTasks.delete(migrationKey);
		});
		this.migrationTasks.set(migrationKey, task);
		await task;
	}

	private async performMigration(context: SessionStorageContext): Promise<void> {
		await fs.mkdir(context.storageDir!, { recursive: true });
		const existingMeta = await readJson<PersistedSessionMetadata>(context.metaFile!);
		if (existingMeta?.schemaVersion === STORE_SCHEMA_VERSION) return;

		const sessionManager = this.getSessionManager();
		const allEntries = sessionManager?.getEntries() ?? [];
		const usageTotals = extractUsageTotals(allEntries);
		const legacySnapshots = extractLegacyInteractionSnapshots(allEntries);
		const importedLegacyEntries = legacySnapshots.size > 0 || usageTotals.hasLedger;

		await fs.mkdir(context.interactionDir!, { recursive: true });
		for (const [entryId, interaction] of legacySnapshots.entries()) {
			await atomicWriteJson(this.stateFilePath(context.interactionDir!, entryId), interaction);
		}

		if (!(await readJson<PersistedUsageState>(context.usageFile!))) {
			await atomicWriteJson(context.usageFile!, {
				schemaVersion: STORE_SCHEMA_VERSION,
				suggestionUsage: usageTotals.suggester,
				seederUsage: usageTotals.seeder,
				updatedAt: new Date().toISOString(),
			} satisfies PersistedUsageState);
		}

		await atomicWriteJson(context.metaFile!, {
			schemaVersion: STORE_SCHEMA_VERSION,
			sessionId: context.sessionId,
			sessionFile: context.sessionFile,
			cwd: sessionManager?.getCwd() ?? this.cwd,
			ignoreLegacyPiSessionEntries: true,
			legacyMigration: {
				performedAt: new Date().toISOString(),
				importedLegacyEntries,
				legacyStateEntryCount: legacySnapshots.size,
				legacyUsageEntryCount: usageTotals.legacyUsageEntryCount,
				note: "Legacy suggester-state/suggester-usage pi session entries were imported once into extension-owned storage and are ignored afterwards.",
			},
		} satisfies PersistedSessionMetadata);
	}
}
