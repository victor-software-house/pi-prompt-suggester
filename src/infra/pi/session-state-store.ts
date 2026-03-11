import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { StateStore } from "../../app/ports/state-store.js";
import { CURRENT_RUNTIME_STATE_VERSION, INITIAL_RUNTIME_STATE, type RuntimeState, type SuggestionUsageStats } from "../../domain/state.js";
import type { SuggestionUsage } from "../../domain/suggestion.js";

const STATE_CUSTOM_TYPE = "suggester-state";
const USAGE_CUSTOM_TYPE = "suggester-usage";

interface BranchReadableSessionManager {
	getBranch(): SessionEntry[];
	getEntries?(): SessionEntry[];
}

interface UsageLedgerEntry {
	kind: "suggester" | "seeder";
	usage: SuggestionUsage;
	at?: string;
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

function extractUsageTotals(entries: SessionEntry[]): {
	hasLedger: boolean;
	suggester: SuggestionUsageStats;
	seeder: SuggestionUsageStats;
} {
	let hasLedger = false;
	let suggester = emptyUsageStats();
	let seeder = emptyUsageStats();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== USAGE_CUSTOM_TYPE) continue;
		const data = entry.data as UsageLedgerEntry;
		const usage = parseUsage(data?.usage);
		if (!usage) continue;
		hasLedger = true;
		if (data.kind === "seeder") seeder = addUsage(seeder, usage);
		else suggester = addUsage(suggester, usage);
	}

	return { hasLedger, suggester, seeder };
}

function extractLatestBranchState(entries: SessionEntry[]): RuntimeState {
	let latest: RuntimeState | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
			latest = entry.data as RuntimeState;
		}
	}
	if (!latest) return INITIAL_RUNTIME_STATE;

	const rejectionHints = Array.isArray(latest.rejectionHints)
		? latest.rejectionHints
				.map((entry) => ({
					id: String(entry.id ?? "").trim(),
					hint: String(entry.hint ?? "").trim(),
					includeRejectedSuggestionText: Boolean(entry.includeRejectedSuggestionText),
					rejectedSuggestionText:
						typeof entry.rejectedSuggestionText === "string" && entry.rejectedSuggestionText.trim().length > 0
							? entry.rejectedSuggestionText
							: undefined,
					remainingUses: Number(entry.remainingUses ?? 0),
					createdAt: String(entry.createdAt ?? "").trim() || new Date(0).toISOString(),
				}))
				.filter((entry) => entry.id.length > 0 && entry.hint.length > 0 && entry.remainingUses > 0)
		: [];

	return {
		stateVersion: CURRENT_RUNTIME_STATE_VERSION,
		lastSuggestion: latest.lastSuggestion,
		steeringHistory: Array.isArray(latest.steeringHistory) ? latest.steeringHistory : [],
		suggestionUsage: normalizeUsageStats(latest.suggestionUsage, INITIAL_RUNTIME_STATE.suggestionUsage),
		seederUsage: normalizeUsageStats(latest.seederUsage, INITIAL_RUNTIME_STATE.seederUsage),
		rejectionHints,
	};
}

export class SessionStateStore implements StateStore {
	public constructor(
		private readonly pi: ExtensionAPI,
		private readonly getSessionManager: () => BranchReadableSessionManager | undefined,
	) {}

	public async load(): Promise<RuntimeState> {
		const sessionManager = this.getSessionManager();
		if (!sessionManager) return INITIAL_RUNTIME_STATE;

		const branchEntries = sessionManager.getBranch();
		const allEntries = sessionManager.getEntries ? sessionManager.getEntries() : branchEntries;
		const state = extractLatestBranchState(branchEntries);
		const totals = extractUsageTotals(allEntries);
		if (!totals.hasLedger) return state;
		return {
			...state,
			suggestionUsage: totals.suggester,
			seederUsage: totals.seeder,
		};
	}

	public async save(state: RuntimeState): Promise<void> {
		this.pi.appendEntry<RuntimeState>(STATE_CUSTOM_TYPE, {
			stateVersion: CURRENT_RUNTIME_STATE_VERSION,
			lastSuggestion: state.lastSuggestion,
			steeringHistory: state.steeringHistory,
			suggestionUsage: state.suggestionUsage,
			seederUsage: state.seederUsage,
			rejectionHints: state.rejectionHints,
		});
	}

	public async recordUsage(kind: "suggester" | "seeder", usage: SuggestionUsage): Promise<void> {
		this.pi.appendEntry<UsageLedgerEntry>(USAGE_CUSTOM_TYPE, {
			kind,
			usage,
			at: new Date().toISOString(),
		});
	}
}

export { STATE_CUSTOM_TYPE, USAGE_CUSTOM_TYPE };
