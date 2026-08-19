import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resumeAgentLoop } from "../src/agent-loop/run.ts";
import { rebuildTaskState } from "../src/events.ts";
import { SQLiteEventStore } from "../src/persistence/sqlite-event-store.ts";
import type { LoadedSpec } from "../src/spec/types.ts";
import type { AgentEvent } from "../src/types.ts";
import { runEventStoreContract } from "./contracts/event-store-contract.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";

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

test("SQLiteEventStore: resumes the Agent loop after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-resume-"));
    const databasePath = join(directory, "events.db");
    const spec: LoadedSpec = {
        sourcePath: "C:\\workspace\\specs\\resume.md",
        context: "Continue the interrupted task.",
        contract: {
            version: 1,
            id: "test.sqlite-resume",
            goal: "Resume a persisted Agent loop.",
            workspace: { root: "fixtures/example", allowedPaths: ["src/**"] },
            policy: { forbiddenActions: ["network-access"] },
            acceptance: { commands: [], assertions: ["The session resumes."] },
            phases: [{ id: "analyze", description: "Analyze the task." }],
            budget: { maxModelTurns: 3, maxToolCalls: 10, maxRetries: 1 },
            userInteraction: {
                allowQuestions: false,
                approvalResponses: ["allow-once", "allow-session", "deny"],
            },
        },
    };
    const interruptedEvents: AgentEvent[] = [
        {
            id: "persisted-1",
            sessionId: "session-sqlite-resume",
            sequence: 1,
            timestamp: "2026-08-19T00:00:00.000Z",
            type: "session_started",
            specId: spec.contract.id,
            specPath: spec.sourcePath,
        },
        {
            id: "persisted-2",
            sessionId: "session-sqlite-resume",
            sequence: 2,
            timestamp: "2026-08-19T00:00:01.000Z",
            type: "state_changed",
            from: "created",
            to: "analyzing",
            reason: "Analysis started before interruption.",
            sourceEventId: "persisted-1",
        },
        {
            id: "persisted-3",
            sessionId: "session-sqlite-resume",
            sequence: 3,
            timestamp: "2026-08-19T00:00:02.000Z",
            type: "model_text",
            text: "Persist this reasoning for the resumed turn.",
            usage: { inputTokens: 10, outputTokens: 8 },
        },
    ];

    try {
        const firstStore = new SQLiteEventStore(databasePath);
        for (const event of interruptedEvents) {
            await firstStore.append(event);
        }
        await firstStore.close();

        const reopenedStore = new SQLiteEventStore(databasePath);
        const model = new FakeModelProvider([
            {
                kind: "finish",
                outcome: "blocked",
                message: "The persisted session resumed successfully.",
                usage: { inputTokens: 20, outputTokens: 6 },
            },
        ]);
        try {
            let eventNumber = 0;
            const state = await resumeAgentLoop({
                sessionId: "session-sqlite-resume",
                spec,
                model,
                eventStore: reopenedStore,
                runtime: {
                    nextEventId: () => `resumed-${++eventNumber}`,
                    now: () => "2026-08-19T00:01:00.000Z",
                },
            });

            assert.equal(state.status, "blocked");
            assert.equal(
                model.requests[0].messages.at(-1)?.content,
                "Persist this reasoning for the resumed turn.",
            );
            assert.equal(
                (await reopenedStore.loadSession("session-sqlite-resume")).at(-1)?.type,
                "final",
            );
        } finally {
            await reopenedStore.close();
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
