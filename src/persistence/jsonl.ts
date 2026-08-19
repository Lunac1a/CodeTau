import { EventValidationError, validateAgentEvent } from "../event-validation.ts";
import { EventReplayError, rebuildTaskState, type TaskState } from "../events.ts";
import type { AgentEvent } from "../types.ts";
import type { EventStore } from "./event-store.ts";

export type EventJsonlErrorCode =
    | "jsonl_empty"
    | "jsonl_parse_invalid"
    | "jsonl_event_invalid"
    | "jsonl_stream_invalid"
    | "jsonl_session_missing";

export class EventJsonlError extends Error {
    readonly code: EventJsonlErrorCode;
    readonly line?: number;
    declare readonly cause?: unknown;

    constructor(options: {
        code: EventJsonlErrorCode;
        message: string;
        line?: number;
        cause?: unknown;
    }) {
        super(options.message, { cause: options.cause });
        this.name = "EventJsonlError";
        this.code = options.code;
        this.line = options.line;
    }
}

export type ReplayedEventJsonl = Readonly<{
    sessionId: string;
    eventCount: number;
    events: readonly AgentEvent[];
    state: TaskState;
}>;

export function replayEventJsonl(jsonl: string): ReplayedEventJsonl {
    const events: AgentEvent[] = [];
    const sourceLines: number[] = [];

    for (const [index, sourceLine] of jsonl.split(/\r?\n/u).entries()) {
        if (sourceLine.trim() === "") {
            continue;
        }

        const line = index + 1;
        let value: unknown;
        try {
            value = JSON.parse(sourceLine);
        } catch (error) {
            throw new EventJsonlError({
                code: "jsonl_parse_invalid",
                message: `Line ${line} is not valid JSON`,
                line,
                cause: error,
            });
        }

        try {
            events.push(structuredClone(validateAgentEvent(value)));
            sourceLines.push(line);
        } catch (error) {
            if (error instanceof EventValidationError) {
                throw new EventJsonlError({
                    code: "jsonl_event_invalid",
                    message: `Line ${line} is not a valid AgentEvent: ${error.message}`,
                    line,
                    cause: error,
                });
            }
            throw error;
        }
    }

    if (events.length === 0) {
        throw new EventJsonlError({
            code: "jsonl_empty",
            message: "JSONL does not contain any events",
        });
    }

    let state: TaskState;
    try {
        state = rebuildTaskState(events);
    } catch (error) {
        if (error instanceof EventReplayError) {
            const eventIndex = events.findIndex(
                (event) =>
                    event.id === error.eventId && event.sequence === error.sequence,
            );
            throw new EventJsonlError({
                code: "jsonl_stream_invalid",
                message: `JSONL event stream cannot be replayed: ${error.message}`,
                line: eventIndex < 0 ? undefined : sourceLines[eventIndex],
                cause: error,
            });
        }
        throw error;
    }

    return Object.freeze({
        sessionId: state.sessionId,
        eventCount: events.length,
        events: Object.freeze(events),
        state,
    });
}

export async function exportSessionJsonl(
    eventStore: EventStore,
    sessionId: string,
): Promise<string> {
    const events = await eventStore.loadSession(sessionId);
    if (events.length === 0) {
        throw new EventJsonlError({
            code: "jsonl_session_missing",
            message: `Session does not exist: ${sessionId}`,
        });
    }

    rebuildTaskState(events);
    return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export async function importSessionJsonl(
    eventStore: EventStore,
    jsonl: string,
): Promise<TaskState> {
    const replay = replayEventJsonl(jsonl);
    await eventStore.appendMany(replay.events);

    const persistedState = await eventStore.loadTaskState(replay.sessionId);
    if (persistedState === undefined) {
        throw new EventJsonlError({
            code: "jsonl_stream_invalid",
            message: `Imported session could not be restored: ${replay.sessionId}`,
        });
    }
    return persistedState;
}
