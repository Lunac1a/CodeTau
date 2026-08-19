import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgentLoop, type AgentLoopRuntime } from "../src/agent-loop/run.ts";
import {
    exportSessionJsonl,
    importSessionJsonl,
    replayEventJsonl,
} from "../src/persistence/jsonl.ts";
import { SQLiteEventStore } from "../src/persistence/sqlite-event-store.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";
import { createTestSpec } from "./fixtures/spec.ts";

test("phase two: a durable Agent session survives export, replay, and import", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-phase-two-"));
    const sourcePath = join(directory, "source.db");
    const destinationPath = join(directory, "destination.db");
    const sessionId = "session-phase-two";
    let eventNumber = 0;
    const runtime: AgentLoopRuntime = {
        nextEventId: () => `phase-two-event-${++eventNumber}`,
        now: () => "2026-08-19T00:00:00.000Z",
    };

    try {
        const source = new SQLiteEventStore(sourcePath);
        const originalState = await runAgentLoop({
            sessionId,
            spec: createTestSpec({
                id: "spec.phase-two",
                sourcePath: "specs/phase-two.md",
            }),
            model: new FakeModelProvider([
                {
                    kind: "text",
                    text: "The durable session is being analyzed.",
                    usage: { inputTokens: 12, outputTokens: 7 },
                },
                {
                    kind: "finish",
                    outcome: "blocked",
                    message: "Tool execution belongs to the next phase.",
                    usage: { inputTokens: 20, outputTokens: 8 },
                },
            ]),
            eventStore: source,
            runtime,
        });
        await source.close();

        const reopenedSource = new SQLiteEventStore(sourcePath);
        const jsonl = await exportSessionJsonl(reopenedSource, sessionId);
        const sourceEventsBeforeReplay = await reopenedSource.loadSession(sessionId);
        const replay = replayEventJsonl(jsonl);

        assert.deepEqual(replay.state, originalState);
        assert.deepEqual(await reopenedSource.loadTaskState(sessionId), originalState);
        assert.deepEqual(
            await reopenedSource.loadSession(sessionId),
            sourceEventsBeforeReplay,
        );
        await reopenedSource.close();

        const destination = new SQLiteEventStore(destinationPath);
        const importedState = await importSessionJsonl(destination, jsonl);
        assert.deepEqual(importedState, originalState);
        await destination.close();

        const reopenedDestination = new SQLiteEventStore(destinationPath);
        try {
            assert.deepEqual(
                await reopenedDestination.loadSession(sessionId),
                sourceEventsBeforeReplay,
            );
            assert.deepEqual(
                await reopenedDestination.loadTaskState(sessionId),
                originalState,
            );
        } finally {
            await reopenedDestination.close();
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
