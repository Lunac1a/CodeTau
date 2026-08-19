import { ToolRegistry } from "../tools/registry.ts";
import type { AgentEvent, ToolCall, ToolResult } from "../types.ts";

function validationOutput(result: ToolResult): {
    commandIndex: number;
    passed: boolean;
} | undefined {
    if (!result.ok || typeof result.output !== "object" || result.output === null) {
        return undefined;
    }
    const commandIndex = Reflect.get(result.output, "commandIndex");
    const passed = Reflect.get(result.output, "passed");
    if (!Number.isInteger(commandIndex) || typeof passed !== "boolean") {
        return undefined;
    }
    return { commandIndex: commandIndex as number, passed };
}

export class ValidationTracker {
    private readonly passedCommands = new Set<number>();
    private failedAttemptsValue = 0;
    private readonly commandCount: number;
    private readonly toolRegistry: ToolRegistry;

    constructor(
        commandCount: number,
        toolRegistry: ToolRegistry,
    ) {
        this.commandCount = commandCount;
        this.toolRegistry = toolRegistry;
    }

    static fromEvents(
        events: readonly AgentEvent[],
        commandCount: number,
        toolRegistry: ToolRegistry,
    ): ValidationTracker {
        const tracker = new ValidationTracker(commandCount, toolRegistry);
        const calls = new Map<string, ToolCall>();
        for (const event of events) {
            if (event.type === "model_tool_call") {
                calls.set(event.toolCall.id, event.toolCall);
            } else if (event.type === "tool_result") {
                const call = calls.get(event.toolCallId);
                if (call !== undefined) {
                    tracker.record(call, event.result);
                }
            }
        }
        return tracker;
    }

    record(call: ToolCall, result: ToolResult): void {
        const tool = this.toolRegistry.get(call.name);
        if (result.ok && tool?.permission.risk === "write") {
            this.passedCommands.clear();
        }

        if (call.name !== "run_validation") {
            return;
        }
        const output = validationOutput(result);
        if (
            output === undefined ||
            output.commandIndex < 0 ||
            output.commandIndex >= this.commandCount
        ) {
            return;
        }
        if (output.passed) {
            this.passedCommands.add(output.commandIndex);
        } else {
            this.passedCommands.delete(output.commandIndex);
            this.failedAttemptsValue += 1;
        }
    }

    isComplete(): boolean {
        return (
            this.commandCount > 0 && this.passedCommands.size === this.commandCount
        );
    }

    get failedAttempts(): number {
        return this.failedAttemptsValue;
    }

    passedCommandIndexes(): readonly number[] {
        return [...this.passedCommands].sort((left, right) => left - right);
    }
}
