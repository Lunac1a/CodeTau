import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { EventValidationError, validateAgentEvent } from "../event-validation.ts";
import { EventReplayError, rebuildTaskState, type TaskState } from "../events.ts";
import type { AgentEvent } from "../types.ts";
import type { EventStore } from "./event-store.ts";
import { EventStoreError } from "./errors.ts";

type EventRow = {
    payload_json: string;
};

type CountRow = {
    count: number;
};

type SnapshotRow = {
    last_sequence: number;
    state_json: string;
};

type TableInfoRow = {
    name: string;
};

type SessionMetadataRow = {
    session_id: string;
    spec_id: string;
    spec_path: string;
    spec_digest: string | null;
    spec_snapshot_json: string | null;
};

type SessionEvents = {
    events: AgentEvent[];
    state: TaskState;
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

        let database: DatabaseSync | undefined;
        try {
            database = new DatabaseSync(databasePath);
            this.#database = database;
            this.#configure();
            this.#migrate();
        } catch (error) {
            try {
                database?.close();
            } catch {
                // Preserve the original database-open or migration error.
            }
            throw new EventStoreError({
                code: "event_store_failure",
                message: `Unable to open SQLite EventStore: ${databasePath}`,
                cause: error,
            });
        }
    }

    async append(event: AgentEvent): Promise<void> {
        await this.appendMany([event]);
    }

    async appendMany(events: readonly AgentEvent[]): Promise<void> {
        this.#assertOpen();

        for (const event of events) {
            try {
                validateAgentEvent(event);
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
        }

        if (events.length === 0) {
            return;
        }

        try {
            this.#database.exec("BEGIN IMMEDIATE");

            for (const event of events) {
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

                let state: TaskState;
                try {
                    state = rebuildTaskState([...currentEvents, event]);
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

                this.#writeSnapshot(state, event.timestamp);
            }

            this.#database.exec("COMMIT");
        } catch (error) {
            this.#rollbackQuietly();

            if (error instanceof EventStoreError) {
                throw error;
            }

            throw new EventStoreError({
                code: "event_store_failure",
                message: `Unable to append ${events.length} event(s)`,
                event: events[0],
                cause: error,
            });
        }
    }

    async loadSession(sessionId: string): Promise<readonly AgentEvent[]> {
        this.#assertOpen();
        return this.#loadValidatedSession(sessionId)?.events ?? [];
    }

    async loadTaskState(sessionId: string): Promise<TaskState | undefined> {
        this.#assertOpen();
        return this.#loadValidatedSession(sessionId)?.state;
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

            CREATE TABLE IF NOT EXISTS task_state_snapshots (
                session_id TEXT PRIMARY KEY,
                last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1),
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            ) STRICT;
        `);

        this.#ensureSessionMetadataColumns();
        this.#backfillSessionMetadata();
        this.#backfillSnapshots();
    }

    #ensureSessionMetadataColumns(): void {
        const columns = new Set(
            (this.#database
                .prepare("PRAGMA table_info('sessions')")
                .all() as TableInfoRow[]).map((column) => column.name),
        );

        if (!columns.has("spec_digest")) {
            this.#database.exec("ALTER TABLE sessions ADD COLUMN spec_digest TEXT");
        }
        if (!columns.has("spec_snapshot_json")) {
            this.#database.exec(
                "ALTER TABLE sessions ADD COLUMN spec_snapshot_json TEXT",
            );
        }
    }

    #backfillSessionMetadata(): void {
        const sessions = this.#database
            .prepare(
                `SELECT session_id, spec_id, spec_path, spec_digest, spec_snapshot_json
                 FROM sessions`,
            )
            .all() as SessionMetadataRow[];

        for (const session of sessions) {
            if (
                session.spec_digest !== null &&
                session.spec_snapshot_json !== null
            ) {
                continue;
            }

            const events = this.#loadSessionUnchecked(session.session_id);
            const first = events[0];
            if (first?.type !== "session_started") {
                throw new Error(
                    `Session metadata has no valid session_started event: ${session.session_id}`,
                );
            }
            rebuildTaskState(events);

            if (
                session.spec_id !== first.specId ||
                session.spec_path !== first.specPath ||
                (session.spec_digest !== null && session.spec_digest !== first.specDigest) ||
                (session.spec_snapshot_json !== null &&
                    session.spec_snapshot_json !== JSON.stringify(first.specSnapshot))
            ) {
                throw new Error(
                    `Session metadata does not match its event stream: ${session.session_id}`,
                );
            }

            if (
                session.spec_digest === null ||
                session.spec_snapshot_json === null
            ) {
                this.#database
                    .prepare(
                        `UPDATE sessions
                         SET spec_digest = ?, spec_snapshot_json = ?
                         WHERE session_id = ?`,
                    )
                    .run(
                        first.specDigest,
                        JSON.stringify(first.specSnapshot),
                        session.session_id,
                    );
            }
        }
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
            events = rows.map((row) => validateAgentEvent(JSON.parse(row.payload_json)));
        } catch (error) {
            throw new EventStoreError({
                code: "event_storage_corrupt",
                message: `Stored event stream is invalid for session ${sessionId}`,
                cause: error,
            });
        }

        return events;
    }

    #loadValidatedSession(sessionId: string): SessionEvents | undefined {
        const events = this.#loadSessionUnchecked(sessionId);
        if (events.length === 0) {
            return undefined;
        }

        try {
            const state = rebuildTaskState(events);
            const row = this.#database
                .prepare(
                    `SELECT last_sequence, state_json
                     FROM task_state_snapshots
                     WHERE session_id = ?`,
                )
                .get(sessionId) as SnapshotRow | undefined;
            if (row === undefined) {
                throw new Error("TaskState snapshot is missing");
            }

            const snapshot = JSON.parse(row.state_json) as unknown;
            if (row.last_sequence !== state.lastSequence || !isDeepStrictEqual(snapshot, state)) {
                throw new Error("TaskState snapshot does not match event replay");
            }

            return { events, state };
        } catch (error) {
            throw new EventStoreError({
                code: "event_storage_corrupt",
                message: `Stored TaskState is invalid for session ${sessionId}`,
                cause: error,
            });
        }
    }

    #writeSnapshot(state: TaskState, updatedAt: string): void {
        this.#database
            .prepare(
                `INSERT INTO task_state_snapshots (
                    session_id, last_sequence, state_json, updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    last_sequence = excluded.last_sequence,
                    state_json = excluded.state_json,
                    updated_at = excluded.updated_at`,
            )
            .run(
                state.sessionId,
                state.lastSequence,
                JSON.stringify(state),
                updatedAt,
            );
    }

    #backfillSnapshots(): void {
        const sessionIds = this.#database
            .prepare(
                `SELECT sessions.session_id
                 FROM sessions
                 LEFT JOIN task_state_snapshots
                    ON task_state_snapshots.session_id = sessions.session_id
                 WHERE task_state_snapshots.session_id IS NULL`,
            )
            .all() as Array<{ session_id: string }>;

        for (const { session_id: sessionId } of sessionIds) {
            const events = this.#loadSessionUnchecked(sessionId);
            if (events.length === 0) {
                continue;
            }
            const state = rebuildTaskState(events);
            const updatedAt = events.at(-1)?.timestamp ?? new Date(0).toISOString();
            this.#writeSnapshot(state, updatedAt);
        }
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
