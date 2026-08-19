import { EventValidationError, validateAgentEvent } from "../event-validation.ts";
import { EventReplayError, rebuildTaskState, type TaskState } from "../events.ts";
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
        await this.appendMany([event]);
    }

    async appendMany(events: readonly AgentEvent[]): Promise<void> {
        this.#assertOpen();

        const candidateSessions = new Map(this.#sessions);
        const candidateEventIds = new Set(this.#eventIds);

        for (const inputEvent of events) {
            try {
                validateAgentEvent(inputEvent);
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

            const event = cloneEvent(inputEvent);
            if (candidateEventIds.has(event.id)) {
                throw new EventStoreError({
                    code: "event_id_conflict",
                    message: `Event id already exists: ${event.id}`,
                    event,
                });
            }

            const currentEvents = candidateSessions.get(event.sessionId) ?? [];
            const expectedSequence = currentEvents.length + 1;
            if (event.sequence !== expectedSequence) {
                throw new EventStoreError({
                    code: "event_sequence_conflict",
                    message: `Expected sequence ${expectedSequence} for session ${event.sessionId}, received ${event.sequence}`,
                    event,
                });
            }

            const candidateEvents = [...currentEvents, event];

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

            candidateSessions.set(event.sessionId, candidateEvents);
            candidateEventIds.add(event.id);
        }

        this.#sessions.clear();
        for (const [sessionId, sessionEvents] of candidateSessions) {
            this.#sessions.set(sessionId, sessionEvents);
        }
        this.#eventIds.clear();
        for (const eventId of candidateEventIds) {
            this.#eventIds.add(eventId);
        }
    }

    async loadSession(sessionId: string): Promise<readonly AgentEvent[]> {
        this.#assertOpen();
        return (this.#sessions.get(sessionId) ?? []).map(cloneEvent);
    }

    async loadTaskState(sessionId: string): Promise<TaskState | undefined> {
        this.#assertOpen();
        const events = this.#sessions.get(sessionId) ?? [];
        return events.length === 0 ? undefined : rebuildTaskState(events);
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
