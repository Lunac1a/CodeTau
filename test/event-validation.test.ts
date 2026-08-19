import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
    EventValidationError,
    validateAgentEvent,
} from "../src/event-validation.ts";
import { InMemoryEventStore } from "../src/persistence/in-memory-event-store.ts";
import { EventStoreError } from "../src/persistence/errors.ts";
import { SQLiteEventStore } from "../src/persistence/sqlite-event-store.ts";
import type { AgentEvent } from "../src/types.ts";
import { createSessionStartedEvent, createTestSpec } from "./fixtures/spec.ts";

function sessionStartedEvent(): Extract<AgentEvent, { type: "session_started" }> {
    return createSessionStartedEvent({
        eventId: "event-1",
        sessionId: "session-validation",
        spec: createTestSpec(),
        timestamp: "2026-08-19T00:00:00.000Z",
    });
}

test("accepts a valid AgentEvent", () => {
    const event = sessionStartedEvent();
    assert.equal(validateAgentEvent(event), event);
});

test("reports missing and unknown event fields", () => {
    const event = sessionStartedEvent() as Record<string, unknown>;
    delete event.specId;
    event.unexpected = true;

    assert.throws(
        () => validateAgentEvent(event),
        (error: unknown) => {
            assert.ok(error instanceof EventValidationError);
            assert.ok(error.issues.some((issue) => issue.path === "/specId"));
            assert.ok(error.issues.some((issue) => issue.path === "/unexpected"));
            return true;
        },
    );
});

test("rejects values that JSON cannot preserve", () => {
    const event = {
        id: "event-2",
        sessionId: "session-validation",
        sequence: 2,
        timestamp: "2026-08-19T00:00:01.000Z",
        type: "model_tool_call",
        toolCall: {
            id: "call-1",
            name: "read_file",
            input: { offset: 1n },
        },
    };

    assert.throws(
        () => validateAgentEvent(event),
        (error: unknown) => {
            assert.ok(error instanceof EventValidationError);
            assert.equal(error.issues[0]?.path, "/toolCall/input/offset");
            assert.equal(error.issues[0]?.keyword, "jsonType");
            return true;
        },
    );
});

test("rejects circular event data", () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    const event = {
        id: "event-2",
        sessionId: "session-validation",
        sequence: 2,
        timestamp: "2026-08-19T00:00:01.000Z",
        type: "model_tool_call",
        toolCall: { id: "call-1", name: "read_file", input },
    };

    assert.throws(
        () => validateAgentEvent(event),
        (error: unknown) => {
            assert.ok(error instanceof EventValidationError);
            assert.equal(error.issues[0]?.keyword, "jsonCycle");
            return true;
        },
    );
});

test("EventStore rejects malformed data without a partial write", async () => {
    const store = new InMemoryEventStore();
    const malformed = { ...sessionStartedEvent(), sequence: 1.5 } as AgentEvent;

    try {
        await assert.rejects(
            store.append(malformed),
            (error: unknown) => {
                assert.ok(error instanceof EventStoreError);
                assert.equal(error.code, "event_schema_invalid");
                return true;
            },
        );
        assert.deepEqual(await store.loadSession(malformed.sessionId), []);
    } finally {
        await store.close();
    }
});

test("SQLiteEventStore detects a corrupted stored event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-corrupt-event-"));
    const databasePath = join(directory, "events.db");
    const event = sessionStartedEvent();

    try {
        const store = new SQLiteEventStore(databasePath);
        await store.append(event);
        await store.close();

        const database = new DatabaseSync(databasePath);
        database
            .prepare("UPDATE events SET payload_json = ? WHERE event_id = ?")
            .run('{"type":"session_started"}', event.id);
        database.close();

        const reopenedStore = new SQLiteEventStore(databasePath);
        try {
            await assert.rejects(
                reopenedStore.loadSession(event.sessionId),
                (error: unknown) => {
                    assert.ok(error instanceof EventStoreError);
                    assert.equal(error.code, "event_storage_corrupt");
                    return true;
                },
            );
        } finally {
            await reopenedStore.close();
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
