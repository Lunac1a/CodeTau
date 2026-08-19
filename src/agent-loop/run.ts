import { randomUUID } from "node:crypto";

import { rebuildTaskState, type TaskState, type TerminalStatus } from "../events.ts";
import type { ModelMessage, ModelProvider } from "../model.ts";
import { PermissionPolicy } from "../permissions/policy.ts";
import type { EventStore } from "../persistence/event-store.ts";
import type { LoadedSpec } from "../spec/types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type {
    AgentEvent,
    EventBase,
    ModelResponse,
    ToolCall,
    ToolResult,
    TaskStatus,
} from "../types.ts";
import { AgentLoopError } from "./errors.ts";

export type AgentLoopRuntime = {
    nextEventId(): string;
    now(): string;
};

export type RunAgentLoopOptions = {
    sessionId: string;
    spec: LoadedSpec;
    model: ModelProvider;
    eventStore: EventStore;
    toolRegistry?: ToolRegistry;
    permissionPolicy?: PermissionPolicy;
    runtime?: AgentLoopRuntime;
};

type EventWriter = {
    append(event: AgentEvent): Promise<AgentEvent>;
    nextBase(): EventBase;
    changeState(
        to: TaskStatus,
        reason: string,
        sourceEventId: string,
    ): Promise<AgentEvent>;
    finalize(
        status: TerminalStatus,
        message: string,
        sourceEventId: string,
        reason: string,
    ): Promise<TaskState>;
    appendFinal(status: TerminalStatus, message: string): Promise<TaskState>;
};

const defaultRuntime: AgentLoopRuntime = {
    nextEventId: randomUUID,
    now: () => new Date().toISOString(),
};

function buildInitialMessages(
    spec: LoadedSpec,
    availableToolNames: readonly string[],
): ModelMessage[] {
    const toolDescription =
        availableToolNames.length === 0
            ? "No tools are available in this minimal loop."
            : `Available tools: ${availableToolNames.join(", ")}`;
    return [
        {
            role: "system",
            content: [
                `Task ID: ${spec.contract.id}`,
                `Goal: ${spec.contract.goal}`,
                "Current state: analyzing",
                toolDescription,
                "A completed outcome requires external validation and will not be accepted yet.",
            ].join("\n"),
        },
        {
            role: "user",
            content: spec.context,
        },
    ];
}

function rebuildMessages(
    spec: LoadedSpec,
    events: readonly AgentEvent[],
    availableToolNames: readonly string[],
): ModelMessage[] {
    const messages = buildInitialMessages(spec, availableToolNames);

    for (const event of events) {
        if (event.type === "model_text") {
            messages.push({ role: "assistant", content: event.text });
        } else if (event.type === "tool_result") {
            messages.push({
                role: "tool",
                toolCallId: event.toolCallId,
                content: serializeToolResult(event.result),
            });
        }
    }

    return messages;
}

function countModelTurns(events: readonly AgentEvent[]): number {
    return events.filter(
        (event) =>
            event.type === "model_text" ||
            event.type === "model_tool_call" ||
            event.type === "model_finish" ||
            event.type === "model_error",
    ).length;
}

function countToolCalls(events: readonly AgentEvent[]): number {
    return events.filter((event) => event.type === "model_tool_call").length;
}

function serializeToolResult(result: ToolResult): string {
    return JSON.stringify(result);
}

function safeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown model provider error";
}

function createEventWriter(options: {
    sessionId: string;
    eventStore: EventStore;
    runtime: AgentLoopRuntime;
    initialSequence: number;
    initialStatus: TaskStatus;
}): EventWriter {
    const { sessionId, eventStore, runtime } = options;
    let sequence = options.initialSequence;
    let status = options.initialStatus;

    function nextBase(): EventBase {
        sequence += 1;
        return {
            id: runtime.nextEventId(),
            sessionId,
            sequence,
            timestamp: runtime.now(),
        };
    }

    async function append(event: AgentEvent): Promise<AgentEvent> {
        await eventStore.append(event);
        return event;
    }

    async function changeState(
        to: TaskStatus,
        reason: string,
        sourceEventId: string,
    ): Promise<AgentEvent> {
        const event: AgentEvent = {
            ...nextBase(),
            type: "state_changed",
            from: status,
            to,
            reason,
            sourceEventId,
        };
        await append(event);
        status = to;
        return event;
    }

    async function appendFinal(
        terminalStatus: TerminalStatus,
        message: string,
    ): Promise<TaskState> {
        await append({
            ...nextBase(),
            type: "final",
            status: terminalStatus,
            message,
        });
        return rebuildTaskState(await eventStore.loadSession(sessionId));
    }

    async function finalize(
        terminalStatus: TerminalStatus,
        message: string,
        sourceEventId: string,
        reason: string,
    ): Promise<TaskState> {
        await changeState(terminalStatus, reason, sourceEventId);
        return appendFinal(terminalStatus, message);
    }

    return { append, nextBase, changeState, finalize, appendFinal };
}

