import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../apps/cli/main.ts";
import type { CodeTauConfig } from "../src/config/loader.ts";
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

function config(databasePath: string): CodeTauConfig {
    const rootDirectory = join(databasePath, "..");
    return {
        databasePath,
        model: "test-model",
        baseUrl: "http://localhost:1234/v1",
        commandAllowlist: [],
        commandTimeoutMs: 1_000,
        maxOutputBytes: 1_000,
        sourcePath: join(rootDirectory, "codetau.config.json"),
        rootDirectory,
        naturalLanguage: {
            maxModelTurns: 20,
            maxToolCalls: 60,
            maxRetries: 3,
            additionalProtectedPaths: [],
        },
    };
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
            configPath: "unused.json",
            stdout: stdout.writer,
            stderr: stderr.writer,
            loadConfig: async () => config(databasePath),
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
        configPath: "unused.json",
        stdout: stdout.writer,
        stderr: stderr.writer,
        loadConfig: async () => {
            throw new Error("Configuration should not be loaded");
        },
        createEventStore: () => {
            openedDatabase = true;
            throw new Error("The database should not be opened");
        },
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout.read(), "");
    assert.match(stderr.read(), /codetau run <spec-path>/);
    assert.equal(openedDatabase, false);
});

test("routes run commands through the Session Runner", async () => {
    const stdout = captureWriter();
    const stderr = captureWriter();
    const testConfig = config(":memory:");
    let receivedSpecPath = "";

    const exitCode = await runCli({
        argv: ["run", "specs/task.md", "--session", "cli-run"],
        configPath: "unused.json",
        stdout: stdout.writer,
        stderr: stderr.writer,
        loadConfig: async () => testConfig,
        createEventStore: () => new SQLiteEventStore(":memory:"),
        createSessionRunner: () => ({
            async run(options) {
                receivedSpecPath = options.specPath;
                return {
                    sessionId: options.sessionId ?? "generated",
                    specId: "spec.cli-run",
                    specPath: options.specPath,
                    specDigest: "digest",
                    status: "awaiting_approval",
                    revision: 0,
                    lastSequence: 3,
                    lastEventId: "event-3",
                    pendingApproval: {
                        toolCallId: "patch-1",
                        toolName: "apply_patch",
                    },
                };
            },
            async runLoadedSpec() {
                throw new Error("runLoadedSpec should not be called");
            },
            async resume() {
                throw new Error("resume should not be called");
            },
        }),
    });

    assert.equal(exitCode, 0);
    assert.equal(receivedSpecPath, "specs/task.md");
    assert.match(stdout.read(), /Status: awaiting_approval/);
    assert.match(stdout.read(), /codetau resume cli-run --approval allow-once/);
    assert.equal(stderr.read(), "");
});
