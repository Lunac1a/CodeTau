import { EventValidationError, validateAgentEvent } from "../event-validation.ts";
import { EventReplayError, rebuildTaskState } from "../events.ts";
import type { AgentEvent } from "../types.ts";
import type { EventStore } from "./event-store.ts";
import { EventStoreError } from "./errors.ts";

function cloneEvent(event: AgentEvent): AgentEvent {
    return structuredClone(event);
}

export class InMemoryEventStore implements EventStore {
    readonly #sessions = new Map<string, AgentEvent[]>();
    readonly #eventIds = new Set<string>();
    #closed = false;

    async append(event: AgentEvent): Promise<void> {
        this.#assertOpen();

        try {
            validateAgentEvent(event);
        } catch (error) {
            if (error instanceof EventValidationError) {
                throw new EventStoreError({
                    code: "event_schema_invalid",
                    message: error.message,
                    cause: error,
                });
            }
            throw error;
        }

        if (this.#eventIds.has(event.id)) {
            throw new EventStoreError({
                code: "event_id_conflict",
                message: `Event id already exists: ${event.id}`,
                event,
            });
        }

        const currentEvents = this.#sessions.get(event.sessionId) ?? [];
        const expectedSequence = currentEvents.length + 1;
        if (event.sequence !== expectedSequence) {
            throw new EventStoreError({
                code: "event_sequence_conflict",
                message: `Expected sequence ${expectedSequence} for session ${event.sessionId}, received ${event.sequence}`,
                event,
            });
        }

        const storedEvent = cloneEvent(event);
        const candidateEvents = [...currentEvents, storedEvent];

        try {
            rebuildTaskState(candidateEvents);
        } catch (error) {
            if (error instanceof EventReplayError) {
                throw new EventStoreError({
                    code: "event_stream_invalid",
                    message: `Event would make session ${event.sessionId} invalid: ${error.message}`,
                    event,
                    cause: error,
                });
            }
            throw error;
        }

        this.#sessions.set(event.sessionId, candidateEvents);
        this.#eventIds.add(event.id);
    }

    async loadSession(sessionId: string): Promise<readonly AgentEvent[]> {
        this.#assertOpen();
        return (this.#sessions.get(sessionId) ?? []).map(cloneEvent);
    }

    async close(): Promise<void> {
        this.#closed = true;
        this.#sessions.clear();
        this.#eventIds.clear();
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new EventStoreError({
                code: "event_store_closed",
                message: "EventStore is closed",
            });
        }
    }
}
