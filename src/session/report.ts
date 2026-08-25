import type { TaskState } from "../events.ts";
import type { AgentEvent, ToolCall } from "../types.ts";

export type SessionReport = Readonly<{
    sessionId: string;
    status: TaskState["status"];
    message?: string;
    changedFiles: readonly string[];
    passedValidationIndexes: readonly number[];
    validationCount: number;
    modelTurns: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
}>;

function outputRecord(event: Extract<AgentEvent, { type: "tool_result" }>):
    | Record<string, unknown>
    | undefined {
    return event.result.ok &&
        typeof event.result.output === "object" &&
        event.result.output !== null
        ? (event.result.output as Record<string, unknown>)
        : undefined;
}

export function buildSessionReport(
    state: TaskState,
    events: readonly AgentEvent[],
): SessionReport {
    const started = events[0]?.type === "session_started" ? events[0] : undefined;
    const validationCount =
        started?.specSnapshot.contract.acceptance.commands.length ?? 0;
    const calls = new Map<string, ToolCall>();
    const changedFiles = new Set<string>();
    const passedValidationIndexes = new Set<number>();
    let modelTurns = 0;
    let toolCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    for (const event of events) {
        if (event.type === "model_tool_call") {
            calls.set(event.toolCall.id, event.toolCall);
            toolCalls += 1;
            if (event.usage !== undefined) {
                modelTurns += 1;
                inputTokens += event.usage.inputTokens;
                outputTokens += event.usage.outputTokens;
            }
        } else if (event.type === "model_text" || event.type === "model_finish") {
            modelTurns += 1;
            inputTokens += event.usage.inputTokens;
            outputTokens += event.usage.outputTokens;
        } else if (event.type === "tool_result") {
            const call = calls.get(event.toolCallId);
            const output = outputRecord(event);
            if (
                output !== undefined &&
                (call?.name === "apply_patch" || call?.name === "create_file")
            ) {
                const path = output.path;
                if (typeof path === "string") {
                    changedFiles.add(path);
                }
                passedValidationIndexes.clear();
            } else if (output !== undefined && call?.name === "run_validation") {
                const index = output.commandIndex;
                const passed = output.passed;
                if (Number.isInteger(index) && typeof passed === "boolean") {
                    if (passed) {
                        passedValidationIndexes.add(index as number);
                    } else {
                        passedValidationIndexes.delete(index as number);
                    }
                }
            }
        }
    }

    return {
        sessionId: state.sessionId,
        status: state.status,
        message: state.final?.message,
        changedFiles: [...changedFiles].sort(),
        passedValidationIndexes: [...passedValidationIndexes].sort(
            (left, right) => left - right,
        ),
        validationCount,
        modelTurns,
        toolCalls,
        inputTokens,
        outputTokens,
    };
}
