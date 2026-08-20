import assert from "node:assert/strict";
import test from "node:test";

import { runStatusCommand } from "../apps/cli/status.ts";
import { InMemoryEventStore } from "../src/persistence/in-memory-event-store.ts";
import type { AgentEvent } from "../src/types.ts";
import { createSessionStartedEvent, createTestSpec } from "./fixtures/spec.ts";

const timestamp = "2026-08-20T00:00:00.000Z";

function analyzingSessionEvents(sessionId: string): readonly AgentEvent[] {
    const spec = createTestSpec({
        id: "spec.cli-status",
        sourcePath: "specs/cli-status.md",
    });
    const started = createSessionStartedEvent({
        eventId: "status-event-1",
        sessionId,
        spec,
        timestamp,
    });

    return [
        started,
        {
            id: "status-event-2",
            sessionId,
            sequence: 2,
            timestamp,
            type: "state_changed",
            from: "created",
            to: "analyzing",
            reason: "The Spec is ready.",
            sourceEventId: started.id,
        },
    ];
}

test("renders the persisted state of an existing session", async () => {
    const store = new InMemoryEventStore();

    try {
        await store.appendMany(analyzingSessionEvents("session-status"));

        const result = await runStatusCommand(
            { kind: "status", sessionId: "session-status" },
            store,
        );

        assert.deepEqual(result, {
            exitCode: 0,
            stdout: [
                "Session: session-status",
                "Status: analyzing",
                "Spec: spec.cli-status",
                "Revision: 1",
                "Last sequence: 2",
                "",
            ].join("\n"),
            stderr: "",
        });
    } finally {
        await store.close();
    }
});

test("reports a missing session without throwing", async () => {
    const store = new InMemoryEventStore();

    try {
        assert.deepEqual(
            await runStatusCommand(
                { kind: "status", sessionId: "missing-session" },
                store,
            ),
            {
                exitCode: 1,
                stdout: "",
                stderr: "Session not found: missing-session\n",
            },
        );
    } finally {
        await store.close();
    }
});
