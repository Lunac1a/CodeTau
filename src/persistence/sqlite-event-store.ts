import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { EventReplayError, rebuildTaskState } from "../events.ts";
import type { AgentEvent } from "../types.ts";
import type { EventStore } from "./event-store.ts";
import { EventStoreError } from "./errors.ts";

type EventRow = {
    payload_json: string;
};

type CountRow = {
    count: number;
};

export class SQLiteEventStore implements EventStore {
    readonly #database: DatabaseSync;
    #closed = false;

    constructor(databasePath: string) {
        if (databasePath !== ":memory:") {
            const absolutePath = resolve(databasePath);
            mkdirSync(dirname(absolutePath), { recursive: true });
            databasePath = absolutePath;
        }

        try {
            this.#database = new DatabaseSync(databasePath);
            this.#configure();
            this.#migrate();
        } catch (error) {
            throw new EventStoreError({
                code: "event_store_failure",
                message: `Unable to open SQLite EventStore: ${databasePath}`,
                cause: error,
            });
        }
    }

    async append(event: AgentEvent): Promise<void> {
        this.#assertOpen();

        try {
            this.#database.exec("BEGIN IMMEDIATE");

            if (this.#eventIdExists(event.id)) {
                throw new EventStoreError({
                    code: "event_id_conflict",
                    message: `Event id already exists: ${event.id}`,
                    event,
                });
            }

            const currentEvents = this.#loadSessionUnchecked(event.sessionId);
            const expectedSequence = currentEvents.length + 1;
            if (event.sequence !== expectedSequence) {
                throw new EventStoreError({
                    code: "event_sequence_conflict",
                    message: `Expected sequence ${expectedSequence} for session ${event.sessionId}, received ${event.sequence}`,
                    event,
                });
            }

            try {
                rebuildTaskState([...currentEvents, event]);
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

            if (currentEvents.length === 0) {
                if (event.type !== "session_started") {
                    throw new EventStoreError({
                        code: "event_stream_invalid",
                        message: "The first persisted event must be session_started",
                        event,
                    });
                }

                this.#database
                    .prepare(
                        `INSERT INTO sessions (
                            session_id, spec_id, spec_path, spec_digest,
                            spec_snapshot_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        event.sessionId,
                        event.specId,
                        event.specPath,
                        event.specDigest,
                        JSON.stringify(event.specSnapshot),
                        event.timestamp,
                    );
            }

            this.#database
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

            this.#database.exec("COMMIT");
        } catch (error) {
            this.#rollbackQuietly();

            if (error instanceof EventStoreError) {
                throw error;
            }

            throw new EventStoreError({
                code: "event_store_failure",
                message: `Unable to append event ${event.id}`,
                event,
                cause: error,
            });
        }
    }

    async loadSession(sessionId: string): Promise<readonly AgentEvent[]> {
        this.#assertOpen();
        return this.#loadSessionUnchecked(sessionId);
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }

        this.#database.close();
        this.#closed = true;
    }

    #configure(): void {
        this.#database.exec("PRAGMA foreign_keys = ON");
        this.#database.exec("PRAGMA journal_mode = WAL");
        this.#database.exec("PRAGMA synchronous = FULL");
        this.#database.exec("PRAGMA busy_timeout = 5000");
    }

    #migrate(): void {
        this.#database.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                spec_id TEXT NOT NULL,
                spec_path TEXT NOT NULL,
                spec_digest TEXT NOT NULL,
                spec_snapshot_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            ) STRICT;

            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL CHECK (sequence >= 1),
                event_type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id),
                UNIQUE (session_id, sequence)
            ) STRICT;

            CREATE INDEX IF NOT EXISTS events_session_sequence_idx
                ON events(session_id, sequence);
        `);
    }

    #eventIdExists(eventId: string): boolean {
        const row = this.#database
            .prepare("SELECT COUNT(*) AS count FROM events WHERE event_id = ?")
            .get(eventId) as CountRow;
        return row.count > 0;
    }

    #loadSessionUnchecked(sessionId: string): AgentEvent[] {
        const rows = this.#database
            .prepare(
                `SELECT payload_json
                 FROM events
                 WHERE session_id = ?
                 ORDER BY sequence ASC`,
            )
            .all(sessionId) as EventRow[];

        if (rows.length === 0) {
            return [];
        }

        let events: AgentEvent[];
        try {
            events = rows.map((row) => JSON.parse(row.payload_json) as AgentEvent);
            rebuildTaskState(events);
        } catch (error) {
            throw new EventStoreError({
                code: "event_storage_corrupt",
                message: `Stored event stream is invalid for session ${sessionId}`,
                cause: error,
            });
        }

        return events;
    }

    #rollbackQuietly(): void {
        try {
            this.#database.exec("ROLLBACK");
        } catch {
            // No active transaction, or the database is no longer available.
        }
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
