import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ValidationCommand } from "../natural-language/command-line.ts";
import type {
    Conversation,
    ConversationSummary,
    ConversationSummaryContent,
    ConversationStore,
    ConversationTurn,
} from "./store.ts";

type ConversationRow = {
    conversation_id: string;
    validation_commands_json: string;
    created_at: string;
    updated_at: string;
};

type TurnRow = {
    turn_id: string;
    conversation_id: string;
    sequence: number;
    session_id: string;
    user_message: string;
    assistant_message: string | null;
    status: ConversationTurn["status"];
    created_at: string;
    completed_at: string | null;
};

type SummaryRow = {
    summary_id: string;
    conversation_id: string;
    through_sequence: number;
    source_turn_ids_json: string;
    source_digest: string;
    summary_json: string;
    created_at: string;
};

function stringArray(value: unknown, label: string): readonly string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`Conversation summary ${label} is invalid`);
    }
    return value;
}

function summaryContentFrom(source: string): ConversationSummaryContent {
    const value = JSON.parse(source) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Conversation summary is invalid");
    }
    const record = value as Record<string, unknown>;
    const keys = ["goals", "constraints", "decisions", "verifiedOutcomes", "openItems"];
    if (Object.keys(record).some((key) => !keys.includes(key))) {
        throw new Error("Conversation summary has unknown fields");
    }
    return {
        goals: stringArray(record.goals, "goals"),
        constraints: stringArray(record.constraints, "constraints"),
        decisions: stringArray(record.decisions, "decisions"),
        verifiedOutcomes: stringArray(record.verifiedOutcomes, "verifiedOutcomes"),
        openItems: stringArray(record.openItems, "openItems"),
    };
}

function summaryFrom(row: SummaryRow): ConversationSummary {
    return {
        id: row.summary_id,
        conversationId: row.conversation_id,
        throughSequence: row.through_sequence,
        sourceTurnIds: stringArray(JSON.parse(row.source_turn_ids_json), "sourceTurnIds"),
        sourceDigest: row.source_digest,
        content: summaryContentFrom(row.summary_json),
        createdAt: row.created_at,
    };
}

function validationCommandsFrom(source: string): readonly ValidationCommand[] {
    const parsed = JSON.parse(source) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("Conversation validation commands are invalid");
    }
    return parsed.map((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("Conversation validation command is invalid");
        }
        const executable = Reflect.get(value, "executable");
        const args = Reflect.get(value, "args");
        const display = Reflect.get(value, "display");
        if (
            typeof executable !== "string" ||
            !Array.isArray(args) ||
            args.some((item) => typeof item !== "string") ||
            (display !== undefined && typeof display !== "string")
        ) {
            throw new Error("Conversation validation command is invalid");
        }
        return {
            executable,
            args: args as string[],
            ...(display === undefined ? {} : { display }),
        };
    });
}

