import type { EventStore } from "../../src/persistence/event-store.ts";
import type { AgentEvent } from "../../src/types.ts";

export class ObservedEventStore implements EventStore {
    private readonly delegate: EventStore;
    private readonly observer: (event: AgentEvent) => void;

    constructor(
        delegate: EventStore,
        observer: (event: AgentEvent) => void,
    ) {
        this.delegate = delegate;
        this.observer = observer;
    }

    async append(event: AgentEvent): Promise<void> {
        await this.delegate.append(event);
        this.notify(event);
    }

    async appendMany(events: readonly AgentEvent[]): Promise<void> {
        await this.delegate.appendMany(events);
        for (const event of events) {
            this.notify(event);
        }
    }

    loadSession(sessionId: string) {
        return this.delegate.loadSession(sessionId);
    }

    loadTaskState(sessionId: string) {
        return this.delegate.loadTaskState(sessionId);
    }

    close(): Promise<void> {
        return this.delegate.close();
    }

    private notify(event: AgentEvent): void {
        try {
            this.observer(event);
        } catch {
            // Terminal rendering must never invalidate a persisted Agent event.
        }
    }
}
