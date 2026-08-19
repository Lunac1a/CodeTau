import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebuildTaskState } from "../src/events.ts";
import { SQLiteEventStore } from "../src/persistence/sqlite-event-store.ts";
import type { AgentEvent } from "../src/types.ts";
import { runEventStoreContract } from "./contracts/event-store-contract.ts";

runEventStoreContract("SQLiteEventStore", () => new SQLiteEventStore(":memory:"));

test("SQLiteEventStore: restores a session after reopening the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-sqlite-"));
    const databasePath = join(directory, "events.db");
    const events: AgentEvent[] = [
        {
            id: "event-1",
            sessionId: "session-persisted",
            sequence: 1,
            timestamp: "2026-08-19T00:00:00.000Z",
            type: "session_started",
            specId: "spec.persisted",
            specPath: "specs/persisted.md",
        },
        {
            id: "event-2",
            sessionId: "session-persisted",
            sequence: 2,
            timestamp: "2026-08-19T00:00:01.000Z",
            type: "state_changed",
            from: "created",
            to: "analyzing",
            reason: "The persisted session started analysis.",
            sourceEventId: "event-1",
        },
    ];

    try {
        const firstStore = new SQLiteEventStore(databasePath);
        await firstStore.append(events[0]);
        await firstStore.append(events[1]);
        await firstStore.close();

        const reopenedStore = new SQLiteEventStore(databasePath);
        try {
            const restoredEvents = await reopenedStore.loadSession("session-persisted");
            assert.deepEqual(restoredEvents, events);
            assert.equal(rebuildTaskState(restoredEvents).status, "analyzing");
        } finally {
            await reopenedStore.close();
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