async function finalizeModelResponse(
    response: Extract<ModelResponse, { kind: "finish" }>,
    finishEventId: string,
    writer: EventWriter,
): Promise<TaskState> {
    if (response.outcome === "completed") {
        return writer.finalize(
            "failed",
            "Model completion was rejected because no validation evidence exists.",
            finishEventId,
            "A completed outcome cannot be accepted before validation.",
        );
    }

    const terminalMessage =
        response.message.trim() === ""
            ? `Model declared the task ${response.outcome}.`
            : response.message;
    return writer.finalize(
        response.outcome,
        terminalMessage,
        finishEventId,
        `The model declared the task ${response.outcome}.`,
    );
}

async function continueModelLoop(options: {
    spec: LoadedSpec;
    model: ModelProvider;
    writer: EventWriter;
    messages: ModelMessage[];
    toolRegistry: ToolRegistry;
    permissionPolicy: PermissionPolicy;
    initialModelTurns: number;
    initialToolCalls: number;
}): Promise<TaskState> {
    const {
        spec,
        model,
        writer,
        messages,
        toolRegistry,
        permissionPolicy,
    } = options;
    let modelTurns = options.initialModelTurns;
    let toolCalls = options.initialToolCalls;

    while (true) {
        if (modelTurns >= spec.contract.budget.maxModelTurns) {
            const budgetEvent = await writer.append({
                ...writer.nextBase(),
                type: "budget_exhausted",
                budget: "model_turns",
                limit: spec.contract.budget.maxModelTurns,
            });
            return writer.finalize(
                "failed",
                "Model turn budget exhausted.",
                budgetEvent.id,
                "The model turn budget was exhausted before a valid terminal outcome.",
            );
        }

        modelTurns += 1;
        let response: ModelResponse;
        try {
            response = await model.generate({
                messages: [...messages],
                availableToolNames: toolRegistry.names(),
            });
        } catch (error) {
            const errorEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_error",
                error: {
                    code: "model_provider_error",
                    message: safeErrorMessage(error),
                },
            });
            return writer.finalize(
                "failed",
                "The model provider failed.",
                errorEvent.id,
                "The model provider returned an error.",
            );
        }

        if (response.kind === "text") {
            await writer.append({
                ...writer.nextBase(),
                type: "model_text",
                text: response.text,
                usage: response.usage,
            });
            messages.push({ role: "assistant", content: response.text });
            continue;
        }

        if (response.kind === "finish") {
            const finishEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_finish",
                outcome: response.outcome,
                message: response.message,
                usage: response.usage,
            });
            return finalizeModelResponse(response, finishEvent.id, writer);
        }

        if (response.calls.length === 0) {
            const errorEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_error",
                error: {
                    code: "empty_tool_calls",
                    message: "The model returned an empty tool call list.",
                },
            });
            return writer.finalize(
                "failed",
                "The model returned an empty tool call list.",
                errorEvent.id,
                "An empty tool call response cannot advance the task.",
            );
        }

        for (const toolCall of response.calls) {
            if (toolCalls >= spec.contract.budget.maxToolCalls) {
                const budgetEvent = await writer.append({
                    ...writer.nextBase(),
                    type: "budget_exhausted",
                    budget: "tool_calls",
                    limit: spec.contract.budget.maxToolCalls,
                });
                return writer.finalize(
                    "failed",
                    "Tool call budget exhausted.",
                    budgetEvent.id,
                    "The tool call budget was exhausted before validation.",
                );
            }

            await writer.append({
                ...writer.nextBase(),
                type: "model_tool_call",
                toolCall,
            });
            toolCalls += 1;
            const result = await executeToolCall(
                toolCall,
                toolRegistry,
                permissionPolicy,
            );
            await writer.append({
                ...writer.nextBase(),
                type: "tool_result",
                toolCallId: toolCall.id,
                result,
            });
            messages.push({
                role: "tool",
                toolCallId: toolCall.id,
                content: serializeToolResult(result),
            });
        }
    }
}