function conversationFrom(row: ConversationRow): Conversation {
    return {
        id: row.conversation_id,
        validationCommands: validationCommandsFrom(row.validation_commands_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function turnFrom(row: TurnRow): ConversationTurn {
    return {
        id: row.turn_id,
        conversationId: row.conversation_id,
        sequence: row.sequence,
        sessionId: row.session_id,
        userMessage: row.user_message,
        ...(row.assistant_message === null
            ? {}
            : { assistantMessage: row.assistant_message }),
        status: row.status,
        createdAt: row.created_at,
        ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    };
}

export class SQLiteConversationStore implements ConversationStore {
    readonly #database: DatabaseSync;
    #closed = false;

    constructor(databasePath: string) {
        if (databasePath !== ":memory:") {
            const absolutePath = resolve(databasePath);
            mkdirSync(dirname(absolutePath), { recursive: true });
            databasePath = absolutePath;
        }
        this.#database = new DatabaseSync(databasePath);
        this.#database.exec("PRAGMA foreign_keys = ON");
        this.#database.exec("PRAGMA journal_mode = WAL");
        this.#database.exec("PRAGMA busy_timeout = 5000");
        this.#database.exec(`
            CREATE TABLE IF NOT EXISTS chat_conversations (
                conversation_id TEXT PRIMARY KEY,
                validation_commands_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_turns (
                turn_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                session_id TEXT NOT NULL UNIQUE,
                user_message TEXT NOT NULL,
                assistant_message TEXT,
                status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'blocked')),
                created_at TEXT NOT NULL,
                completed_at TEXT,
                UNIQUE(conversation_id, sequence),
                FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id)
            );
            CREATE TABLE IF NOT EXISTS chat_summaries (
                summary_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                through_sequence INTEGER NOT NULL,
                source_turn_ids_json TEXT NOT NULL,
                source_digest TEXT NOT NULL,
                summary_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(conversation_id, through_sequence),
                FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id)
            );
        `);
    }

    async createConversation(options: {
        id: string;
        validationCommands: readonly ValidationCommand[];
        now: string;
    }): Promise<Conversation> {
        if (options.id.trim() === "" || options.validationCommands.length === 0) {
            throw new Error("Conversation id and validation commands are required");
        }
        this.#database
            .prepare(
                `INSERT INTO chat_conversations (
                    conversation_id, validation_commands_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?)`,
            )
            .run(
                options.id,
                JSON.stringify(options.validationCommands),
                options.now,
                options.now,
            );
        return (await this.loadConversation(options.id)) as Conversation;
    }

    async loadConversation(id: string): Promise<Conversation | undefined> {
        this.#assertOpen();
        const row = this.#database
            .prepare(
                `SELECT conversation_id, validation_commands_json, created_at, updated_at
                 FROM chat_conversations WHERE conversation_id = ?`,
            )
            .get(id) as ConversationRow | undefined;
        return row === undefined ? undefined : conversationFrom(row);
    }

    async loadTurns(conversationId: string): Promise<readonly ConversationTurn[]> {
        this.#assertOpen();
        const rows = this.#database
            .prepare(
                `SELECT turn_id, conversation_id, sequence, session_id,
                        user_message, assistant_message, status, created_at, completed_at
                 FROM chat_turns WHERE conversation_id = ? ORDER BY sequence`,
            )
            .all(conversationId) as unknown as TurnRow[];
        return rows.map(turnFrom);
    }

    async beginTurn(options: {
        id: string;
        conversationId: string;
        sessionId: string;
        userMessage: string;
        now: string;
    }): Promise<ConversationTurn> {
        this.#assertOpen();
        if (options.userMessage.trim() === "") {
            throw new Error("Conversation message must not be empty");
        }
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const row = this.#database
                .prepare(
                    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM chat_turns WHERE conversation_id = ?",
                )
                .get(options.conversationId) as { sequence: number };
            this.#database
                .prepare(
                    `INSERT INTO chat_turns (
                        turn_id, conversation_id, sequence, session_id, user_message,
                        status, created_at
                    ) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
                )
                .run(
                    options.id,
                    options.conversationId,
                    row.sequence,
                    options.sessionId,
                    options.userMessage,
                    options.now,
                );
            this.#database
                .prepare(
                    "UPDATE chat_conversations SET updated_at = ? WHERE conversation_id = ?",
                )
                .run(options.now, options.conversationId);
            this.#database.exec("COMMIT");
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
        const turn = (await this.loadTurns(options.conversationId)).find(
            (candidate) => candidate.id === options.id,
        );
        if (turn === undefined) throw new Error("Conversation turn was not persisted");
        return turn;
    }

    async completeTurn(options: {
        id: string;
        status: "completed" | "failed" | "blocked";
        assistantMessage: string;
        now: string;
    }): Promise<void> {
        this.#assertOpen();
        const result = this.#database
            .prepare(
                `UPDATE chat_turns
                 SET status = ?, assistant_message = ?, completed_at = ?
                 WHERE turn_id = ? AND status = 'running'`,
            )
            .run(options.status, options.assistantMessage, options.now, options.id);
        if (result.changes !== 1) {
            throw new Error(`Conversation turn is not running: ${options.id}`);
        }
    }

    async failOpenTurns(conversationId: string, now: string): Promise<void> {
        this.#assertOpen();
        this.#database
            .prepare(
                `UPDATE chat_turns
                 SET status = 'failed',
                     assistant_message = 'The previous CLI process ended before this turn completed.',
                     completed_at = ?
                 WHERE conversation_id = ? AND status = 'running'`,
            )
            .run(now, conversationId);
    }

    async loadLatestSummary(
        conversationId: string,
    ): Promise<ConversationSummary | undefined> {
        this.#assertOpen();
        const rows = this.#database
            .prepare(
                `SELECT summary_id, conversation_id, through_sequence,
                        source_turn_ids_json, source_digest, summary_json, created_at
                 FROM chat_summaries
                 WHERE conversation_id = ?
                 ORDER BY through_sequence DESC`,
            )
            .all(conversationId) as unknown as SummaryRow[];
        for (const row of rows) {
            try {
                return summaryFrom(row);
            } catch {
                // Summaries are derived caches. Ignore a corrupt row and try an older one.
            }
        }
        return undefined;
    }

    async appendSummary(summary: ConversationSummary): Promise<void> {
        this.#assertOpen();
        if (
            summary.id.trim() === "" ||
            summary.conversationId.trim() === "" ||
            !Number.isSafeInteger(summary.throughSequence) ||
            summary.throughSequence <= 0 ||
            !/^[a-f0-9]{64}$/u.test(summary.sourceDigest)
        ) {
            throw new Error("Conversation summary metadata is invalid");
        }
        this.#database
            .prepare(
                `INSERT INTO chat_summaries (
                    summary_id, conversation_id, through_sequence,
                    source_turn_ids_json, source_digest, summary_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                summary.id,
                summary.conversationId,
                summary.throughSequence,
                JSON.stringify(summary.sourceTurnIds),
                summary.sourceDigest,
                JSON.stringify(summary.content),
                summary.createdAt,
            );
    }

    async close(): Promise<void> {
        if (!this.#closed) {
            this.#database.close();
            this.#closed = true;
        }
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("Conversation store is closed");
    }
}
