import { randomUUID } from "node:crypto";

import { rebuildTaskState, type TaskState, type TerminalStatus } from "../events.ts";
import type { ModelMessage, ModelProvider } from "../model.ts";
import type { EventStore } from "../persistence/event-store.ts";
import type { LoadedSpec } from "../spec/types.ts";
import type {
    AgentEvent,
    EventBase,
    ModelResponse,
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

function buildInitialMessages(spec: LoadedSpec): ModelMessage[] {
    return [
        {
            role: "system",
            content: [
                `Task ID: ${spec.contract.id}`,
                `Goal: ${spec.contract.goal}`,
                "Current state: analyzing",
                "No tools are available in this minimal loop.",
                "A completed outcome requires external validation and will not be accepted yet.",
            ].join("\n"),
        },
        {
            role: "user",
            content: spec.context,
        },
    ];
}

function rebuildMessages(spec: LoadedSpec, events: readonly AgentEvent[]): ModelMessage[] {
    const messages = buildInitialMessages(spec);

    for (const event of events) {
        if (event.type === "model_text") {
            messages.push({ role: "assistant", content: event.text });
        }
    }

    return messages;
}

function countModelTurns(events: readonly AgentEvent[]): number {
    return events.filter(
        (event) =>
            event.type === "model_text" ||
            event.type === "model_finish" ||
            event.type === "model_error",
    ).length;
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
    initialModelTurns: number;
}): Promise<TaskState> {
    const { spec, model, writer, messages } = options;
    let modelTurns = options.initialModelTurns;

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
                availableToolNames: [],
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

        let sourceEventId: string | undefined;
        for (const toolCall of response.calls) {
            const toolEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_tool_call",
                toolCall,
            });
            sourceEventId = toolEvent.id;
        }

        if (sourceEventId === undefined) {
            const errorEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_error",
                error: {
                    code: "empty_tool_calls",
                    message: "The model returned an empty tool call list.",
                },
            });
            sourceEventId = errorEvent.id;
        }

        return writer.finalize(
            "failed",
            "Tool calls are not supported by the minimal Agent loop.",
            sourceEventId,
            "The model requested tools before a ToolRegistry was available.",
        );
    }
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<TaskState> {
    const runtime = options.runtime ?? defaultRuntime;
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
        messages: buildInitialMessages(options.spec),
        initialModelTurns: 0,
    });
}

export async function resumeAgentLoop(options: RunAgentLoopOptions): Promise<TaskState> {
    const runtime = options.runtime ?? defaultRuntime;
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
    } else if (lastEvent.type === "model_tool_call") {
        return writer.finalize(
            "failed",
            "Tool calls are not supported by the minimal Agent loop.",
            lastEvent.id,
            "The recovered session was waiting for an unavailable ToolRegistry.",
        );
    }

    return continueModelLoop({
        spec: options.spec,
        model: options.model,
        writer,
        messages: rebuildMessages(options.spec, events),
        initialModelTurns: countModelTurns(events),
    });
}
