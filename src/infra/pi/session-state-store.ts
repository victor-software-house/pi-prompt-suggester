import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { StateStore } from "../../app/ports/state-store.js";
import { CURRENT_RUNTIME_STATE_VERSION, INITIAL_RUNTIME_STATE, type RuntimeState } from "../../domain/state.js";

const STATE_CUSTOM_TYPE = "suggester-state";

interface BranchReadableSessionManager {
	getBranch(): SessionEntry[];
}

function extractState(entries: SessionEntry[]): RuntimeState {
	let latest: RuntimeState | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
			latest = entry.data as RuntimeState;
		}
	}
	if (!latest) return INITIAL_RUNTIME_STATE;
	const usage = latest.suggestionUsage ?? INITIAL_RUNTIME_STATE.suggestionUsage;
	return {
		stateVersion: CURRENT_RUNTIME_STATE_VERSION,
		lastSuggestion: latest.lastSuggestion,
		steeringHistory: Array.isArray(latest.steeringHistory) ? latest.steeringHistory : [],
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
		return extractState(sessionManager.getBranch());
	}

	public async save(state: RuntimeState): Promise<void> {
		this.pi.appendEntry<RuntimeState>(STATE_CUSTOM_TYPE, {
			stateVersion: CURRENT_RUNTIME_STATE_VERSION,
			lastSuggestion: state.lastSuggestion,
			steeringHistory: state.steeringHistory,
			suggestionUsage: state.suggestionUsage,
		});
	}
}

export { STATE_CUSTOM_TYPE };
