import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventStore } from "../src/persistence/in-memory-event-store.ts";
import {
    EventJsonlError,
    exportSessionJsonl,
    importSessionJsonl,
    replayEventJsonl,
} from "../src/persistence/jsonl.ts";
import { EventStoreError } from "../src/persistence/errors.ts";
import type { AgentEvent } from "../src/types.ts";
import { createSessionStartedEvent, createTestSpec } from "./fixtures/spec.ts";

function jsonlEvents(options: {
    sessionId?: string;
    firstEventId?: string;
    secondEventId?: string;
} = {}): AgentEvent[] {
    const sessionId = options.sessionId ?? "session-jsonl";
    const start = createSessionStartedEvent({
        eventId: options.firstEventId ?? "jsonl-event-1",
        sessionId,
        spec: createTestSpec({ id: `spec.${sessionId}` }),
        timestamp: "2026-08-19T00:00:00.000Z",
    });
    return [
        start,
        {
            id: options.secondEventId ?? "jsonl-event-2",
            sessionId,
            sequence: 2,
            timestamp: "2026-08-19T00:00:01.000Z",
            type: "state_changed",
            from: "created",
            to: "analyzing",
            reason: "The imported Spec is ready.",
            sourceEventId: start.id,
        },
    ];
}

test("exports, replays, and imports the same event stream", async () => {
    const source = new InMemoryEventStore();
    const destination = new InMemoryEventStore();
    const events = jsonlEvents();

    try {
        await source.appendMany(events);
        const beforeReplay = await source.loadTaskState("session-jsonl");
        const jsonl = await exportSessionJsonl(source, "session-jsonl");
        const replay = replayEventJsonl(jsonl);
        const importedState = await importSessionJsonl(destination, jsonl);

        assert.equal(jsonl.endsWith("\n"), true);
        assert.deepEqual(replay.events, events);
        assert.deepEqual(replay.state, beforeReplay);
        assert.deepEqual(importedState, beforeReplay);
        assert.deepEqual(await source.loadTaskState("session-jsonl"), beforeReplay);
        assert.deepEqual(await destination.loadSession("session-jsonl"), events);
    } finally {
        await source.close();
        await destination.close();
    }
});

test("reports the exact line containing malformed JSON", () => {
    const firstLine = JSON.stringify(jsonlEvents()[0]);

    assert.throws(
        () => replayEventJsonl(`${firstLine}\n{broken}\n`),
        (error: unknown) => {
            assert.ok(error instanceof EventJsonlError);
            assert.equal(error.code, "jsonl_parse_invalid");
            assert.equal(error.line, 2);
            return true;
        },
    );
});

test("JSONL import is atomic when an event id conflicts", async () => {
    const destination = new InMemoryEventStore();
    const existing = jsonlEvents({
        sessionId: "session-existing",
        firstEventId: "jsonl-event-2",
        secondEventId: "existing-event-2",
    })[0];
    const importedEvents = jsonlEvents();
    const jsonl = `${importedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;

    try {
        await destination.append(existing);
        await assert.rejects(
            importSessionJsonl(destination, jsonl),
            (error: unknown) => {
                assert.ok(error instanceof EventStoreError);
                assert.equal(error.code, "event_id_conflict");
                return true;
            },
        );
        assert.deepEqual(await destination.loadSession("session-jsonl"), []);
    } finally {
        await destination.close();
    }
});
