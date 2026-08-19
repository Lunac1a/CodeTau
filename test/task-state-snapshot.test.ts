import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { rebuildTaskState } from "../src/events.ts";
import { EventStoreError } from "../src/persistence/errors.ts";
import { SQLiteEventStore } from "../src/persistence/sqlite-event-store.ts";
import type { AgentEvent } from "../src/types.ts";
import { createSessionStartedEvent, createTestSpec } from "./fixtures/spec.ts";

function snapshotEvents(): AgentEvent[] {
    const sessionId = "session-snapshot";
    const start = createSessionStartedEvent({
        eventId: "snapshot-event-1",
        sessionId,
        spec: createTestSpec({ id: "spec.snapshot" }),
        timestamp: "2026-08-19T00:00:00.000Z",
    });
    return [
        start,
        {
            id: "snapshot-event-2",
            sessionId,
            sequence: 2,
            timestamp: "2026-08-19T00:00:01.000Z",
            type: "state_changed",
            from: "created",
            to: "analyzing",
            reason: "The Spec is ready for analysis.",
            sourceEventId: start.id,
        },
    ];
}

test("SQLite snapshot matches a full event replay after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-snapshot-"));
    const databasePath = join(directory, "events.db");
    const events = snapshotEvents();

    try {
        const store = new SQLiteEventStore(databasePath);
        await store.appendMany(events);
        await store.close();

        const reopenedStore = new SQLiteEventStore(databasePath);
        try {
            assert.deepEqual(
                await reopenedStore.loadTaskState("session-snapshot"),
                rebuildTaskState(events),
            );
        } finally {
            await reopenedStore.close();
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("SQLite rejects a TaskState snapshot that disagrees with event replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-bad-snapshot-"));
    const databasePath = join(directory, "events.db");
    const events = snapshotEvents();

    try {
        const store = new SQLiteEventStore(databasePath);
        await store.appendMany(events);
        await store.close();

        const database = new DatabaseSync(databasePath);
        database
            .prepare(
                "UPDATE task_state_snapshots SET state_json = ? WHERE session_id = ?",
            )
            .run(
                JSON.stringify({ ...rebuildTaskState(events), status: "completed" }),
                "session-snapshot",
            );
        database.close();

        const reopenedStore = new SQLiteEventStore(databasePath);
        try {
            await assert.rejects(
                reopenedStore.loadTaskState("session-snapshot"),
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

test("SQLite upgrades an earlier database and backfills its Spec and state snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-legacy-snapshot-"));
    const databasePath = join(directory, "events.db");
    const events = snapshotEvents();
    const start = events[0];
    assert.equal(start.type, "session_started");

    try {
        const legacyDatabase = new DatabaseSync(databasePath);
        legacyDatabase.exec(`
            CREATE TABLE sessions (
                session_id TEXT PRIMARY KEY,
                spec_id TEXT NOT NULL,
                spec_path TEXT NOT NULL,
                created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE events (
                event_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id),
                UNIQUE (session_id, sequence)
            ) STRICT;
        `);
        legacyDatabase
            .prepare(
                `INSERT INTO sessions (
                    session_id, spec_id, spec_path, created_at
                ) VALUES (?, ?, ?, ?)`,
            )
            .run(start.sessionId, start.specId, start.specPath, start.timestamp);
        for (const event of events) {
            legacyDatabase
                .prepare(
                    `INSERT INTO events (
                        event_id, session_id, sequence, event_type, timestamp, payload_json
                    ) VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    event.id,
                    event.sessionId,
                    event.sequence,
                    event.type,
                    event.timestamp,
                    JSON.stringify(event),
                );
        }
        legacyDatabase.close();

        const upgradedStore = new SQLiteEventStore(databasePath);
        try {
            assert.deepEqual(
                await upgradedStore.loadTaskState("session-snapshot"),
                rebuildTaskState(events),
            );
        } finally {
            await upgradedStore.close();
        }

        const upgradedDatabase = new DatabaseSync(databasePath);
        const metadata = upgradedDatabase
            .prepare(
                `SELECT spec_digest, spec_snapshot_json
                 FROM sessions
                 WHERE session_id = ?`,
            )
            .get("session-snapshot") as {
                spec_digest: string;
                spec_snapshot_json: string;
            };
        const snapshotCount = upgradedDatabase
            .prepare(
                `SELECT COUNT(*) AS count
                 FROM task_state_snapshots
                 WHERE session_id = ?`,
            )
            .get("session-snapshot") as { count: number };
        upgradedDatabase.close();

        assert.equal(metadata.spec_digest, start.specDigest);
        assert.deepEqual(JSON.parse(metadata.spec_snapshot_json), start.specSnapshot);
        assert.equal(snapshotCount.count, 1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
