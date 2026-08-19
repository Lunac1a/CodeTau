import type { EventReplayError } from "../events.ts";
import type { AgentEvent } from "../types.ts";

export type EventStoreErrorCode =
    | "event_id_conflict"
    | "event_sequence_conflict"
    | "event_stream_invalid"
    | "event_schema_invalid"
    | "event_store_closed"
    | "event_storage_corrupt"
    | "event_store_failure";

export class EventStoreError extends Error {
    readonly code: EventStoreErrorCode;
    readonly eventId?: string;
    readonly sessionId?: string;
    readonly sequence?: number;
    declare readonly cause?: EventReplayError | unknown;

    constructor(options: {
        code: EventStoreErrorCode;
        message: string;
        event?: AgentEvent;
        cause?: EventReplayError | unknown;
    }) {
        super(options.message, { cause: options.cause });
        this.name = "EventStoreError";
        this.code = options.code;
        this.eventId = options.event?.id;
        this.sessionId = options.event?.sessionId;
        this.sequence = options.event?.sequence;
    }
}
