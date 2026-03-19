import { buildSessionContext } from "@mariozechner/pi-coding-agent";
function cloneMessages(messages) {
    return JSON.parse(JSON.stringify(messages));
}
export class PiSessionTranscriptProvider {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    getActiveTranscript() {
        const ctx = this.runtime.getContext();
        if (!ctx)
            return undefined;
        const leafId = ctx.sessionManager.getLeafId() ?? undefined;
        const branchEntries = ctx.sessionManager.getBranch(leafId);
        const transcript = buildSessionContext(branchEntries, leafId);
        const systemPrompt = ctx.getSystemPrompt().trim();
        if (!systemPrompt)
            return undefined;
        return {
            systemPrompt,
            messages: cloneMessages(transcript.messages),
            contextUsagePercent: ctx.getContextUsage()?.percent ?? undefined,
            sessionId: ctx.sessionManager.getSessionId(),
        };
    }
}
