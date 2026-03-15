import type { SessionTranscriptProvider } from "../../app/ports/session-transcript.js";
import type { RuntimeContextProvider } from "../model/pi-model-client.js";
import { buildSessionContext, type SessionEntry } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";

function cloneMessages(messages: Message[]): Message[] {
	return JSON.parse(JSON.stringify(messages)) as Message[];
}

export class PiSessionTranscriptProvider implements SessionTranscriptProvider {
	public constructor(private readonly runtime: RuntimeContextProvider) {}

	public getActiveTranscript() {
		const ctx = this.runtime.getContext();
		if (!ctx) return undefined;
		const leafId = ctx.sessionManager.getLeafId() ?? undefined;
		const branchEntries = ctx.sessionManager.getBranch(leafId) as SessionEntry[];
		const transcript = buildSessionContext(branchEntries, leafId);
		const systemPrompt = ctx.getSystemPrompt().trim();
		if (!systemPrompt) return undefined;
		return {
			systemPrompt,
			messages: cloneMessages(transcript.messages as Message[]),
			contextUsagePercent: ctx.getContextUsage()?.percent ?? undefined,
			sessionId: ctx.sessionManager.getSessionId(),
		};
	}
}
