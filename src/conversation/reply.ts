import type { ModelProvider } from "../model.ts";
import type { SessionReport } from "../session/report.ts";
import type { AgentEvent } from "../types.ts";
import type { ConversationTurn } from "./store.ts";

const MAX_HISTORY_CHARACTERS = 16_000;
const MAX_EVIDENCE_CHARACTERS = 16_000;

function bounded(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;
}

//TODO: Context Management
export function conversationHistoryContext(
    turns: readonly ConversationTurn[],
    currentMessage: string,
): string {
    const history = turns
        .filter((turn) => turn.assistantMessage !== undefined)
        .slice(-8)
        .map((turn) =>
            turn.status === "completed"
                ? `User: ${turn.userMessage}\nAssistant: ${turn.assistantMessage}`
                : `User: ${turn.userMessage}\nAssistant: [${turn.status} turn; unverified response omitted]`,
        )
        .join("\n\n");
    return bounded(
        [
            "This coding task is one turn in a persistent terminal conversation.",
            history === "" ? "No earlier completed turns." : `Earlier turns:\n${history}`,
            `Current user request:\n${currentMessage}`,
            "Treat the current request as an addition or correction to the earlier turns. Inspect current files instead of assuming earlier edits remain unchanged.",
        ].join("\n\n"),
        MAX_HISTORY_CHARACTERS,
    );
}

function executionEvidence(events: readonly AgentEvent[]): string {
    const calls = new Map<string, string>();
    const lines: string[] = [];
    for (const event of events) {
        if (event.type === "model_tool_call") {
            calls.set(event.toolCall.id, event.toolCall.name);
        } else if (event.type === "tool_result") {
            const name = calls.get(event.toolCallId) ?? "tool";
            lines.push(`${name}: ${JSON.stringify(event.result)}`);
        }
    }
    return bounded(lines.join("\n"), MAX_EVIDENCE_CHARACTERS);
}

export function fallbackConversationReply(report: SessionReport): string {
    const files =
        report.changedFiles.length === 0
            ? "No files were changed."
            : `Changed: ${report.changedFiles.join(", ")}.`;
    return `${report.status}: ${report.message ?? "The turn ended."} ${files} Validation ${report.passedValidationIndexes.length}/${report.validationCount}.`;
}

export async function generateConversationReply(options: {
    model: ModelProvider;
    userMessage: string;
    turns: readonly ConversationTurn[];
    report: SessionReport;
    events: readonly AgentEvent[];
}): Promise<string> {
    const validationComplete =
        options.report.validationCount > 0 &&
        options.report.passedValidationIndexes.length ===
            options.report.validationCount;
    if (options.report.status !== "completed" || !validationComplete) {
        return fallbackConversationReply(options.report);
    }

    const history = conversationHistoryContext(options.turns, options.userMessage);
    const evidence = executionEvidence(options.events);
    const response = await options.model.generate({
        messages: [
            {
                role: "system",
                content: [
                    "You are the conversational response layer for CodeTau CLI.",
                    "Answer the user's latest message using only the supplied conversation and execution evidence.",
                    "State what was delivered, answer direct questions, and mention failed or missing validation plainly.",
                    "The structured Turn status, changed files, validation count, runtime message, and tool results are authoritative. Model prose from the execution is intentionally excluded.",
                    "Be concise. Do not claim a file changed or a check passed unless the evidence says so.",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    history,
                    `Turn status: ${options.report.status}`,
                    `Changed files: ${options.report.changedFiles.join(", ") || "none"}`,
                    `Validation: ${options.report.passedValidationIndexes.length}/${options.report.validationCount}`,
                    `Runtime message: ${options.report.message ?? "none"}`,
                    `Execution evidence:\n${evidence || "No detailed event evidence."}`,
                ].join("\n\n"),
            },
        ],
        availableTools: [],
        includeFinishTool: false,
    });
    return response.kind === "text" && response.text.trim() !== ""
        ? response.text.trim()
        : fallbackConversationReply(options.report);
}
