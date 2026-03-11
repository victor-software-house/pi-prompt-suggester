import { promises as fs } from "node:fs";
import path from "node:path";
import type { PromptSuggesterConfig, ThinkingLevel } from "../../config/types.js";
import {
	CURRENT_GENERATOR_VERSION,
	CURRENT_SEED_VERSION,
	SEEDER_PROMPT_VERSION,
	SUGGESTION_PROMPT_VERSION,
	type ReseedTrigger,
	type SeedArtifact,
} from "../../domain/seed.js";
import type { FileHash } from "../ports/file-hash.js";
import type { Logger } from "../ports/logger.js";
import type { SeedStore } from "../ports/seed-store.js";
import type { ModelClient } from "../ports/model-client.js";
import type { TaskQueue } from "../ports/task-queue.js";
import type { VcsClient } from "../ports/vcs-client.js";
import { computeConfigFingerprint } from "../services/seed-metadata.js";

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function createRunId(): string {
	return `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toThinking(value: string): ThinkingLevel | undefined {
	return value === "session-default" ? undefined : (value as ThinkingLevel);
}

export interface ReseedRunnerDeps {
	config: PromptSuggesterConfig;
	seedStore: SeedStore;
	modelClient: ModelClient;
	taskQueue: TaskQueue;
	logger: Logger;
	fileHash: FileHash;
	vcs: VcsClient;
	cwd?: string;
}

export class ReseedRunner {
	private running = false;
	private pendingTrigger: ReseedTrigger | null = null;
	private readonly cwd: string;
	private readonly configFingerprint: string;

	public constructor(private readonly deps: ReseedRunnerDeps) {
		this.cwd = deps.cwd ?? process.cwd();
		this.configFingerprint = computeConfigFingerprint(deps.config);
	}

	public async trigger(trigger: ReseedTrigger): Promise<void> {
		if (!this.deps.config.reseed.enabled) return;
		if (this.running) {
			this.pendingTrigger = this.mergeTriggers(this.pendingTrigger, trigger);
			this.deps.logger.info("reseed.pending", { reason: trigger.reason, changedFiles: trigger.changedFiles });
			return;
		}

		this.running = true;
		void this.deps.taskQueue
			.enqueue("suggester:reseed", async () => {
				await this.processTriggerLoop(trigger);
			})
			.catch((error) => {
				this.deps.logger.error("reseed.queue.failed", {
					error: (error as Error).message,
				});
			})
			.finally(() => {
				this.running = false;
			});
	}

	private async processTriggerLoop(initialTrigger: ReseedTrigger): Promise<void> {
		let nextTrigger: ReseedTrigger | null = initialTrigger;
		while (nextTrigger) {
			const current = nextTrigger;
			nextTrigger = null;
			const runId = createRunId();
			this.deps.logger.info("reseed.started", {
				runId,
				reason: current.reason,
				changedFiles: current.changedFiles,
			});

			try {
				const previousSeed = await this.deps.seedStore.load();
				const seedDraft = await this.deps.modelClient.generateSeed({
					reseedTrigger: current,
					previousSeed,
					settings: {
						modelRef:
							this.deps.config.inference.seederModel === "session-default"
								? undefined
								: this.deps.config.inference.seederModel,
						thinkingLevel: toThinking(this.deps.config.inference.seederThinking),
					},
					runId,
				});
				const seed = await this.finalizeSeed(seedDraft, current);
				await this.deps.seedStore.save(seed);
				this.deps.logger.info("reseed.completed", {
					runId,
					reason: current.reason,
					keyFiles: seed.keyFiles.map((file) => file.path),
					categoryFindings: seed.categoryFindings,
				});
			} catch (error) {
				this.deps.logger.error("reseed.failed", {
					runId,
					reason: current.reason,
					error: (error as Error).message,
				});
			}

			if (this.pendingTrigger) {
				nextTrigger = this.pendingTrigger;
				this.pendingTrigger = null;
			}
		}
	}

	public isRunning(): boolean {
		return this.running;
	}

	private async finalizeSeed(
		seedDraft: Awaited<ReturnType<ModelClient["generateSeed"]>>,
		trigger: ReseedTrigger,
	): Promise<SeedArtifact> {
		const headCommit = await this.deps.vcs.getHeadCommit();
		const keyFiles = await this.resolveKeyFiles(seedDraft.keyFiles);
		return {
			seedVersion: CURRENT_SEED_VERSION,
			generatedAt: new Date().toISOString(),
			sourceCommit: headCommit ?? undefined,
			generatorVersion: CURRENT_GENERATOR_VERSION,
			seederPromptVersion: SEEDER_PROMPT_VERSION,
			suggestionPromptVersion: SUGGESTION_PROMPT_VERSION,
			configFingerprint: this.configFingerprint,
			modelId: undefined,
			projectIntentSummary: seedDraft.projectIntentSummary,
			objectivesSummary: seedDraft.objectivesSummary,
			constraintsSummary: seedDraft.constraintsSummary,
			principlesGuidelinesSummary: seedDraft.principlesGuidelinesSummary,
			implementationStatusSummary: seedDraft.implementationStatusSummary,
			topObjectives: seedDraft.topObjectives,
			constraints: seedDraft.constraints,
			keyFiles,
			categoryFindings: seedDraft.categoryFindings,
			openQuestions: seedDraft.openQuestions,
			reseedNotes: seedDraft.reseedNotes,
			lastReseedReason: trigger.reason,
			lastChangedFiles: trigger.changedFiles,
		};
	}

	private async resolveKeyFiles(
		candidateKeyFiles: Array<{ path: string; whyImportant: string; category: SeedArtifact["keyFiles"][number]["category"] }>,
	): Promise<SeedArtifact["keyFiles"]> {
		const uniqueCandidates = Array.from(
			new Map(
				candidateKeyFiles
					.map((file) => ({
						path: path.normalize(file.path),
						whyImportant: file.whyImportant.trim() || "High-signal repository file",
						category: file.category,
					}))
					.map((file) => [file.path, file]),
			).values(),
		);

		const chosen = uniqueCandidates.slice(0, 32);
		if (chosen.length === 0) {
			throw new Error("Seeder returned no keyFiles. Agentic seeding requires explicit key file selection.");
		}

		const hashed: SeedArtifact["keyFiles"] = [];
		for (const file of chosen) {
			const absolute = path.join(this.cwd, file.path);
			if (!(await fileExists(absolute))) continue;
			hashed.push({
				path: file.path,
				hash: await this.deps.fileHash.hashFile(absolute),
				whyImportant: file.whyImportant,
				category: file.category,
			});
		}
		if (hashed.length === 0) {
			throw new Error("Seeder returned keyFiles, but none could be resolved on disk.");
		}
		return hashed;
	}

	private mergeTriggers(left: ReseedTrigger | null, right: ReseedTrigger): ReseedTrigger {
		if (!left) return right;
		return {
			reason: right.reason,
			changedFiles: Array.from(new Set([...left.changedFiles, ...right.changedFiles])),
			gitDiffSummary: [left.gitDiffSummary, right.gitDiffSummary].filter(Boolean).join("\n\n") || undefined,
		};
	}
}
