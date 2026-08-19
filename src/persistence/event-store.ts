import type { AgentEvent } from "../types.ts";

export interface EventStore {
    append(event: AgentEvent): Promise<void>;
    loadSession(sessionId: string): Promise<readonly AgentEvent[]>;
    close(): Promise<void>;
}

export type EventStoreFactory = () => EventStore | Promise<EventStore>;
