import { buildTurnContext } from "../../app/services/conversation-signals.js";
async function safeguard(label, fn) {
    try {
        return await fn();
    }
    catch (error) {
        console.error(`[pi-prompt-suggester] ${label} failed:`, (error instanceof Error) ? error.message : error);
        return undefined;
    }
}
async function handleSessionEvent(ctx, handler) {
    await safeguard("session-event", () => handler(ctx));
}
function extractRecentUserPrompts(branchMessages) {
    return [...branchMessages]
        .reverse()
        .filter((message) => typeof message === "object" && message !== null && "role" in message && message.role === "user")
        .map((message) => {
        if (typeof message.content === "string")
            return message.content;
        if (!Array.isArray(message.content))
            return "";
        return message.content
            .map((block) => {
            if (block && typeof block === "object" && "type" in block && block.type === "text") {
                return String(block.text ?? "");
            }
            return "";
        })
            .join("\n");
    })
        .map((text) => text.trim())
        .filter(Boolean);
}
function buildAbortedFallbackTurn(sourceLeafId, branchMessages) {
    return {
        turnId: sourceLeafId,
        sourceLeafId,
        assistantText: "[aborted]",
        assistantUsage: undefined,
        status: "aborted",
        occurredAt: new Date().toISOString(),
        recentUserPrompts: extractRecentUserPrompts(branchMessages),
        toolSignals: [],
        touchedFiles: [],
        unresolvedQuestions: [],
        abortContextNote: "The user explicitly aborted the previous agent turn. Suggest a clear next prompt that either resumes intentionally or redirects the work.",
    };
}
export class PiExtensionAdapter {
    pi;
    wiring;
    constructor(pi, wiring) {
        this.pi = pi;
        this.wiring = wiring;
    }
    register() {
        this.pi.on("session_start", async (_event, ctx) => {
            await handleSessionEvent(ctx, this.wiring.onSessionStart);
        });
        this.pi.on("session_tree", async (_event, ctx) => {
            await handleSessionEvent(ctx, this.wiring.onSessionStart);
        });
        this.pi.on("session_fork", async (_event, ctx) => {
            await handleSessionEvent(ctx, this.wiring.onSessionStart);
        });
        this.pi.on("session_switch", async (_event, ctx) => {
            await handleSessionEvent(ctx, this.wiring.onSessionStart);
        });
        this.pi.on("agent_end", async (event, ctx) => {
            await safeguard("agent-end", async () => {
                const branchEntries = ctx.sessionManager.getBranch();
                const branchMessages = branchEntries
                    .filter((entry) => entry.type === "message")
                    .map((entry) => entry.message);
                const sourceLeafId = ctx.sessionManager.getLeafId() ?? `turn-${Date.now()}`;
                const turn = buildTurnContext({
                    turnId: sourceLeafId,
                    sourceLeafId,
                    messagesFromPrompt: event.messages,
                    branchMessages,
                    occurredAt: new Date().toISOString(),
                });
                if (turn) {
                    await this.wiring.onAgentEnd(turn, ctx);
                    return;
                }
                if (event.messages.length === 0) {
                    await this.wiring.onAgentEnd(buildAbortedFallbackTurn(sourceLeafId, branchMessages), ctx);
                }
            });
        });
        this.pi.on("input", async (event, ctx) => {
            await safeguard("input", async () => {
                await this.wiring.onUserSubmit(event, ctx);
            });
            return { action: "continue" };
        });
        this.pi.registerCommand("suggesterSettings", {
            description: "Interactive suggester settings menu",
            handler: async (_args, ctx) => {
                await this.wiring.onSettingsUiCommand(ctx);
            },
        });
        this.pi.registerCommand("suggester", {
            description: "suggester controls: status | reseed | model | thinking | instruction | variant | ab | config | seed-trace | help",
            getArgumentCompletions: (argumentPrefix) => {
                return this.getSuggesterCompletions(argumentPrefix);
            },
            handler: async (args, ctx) => {
                const trimmed = args.trim();
                const [subcommand, ...rest] = trimmed.length > 0 ? trimmed.split(/\s+/) : ["status"];
                if (subcommand === "reseed") {
                    await this.wiring.onReseedCommand(ctx);
                    return;
                }
                if (subcommand === "model") {
                    await this.wiring.onModelCommand(rest.join(" "), ctx);
                    return;
                }
                if (subcommand === "thinking") {
                    await this.wiring.onThinkingCommand(rest.join(" "), ctx);
                    return;
                }
                if (subcommand === "config") {
                    await this.wiring.onConfigCommand(rest.join(" "), ctx);
                    return;
                }
                if (subcommand === "instruction") {
                    await this.wiring.onInstructionCommand(rest.join(" "), ctx);
                    return;
                }
                if (subcommand === "variant") {
                    await this.wiring.onVariantCommand(rest.join(" "), ctx);
                    return;
                }
                if (subcommand === "ab") {
                    await this.wiring.onAbCommand(rest.join(" "), ctx);
                    return;
                }
                if (subcommand === "seed-trace") {
                    await this.wiring.onSeedTraceCommand(rest.join(" "), ctx);
                    return;
                }
                if (subcommand === "help") {
                    this.pi.sendMessage({
                        customType: "prompt-suggester-help",
                        content: [
                            "## /suggester commands",
                            "",
                            "- `/suggester` or `/suggester status` -- current state",
                            "- `/suggester reseed` -- refresh project intent",
                            "- `/suggester model [show|set|clear] <seeder|suggester> <ref>` -- model overrides",
                            "- `/suggester thinking [show|set|clear] <seeder|suggester> <level>` -- thinking overrides",
                            "- `/suggester instruction [show|set|clear] [project|user]` -- custom instruction",
                            "- `/suggester config [show|set|reset] [project|user] <path> <value>` -- raw config",
                            "- `/suggester variant` -- A/B variant editor",
                            "- `/suggester ab` -- A/B comparison",
                            "- `/suggester seed-trace [limit]` -- seeder event log",
                            "- `/suggesterSettings` -- interactive settings menu",
                        ].join("\n"),
                        display: true,
                    }, { triggerTurn: false });
                    return;
                }
                await this.wiring.onStatusCommand(ctx);
            },
        });
    }
    getSuggesterCompletions(argumentPrefix) {
        const trimmed = argumentPrefix.trimStart();
        // First level: subcommands
        if (!trimmed.includes(" ")) {
            const subcommands = [
                { value: "status", label: "status", description: "Show current state" },
                { value: "reseed", label: "reseed", description: "Refresh project intent" },
                { value: "model", label: "model", description: "Model overrides (show|set|clear)" },
                { value: "thinking", label: "thinking", description: "Thinking level (show|set|clear)" },
                { value: "instruction", label: "instruction", description: "Custom instruction (show|set|clear)" },
                { value: "config", label: "config", description: "Raw config (show|set|reset)" },
                { value: "variant", label: "variant", description: "A/B variant editor" },
                { value: "ab", label: "ab", description: "A/B comparison" },
                { value: "seed-trace", label: "seed-trace", description: "Seeder event log" },
                { value: "help", label: "help", description: "Print usage" },
            ];
            const matches = subcommands.filter((item) => item.value.startsWith(trimmed));
            return matches.length > 0 ? matches : null;
        }
        const spaceIndex = trimmed.indexOf(" ");
        const subcommand = trimmed.slice(0, spaceIndex);
        const rest = trimmed.slice(spaceIndex + 1).trimStart();
        // Second level: subcommand-specific args
        if (subcommand === "model" || subcommand === "thinking") {
            if (!rest.includes(" ")) {
                const actions = [
                    { value: "show", label: "show", description: "Show current setting" },
                    { value: "set", label: "set", description: "Set override" },
                    { value: "clear", label: "clear", description: "Remove override" },
                ];
                const matches = actions.filter((item) => item.value.startsWith(rest));
                return matches.length > 0 ? matches : null;
            }
            const actionSpaceIndex = rest.indexOf(" ");
            const action = rest.slice(0, actionSpaceIndex);
            const rolePrefix = rest.slice(actionSpaceIndex + 1).trimStart();
            if ((action === "set" || action === "clear") && !rolePrefix.includes(" ")) {
                const roles = [
                    { value: "seeder", label: "seeder", description: "Seeder model/thinking" },
                    { value: "suggester", label: "suggester", description: "Suggester model/thinking" },
                ];
                const matches = roles.filter((item) => item.value.startsWith(rolePrefix));
                return matches.length > 0 ? matches : null;
            }
            // Third level for thinking: level values
            if (subcommand === "thinking" && action === "set") {
                const levelPrefix = rolePrefix.slice(rolePrefix.indexOf(" ") + 1).trimStart();
                if (rolePrefix.includes(" ")) {
                    const levels = [
                        { value: "minimal", label: "minimal" },
                        { value: "low", label: "low" },
                        { value: "medium", label: "medium" },
                        { value: "high", label: "high" },
                        { value: "xhigh", label: "xhigh" },
                        { value: "session-default", label: "session-default", description: "Use session thinking level" },
                    ];
                    const matches = levels.filter((item) => item.value.startsWith(levelPrefix));
                    return matches.length > 0 ? matches : null;
                }
            }
        }
        if (subcommand === "instruction") {
            if (!rest.includes(" ")) {
                const actions = [
                    { value: "show", label: "show", description: "Show current instruction" },
                    { value: "set", label: "set", description: "Edit instruction" },
                    { value: "clear", label: "clear", description: "Remove instruction" },
                ];
                const matches = actions.filter((item) => item.value.startsWith(rest));
                return matches.length > 0 ? matches : null;
            }
            const actionSpaceIndex = rest.indexOf(" ");
            const action = rest.slice(0, actionSpaceIndex);
            const scopePrefix = rest.slice(actionSpaceIndex + 1).trimStart();
            if ((action === "set" || action === "clear") && !scopePrefix.includes(" ")) {
                const scopes = [
                    { value: "project", label: "project", description: "Project-level override" },
                    { value: "user", label: "user", description: "User-level override" },
                ];
                const matches = scopes.filter((item) => item.value.startsWith(scopePrefix));
                return matches.length > 0 ? matches : null;
            }
        }
        if (subcommand === "config") {
            if (!rest.includes(" ")) {
                const actions = [
                    { value: "show", label: "show", description: "Show current config" },
                    { value: "set", label: "set", description: "Set config value" },
                    { value: "reset", label: "reset", description: "Reset to defaults" },
                ];
                const matches = actions.filter((item) => item.value.startsWith(rest));
                return matches.length > 0 ? matches : null;
            }
            const actionSpaceIndex = rest.indexOf(" ");
            const action = rest.slice(0, actionSpaceIndex);
            const scopePrefix = rest.slice(actionSpaceIndex + 1).trimStart();
            if ((action === "set" || action === "reset") && !scopePrefix.includes(" ")) {
                const scopes = [
                    { value: "project", label: "project", description: "Project-level override" },
                    { value: "user", label: "user", description: "User-level override" },
                    ...(action === "reset" ? [{ value: "all", label: "all", description: "Reset both scopes" }] : []),
                ];
                const matches = scopes.filter((item) => item.value.startsWith(scopePrefix));
                return matches.length > 0 ? matches : null;
            }
        }
        return null;
    }
}
