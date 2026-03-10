import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TurnContext, TurnStatus } from "../../domain/suggestion.js";

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block && typeof block === "object") {
				if ("type" in block && (block as { type?: string }).type === "text" && "text" in block) {
					return String((block as { text?: unknown }).text ?? "");
				}
			}
			return "";
		})
		.join("\n")
		.trim();
}

function extractToolSignals(messages: AgentMessage[]): { toolSignals: string[]; touchedFiles: string[] } {
	const toolSignals: string[] = [];
	const touchedFiles = new Set<string>();

	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const pathValue = typeof args.path === "string" ? args.path : undefined;
					const fileValue = typeof args.file === "string" ? args.file : undefined;
					const patternValue = typeof args.pattern === "string" ? args.pattern : undefined;
					const commandValue = typeof args.command === "string" ? args.command : undefined;
					const target = pathValue ?? fileValue ?? patternValue ?? commandValue;
					toolSignals.push(`${block.name}${target ? `(${target})` : ""}`);
					if (pathValue) touchedFiles.add(pathValue.replace(/^@/, ""));
					if (fileValue) touchedFiles.add(fileValue.replace(/^@/, ""));
				}
			}
		}
		if (message.role === "toolResult" && message.isError) {
			toolSignals.push(`${message.toolName}:error`);
		}
	}

	return { toolSignals, touchedFiles: Array.from(touchedFiles) };
}

function extractUnresolvedQuestions(text: string): string[] {
	return text
		.split(/\n+/)
		.map((line) => line.trim())
		.filter((line) => line.endsWith("?"))
		.slice(0, 6);
}

export function buildTurnContext(params: {
	turnId: string;
	sourceLeafId: string;
	messagesFromPrompt: AgentMessage[];
	branchMessages: AgentMessage[];
	occurredAt: string;
}): TurnContext | null {
	const latestAssistant = [...params.messagesFromPrompt].reverse().find((message) => message.role === "assistant");
	if (!latestAssistant || latestAssistant.role !== "assistant") return null;

	const assistantText = textFromContent(latestAssistant.content);
	const status: TurnStatus = latestAssistant.stopReason === "error"
		? "error"
		: latestAssistant.stopReason === "aborted"
			? "aborted"
			: "success";
	const recentUserPrompts = [...params.branchMessages]
		.reverse()
		.filter((message) => message.role === "user")
		.slice(0, 6)
		.map((message) => textFromContent(message.content))
		.filter(Boolean);
	const { toolSignals, touchedFiles } = extractToolSignals(params.messagesFromPrompt);
	return {
		turnId: params.turnId,
		sourceLeafId: params.sourceLeafId,
		assistantText,
		status,
		occurredAt: params.occurredAt,
		recentUserPrompts,
		toolSignals,
		touchedFiles,
		unresolvedQuestions: extractUnresolvedQuestions(assistantText),
		abortContextNote:
			status === "aborted"
				? "The previous agent turn ended with stopReason=aborted. The user likely interrupted execution and wants a better next instruction."
				: undefined,
	};
}

export function extractUserText(message: AgentMessage): string {
	return textFromContent((message as { content?: unknown }).content ?? "");
}
