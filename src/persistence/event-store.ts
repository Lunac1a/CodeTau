import type { AgentEvent } from "../types.ts";
import type { TaskState } from "../events.ts";

export interface EventStore {
    append(event: AgentEvent): Promise<void>;
    appendMany(events: readonly AgentEvent[]): Promise<void>;
    loadSession(sessionId: string): Promise<readonly AgentEvent[]>;
    loadTaskState(sessionId: string): Promise<TaskState | undefined>;
    close(): Promise<void>;
}

export type EventStoreFactory = () => EventStore | Promise<EventStore>;