async function executeToolCall(
    call: ToolCall,
    toolRegistry: ToolRegistry,
    permissionPolicy: PermissionPolicy,
): Promise<ToolResult> {
    const tool = toolRegistry.get(call.name);
    if (tool === undefined) {
        return toolRegistry.execute(call);
    }

    const decision = permissionPolicy.evaluate(tool.permission);
    if (decision.kind === "deny") {
        return {
            ok: false,
            error: {
                code: decision.code,
                message: decision.message,
            },
        };
    }
    if (decision.kind === "approval_required") {
        return {
            ok: false,
            error: {
                code: "approval_required",
                message: `Tool requires approval before execution: ${call.name}`,
                details: { allowedResponses: decision.allowedResponses },
            },
        };
    }

    return toolRegistry.execute(call);
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<TaskState> {
    const runtime = options.runtime ?? defaultRuntime;
    const toolRegistry = options.toolRegistry ?? new ToolRegistry();
    const permissionPolicy =
        options.permissionPolicy ?? new PermissionPolicy(options.spec.contract);
    const existingEvents = await options.eventStore.loadSession(options.sessionId);

    if (existingEvents.length > 0) {
        throw new AgentLoopError({
            code: "session_already_exists",
            message: `Session already exists: ${options.sessionId}`,
            sessionId: options.sessionId,
        });
    }

    const writer = createEventWriter({
        sessionId: options.sessionId,
        eventStore: options.eventStore,
        runtime,
        initialSequence: 0,
        initialStatus: "created",
    });
    const startedEvent = await writer.append({
        ...writer.nextBase(),
        type: "session_started",
        specId: options.spec.contract.id,
        specPath: options.spec.sourcePath,
        specDigest: options.spec.digest,
        specSnapshot: {
            contract: options.spec.contract,
            context: options.spec.context,
        },
    });
    await writer.changeState(
        "analyzing",
        "The Spec was loaded and validated.",
        startedEvent.id,
    );

    return continueModelLoop({
        spec: options.spec,
        model: options.model,
        writer,
        messages: buildInitialMessages(options.spec, toolRegistry.names()),
        toolRegistry,
        permissionPolicy,
        initialModelTurns: 0,
        initialToolCalls: 0,
    });
}

export async function resumeAgentLoop(options: RunAgentLoopOptions): Promise<TaskState> {
    const runtime = options.runtime ?? defaultRuntime;
    const toolRegistry = options.toolRegistry ?? new ToolRegistry();
    const permissionPolicy =
        options.permissionPolicy ?? new PermissionPolicy(options.spec.contract);
    const events = await options.eventStore.loadSession(options.sessionId);

    if (events.length === 0) {
        throw new AgentLoopError({
            code: "session_not_found",
            message: `Session does not exist: ${options.sessionId}`,
            sessionId: options.sessionId,
        });
    }

    const state = rebuildTaskState(events);
    if (
        state.specId !== options.spec.contract.id ||
        state.specDigest !== options.spec.digest
    ) {
        throw new AgentLoopError({
            code: "session_spec_mismatch",
            message: `Session ${options.sessionId} was created from a different Spec`,
            sessionId: options.sessionId,
        });
    }

    if (state.final !== undefined) {
        throw new AgentLoopError({
            code: "session_terminal",
            message: `Session is already final: ${options.sessionId}`,
            sessionId: options.sessionId,
        });
    }

    const writer = createEventWriter({
        sessionId: options.sessionId,
        eventStore: options.eventStore,
        runtime,
        initialSequence: state.lastSequence,
        initialStatus: state.status,
    });
    const lastEvent = events.at(-1) as AgentEvent;

    if (
        state.status === "completed" ||
        state.status === "failed" ||
        state.status === "blocked"
    ) {
        const transition = lastEvent.type === "state_changed" ? lastEvent : undefined;
        const message = transition
            ? `Recovered ${state.status} state: ${transition.reason}`
            : `Recovered terminal state: ${state.status}`;
        return writer.appendFinal(state.status, message);
    }

    if (state.status === "created") {
        await writer.changeState(
            "analyzing",
            "The session resumed after its validated Spec was recorded.",
            lastEvent.id,
        );
    } else if (state.status !== "analyzing") {
        throw new AgentLoopError({
            code: "session_state_unsupported",
            message: `The minimal loop cannot resume state: ${state.status}`,
            sessionId: options.sessionId,
        });
    } else if (lastEvent.type === "model_finish") {
        return finalizeModelResponse(
            {
                kind: "finish",
                outcome: lastEvent.outcome,
                message: lastEvent.message,
                usage: lastEvent.usage,
            },
            lastEvent.id,
            writer,
        );
    } else if (lastEvent.type === "model_error") {
        return writer.finalize(
            "failed",
            "The model provider failed.",
            lastEvent.id,
            "The recovered model provider call had failed.",
        );
    } else if (lastEvent.type === "budget_exhausted") {
        return writer.finalize(
            "failed",
            "Model turn budget exhausted.",
            lastEvent.id,
            "The recovered session had exhausted its model turn budget.",
        );
    }

    const messages = rebuildMessages(options.spec, events, toolRegistry.names());
    if (lastEvent.type === "model_tool_call") {
        const result = await executeToolCall(
            lastEvent.toolCall,
            toolRegistry,
            permissionPolicy,
        );
        await writer.append({
            ...writer.nextBase(),
            type: "tool_result",
            toolCallId: lastEvent.toolCall.id,
            result,
        });
        messages.push({
            role: "tool",
            toolCallId: lastEvent.toolCall.id,
            content: serializeToolResult(result),
        });
    }

    return continueModelLoop({
        spec: options.spec,
        model: options.model,
        writer,
        messages,
        toolRegistry,
        permissionPolicy,
        initialModelTurns: countModelTurns(events),
        initialToolCalls: countToolCalls(events),
    });
}
