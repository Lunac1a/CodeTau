import assert from "node:assert/strict";
import test from "node:test";

import { rebuildTaskState } from "../../src/events.ts";
import type { EventStoreFactory } from "../../src/persistence/event-store.ts";
import { EventStoreError } from "../../src/persistence/errors.ts";
import type { AgentEvent } from "../../src/types.ts";
import { createSessionStartedEvent, createTestSpec } from "../fixtures/spec.ts";

const timestamp = "2026-08-19T00:00:00.000Z";

function startEvent(sessionId: string, eventId: string): AgentEvent {
    const spec = createTestSpec({
        id: `spec.${sessionId}`,
        sourcePath: `specs/${sessionId}.md`,
    });
    return createSessionStartedEvent({
        eventId,
        sessionId,
        spec,
        timestamp,
    });
}

function analyzingEvent(sessionId: string, eventId: string, sourceId: string): AgentEvent {
    return {
        id: eventId,
        sessionId,
        sequence: 2,
        timestamp,
        type: "state_changed",
        from: "created",
        to: "analyzing",
        reason: "The validated Spec is ready.",
        sourceEventId: sourceId,
    };
}

function expectStoreError(
    code: EventStoreError["code"],
): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.ok(error instanceof EventStoreError);
        assert.equal(error.code, code);
        return true;
    };
}

export function runEventStoreContract(
    implementationName: string,
    createStore: EventStoreFactory,
): void {
    test(`${implementationName}: appends and loads a replayable session`, async () => {
        const store = await createStore();
        try {
            await store.append(startEvent("session-a", "event-a1"));
            await store.append(analyzingEvent("session-a", "event-a2", "event-a1"));

            const events = await store.loadSession("session-a");
            assert.equal(events.length, 2);
            assert.equal(rebuildTaskState(events).status, "analyzing");
        } finally {
            await store.close();
        }
    });

    test(`${implementationName}: keeps sessions isolated`, async () => {
        const store = await createStore();
        try {
            await store.append(startEvent("session-a", "event-a1"));
            await store.append(startEvent("session-b", "event-b1"));

            assert.deepEqual(
                (await store.loadSession("session-a")).map((event) => event.id),
                ["event-a1"],
            );
            assert.deepEqual(
                (await store.loadSession("session-b")).map((event) => event.id),
                ["event-b1"],
            );
        } finally {
            await store.close();
        }
    });

    test(`${implementationName}: rejects a sequence gap without partial writes`, async () => {
        const store = await createStore();
        try {
            await store.append(startEvent("session-a", "event-a1"));
            const gapEvent = {
                ...analyzingEvent("session-a", "event-a3", "event-a1"),
                sequence: 3,
            };

            await assert.rejects(
                store.append(gapEvent),
                expectStoreError("event_sequence_conflict"),
            );
            assert.deepEqual(
                (await store.loadSession("session-a")).map((event) => event.id),
                ["event-a1"],
            );
        } finally {
            await store.close();
        }
    });

    test(`${implementationName}: rejects duplicate event ids across sessions`, async () => {
        const store = await createStore();
        try {
            await store.append(startEvent("session-a", "shared-event"));

            await assert.rejects(
                store.append(startEvent("session-b", "shared-event")),
                expectStoreError("event_id_conflict"),
            );
        } finally {
            await store.close();
        }
    });

    test(`${implementationName}: rejects an invalid first event`, async () => {
        const store = await createStore();
        try {
            const invalidFirstEvent = {
                ...analyzingEvent("session-a", "event-a1", "missing"),
                sequence: 1,
            };
            await assert.rejects(
                store.append(invalidFirstEvent),
                expectStoreError("event_stream_invalid"),
            );
            assert.deepEqual(await store.loadSession("session-a"), []);
        } finally {
            await store.close();
        }
    });

    test(`${implementationName}: protects stored data from caller mutation`, async () => {
        const store = await createStore();
        try {
            const input = startEvent("session-a", "event-a1");
            await store.append(input);

            (input as { specPath: string }).specPath = "changed-before-load.md";
            const firstRead = await store.loadSession("session-a");
            assert.equal(
                (firstRead[0] as Extract<AgentEvent, { type: "session_started" }>).specPath,
                "specs/session-a.md",
            );

            (firstRead[0] as { id: string }).id = "changed-after-load";
            const secondRead = await store.loadSession("session-a");
            assert.equal(secondRead[0].id, "event-a1");
        } finally {
            await store.close();
        }
    });

    test(`${implementationName}: rejects operations after close`, async () => {
        const store = await createStore();
        await store.close();

        await assert.rejects(
            store.loadSession("session-a"),
            expectStoreError("event_store_closed"),
        );
    });
}
