import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PromptSuggesterConfig } from "../config/types.js";
import { FileConfigLoader } from "../config/loader.js";
import { ConsoleLogger } from "../infra/logging/console-logger.js";
import { NdjsonEventLog } from "../infra/logging/ndjson-event-log.js";
import { InMemoryTaskQueue } from "../infra/queue/in-memory-task-queue.js";
import { GitClient } from "../infra/vcs/git-client.js";
import { Sha256FileHash } from "../infra/hashing/sha256-file-hash.js";
import { JsonSeedStore } from "../infra/storage/json-seed-store.js";
import { PiModelClient } from "../infra/model/pi-model-client.js";
import { SystemClock } from "../infra/clock/system-clock.js";
import { StalenessChecker } from "../app/services/staleness-checker.js";
import { PromptContextBuilder } from "../app/services/prompt-context-builder.js";
import { SuggestionEngine } from "../app/services/suggestion-engine.js";
import { SteeringClassifier } from "../app/services/steering-classifier.js";
import { ReseedRunner } from "../app/orchestrators/reseed-runner.js";
import { SessionStartOrchestrator } from "../app/orchestrators/session-start.js";
import { TurnEndOrchestrator } from "../app/orchestrators/turn-end.js";
import { UserSubmitOrchestrator } from "../app/orchestrators/user-submit.js";
import { PiSuggestionSink, refreshSuggesterUi } from "../infra/pi/ui-adapter.js";
import { SessionStateStore } from "../infra/pi/session-state-store.js";
import { RuntimeRef } from "../infra/pi/runtime-ref.js";

export interface AppComposition {
	config: PromptSuggesterConfig;
	runtimeRef: RuntimeRef;
	stores: {
		seedStore: JsonSeedStore;
		stateStore: SessionStateStore;
	};
	eventLog: NdjsonEventLog;
	orchestrators: {
		sessionStart: SessionStartOrchestrator;
		agentEnd: TurnEndOrchestrator;
		userSubmit: UserSubmitOrchestrator;
		reseedRunner: ReseedRunner;
	};
}

export async function createAppComposition(pi: ExtensionAPI, cwd: string = process.cwd()): Promise<AppComposition> {
	const config = await new FileConfigLoader(cwd).load();
	const runtimeRef = new RuntimeRef();
	const getSuggesterModelDisplay = (): string | undefined => {
		const ctx = runtimeRef.getContext();
		if (!ctx?.model) return undefined;

		let provider = ctx.model.provider;
		let modelId = ctx.model.id;
		const configuredModel = config.inference.suggesterModel.trim();
		if (configuredModel && configuredModel !== "session-default") {
			if (configuredModel.includes("/")) {
				const [configuredProvider, ...rest] = configuredModel.split("/");
				provider = configuredProvider;
				modelId = rest.join("/");
			} else {
				const matches = ctx.modelRegistry.getAll().filter((model) => model.id === configuredModel);
				if (matches.length === 1) {
					provider = matches[0].provider;
					modelId = matches[0].id;
				} else {
					modelId = configuredModel;
				}
			}
		}

		const thinking = config.inference.suggesterThinking === "session-default"
			? pi.getThinkingLevel()
			: config.inference.suggesterThinking;
		const providerCount = new Set(ctx.modelRegistry.getAll().map((model) => model.provider)).size;
		const modelLabel = providerCount > 1 ? `(${provider}) ${modelId}` : modelId;
		const thinkingLabel = thinking === "off" ? "thinking off" : thinking;
		return `${modelLabel} • ${thinkingLabel}`;
	};
	const eventLog = new NdjsonEventLog(path.join(cwd, ".pi", "suggester", "logs", "events.ndjson"));
	const logger = new ConsoleLogger(config.logging.level, {
		getContext: () => runtimeRef.getContext(),
		statusKey: "suggester-events",
		mirrorToConsoleWhenNoUi: false,
		eventLog,
		setWidgetLogStatus: (status) => {
			runtimeRef.setPanelLogStatus(status);
			refreshSuggesterUi({
				getContext: () => runtimeRef.getContext(),
				getEpoch: () => runtimeRef.getEpoch(),
				getSuggestion: () => runtimeRef.getSuggestion(),
				setSuggestion: (text) => runtimeRef.setSuggestion(text),
				getPanelSuggestionStatus: () => runtimeRef.getPanelSuggestionStatus(),
				setPanelSuggestionStatus: (text) => runtimeRef.setPanelSuggestionStatus(text),
				getPanelLogStatus: () => runtimeRef.getPanelLogStatus(),
				setPanelLogStatus: (next) => runtimeRef.setPanelLogStatus(next),
				getSuggesterModelDisplay,
				prefillOnlyWhenEditorEmpty: config.suggestion.prefillOnlyWhenEditorEmpty,
			});
		},
	});
	const taskQueue = new InMemoryTaskQueue();
	const vcs = new GitClient(cwd);
	const fileHash = new Sha256FileHash();
	const seedStore = new JsonSeedStore(path.join(cwd, ".pi", "suggester", "seed.json"));
	const stateStore = new SessionStateStore(cwd, () => runtimeRef.getContext()?.sessionManager);
	const modelClient = new PiModelClient(runtimeRef, logger, cwd);
	const clock = new SystemClock();
	const suggestionSink = new PiSuggestionSink({
		getContext: () => runtimeRef.getContext(),
		getEpoch: () => runtimeRef.getEpoch(),
		getSuggestion: () => runtimeRef.getSuggestion(),
		setSuggestion: (text) => runtimeRef.setSuggestion(text),
		getPanelSuggestionStatus: () => runtimeRef.getPanelSuggestionStatus(),
		setPanelSuggestionStatus: (text) => runtimeRef.setPanelSuggestionStatus(text),
		getPanelLogStatus: () => runtimeRef.getPanelLogStatus(),
		setPanelLogStatus: (status) => runtimeRef.setPanelLogStatus(status),
		getSuggesterModelDisplay,
		prefillOnlyWhenEditorEmpty: config.suggestion.prefillOnlyWhenEditorEmpty,
	});

	const stalenessChecker = new StalenessChecker({
		config,
		fileHash,
		vcs,
		cwd,
	});

	const promptContextBuilder = new PromptContextBuilder(config);
	const suggestionEngine = new SuggestionEngine({
		config,
		modelClient,
		promptContextBuilder,
	});
	const steeringClassifier = new SteeringClassifier(config);

	const reseedRunner = new ReseedRunner({
		config,
		seedStore,
		stateStore,
		modelClient,
		taskQueue,
		logger,
		fileHash,
		vcs,
		cwd,
	});

	const sessionStart = new SessionStartOrchestrator({
		seedStore,
		stateStore,
		stalenessChecker,
		reseedRunner,
		suggestionSink,
		logger,
		checkForStaleness: config.reseed.checkOnSessionStart,
	});

	const agentEnd = new TurnEndOrchestrator({
		config,
		seedStore,
		stateStore,
		stalenessChecker,
		reseedRunner,
		suggestionEngine,
		suggestionSink,
		logger,
		checkForStaleness: config.reseed.checkAfterEveryTurn,
	});

	const userSubmit = new UserSubmitOrchestrator({
		stateStore,
		steeringClassifier,
		clock,
		logger,
		suggestionSink,
		historyWindow: config.steering.historyWindow,
	});

	return {
		config,
		runtimeRef,
		stores: {
			seedStore,
			stateStore,
		},
		eventLog,
		orchestrators: {
			sessionStart,
			agentEnd,
			userSubmit,
			reseedRunner,
		},
	};
}
