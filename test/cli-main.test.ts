import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../apps/cli/main.ts";
import { SQLiteEventStore } from "../src/persistence/sqlite-event-store.ts";
import type { AgentEvent } from "../src/types.ts";
import { createSessionStartedEvent, createTestSpec } from "./fixtures/spec.ts";

type CapturedWriter = {
    readonly writer: { write(text: string): void };
    read(): string;
};

function captureWriter(): CapturedWriter {
    let output = "";
    return {
        writer: {
            write(text: string): void {
                output += text;
            },
        },
        read: () => output,
    };
}

function analyzingEvents(sessionId: string): readonly AgentEvent[] {
    const spec = createTestSpec({ id: "spec.cli-main" });
    const started = createSessionStartedEvent({
        eventId: "cli-main-event-1",
        sessionId,
        spec,
        timestamp: "2026-08-20T00:00:00.000Z",
    });

    return [
        started,
        {
            id: "cli-main-event-2",
            sessionId,
            sequence: 2,
            timestamp: "2026-08-20T00:00:00.000Z",
            type: "state_changed",
            from: "created",
            to: "analyzing",
            reason: "The Spec is ready.",
            sourceEventId: started.id,
        },
    ];
}

test("runs status against the configured SQLite database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-cli-main-"));
    const databasePath = join(directory, "codetau.db");
    const seedStore = new SQLiteEventStore(databasePath);

    try {
        await seedStore.appendMany(analyzingEvents("session-cli"));
        await seedStore.close();

        const stdout = captureWriter();
        const stderr = captureWriter();
        const exitCode = await runCli({
            argv: ["status", "session-cli"],
            databasePath,
            stdout: stdout.writer,
            stderr: stderr.writer,
        });

        assert.equal(exitCode, 0);
        assert.match(stdout.read(), /Status: analyzing/);
        assert.equal(stderr.read(), "");
    } finally {
        await seedStore.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("prints usage errors without opening the database", async () => {
    const stdout = captureWriter();
    const stderr = captureWriter();
    let openedDatabase = false;

    const exitCode = await runCli({
        argv: ["unknown"],
        databasePath: "unused.db",
        stdout: stdout.writer,
        stderr: stderr.writer,
        createEventStore: () => {
            openedDatabase = true;
            throw new Error("The database should not be opened");
        },
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout.read(), "");
    assert.match(stderr.read(), /Usage: codetau status <session-id>/);
    assert.equal(openedDatabase, false);
});
