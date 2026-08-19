import assert from "node:assert/strict";
import test from "node:test";

import { EventReplayError, rebuildTaskState } from "../src/events.ts";
import type { AgentEvent } from "../src/types.ts";
import { createSessionStartedEvent, createTestSpec } from "./fixtures/spec.ts";

const timestamp = "2026-08-18T00:00:00.000Z";

function normalEvents(): AgentEvent[] {
    const spec = createTestSpec({
        id: "test.replay",
        sourcePath: "specs/replay.md",
    });
    return [
        createSessionStartedEvent({
            eventId: "event-1",
            sessionId: "session-1",
            spec,
            timestamp,
        }),
        {
            id: "event-2",
            sessionId: "session-1",
            sequence: 2,
            timestamp,
            type: "state_changed",
            from: "created",
            to: "analyzing",
            reason: "The validated Spec is ready for analysis.",
            sourceEventId: "event-1",
        },
        {
            id: "event-3",
            sessionId: "session-1",
            sequence: 3,
            timestamp,
            type: "model_tool_call",
            toolCall: {
                id: "patch-1",
                name: "apply_patch",
                input: { path: "src/example.ts" },
            },
        },
        {
            id: "event-4",
            sessionId: "session-1",
            sequence: 4,
            timestamp,
            type: "state_changed",
            from: "analyzing",
            to: "editing",
            reason: "The model requested an in-scope patch.",
            sourceEventId: "event-3",
        },
        {
            id: "event-5",
            sessionId: "session-1",
            sequence: 5,
            timestamp,
            type: "tool_result",
            toolCallId: "patch-1",
            result: { ok: true, output: { changed: true } },
        },
        {
            id: "event-6",
            sessionId: "session-1",
            sequence: 6,
            timestamp,
            type: "state_changed",
            from: "editing",
            to: "validating",
            reason: "The patch succeeded and now requires validation.",
            sourceEventId: "event-5",
        },
        {
            id: "event-7",
            sessionId: "session-1",
            sequence: 7,
            timestamp,
            type: "model_tool_call",
            toolCall: {
                id: "test-1",
                name: "run_test",
                input: { executable: "pnpm", args: ["test"] },
            },
        },
        {
            id: "event-8",
            sessionId: "session-1",
            sequence: 8,
            timestamp,
            type: "tool_result",
            toolCallId: "test-1",
            result: { ok: true, output: { exitCode: 0 } },
        },
        {
            id: "event-9",
            sessionId: "session-1",
            sequence: 9,
            timestamp,
            type: "state_changed",
            from: "validating",
            to: "completed",
            reason: "All declared acceptance checks passed.",
            sourceEventId: "event-8",
        },
        {
            id: "event-10",
            sessionId: "session-1",
            sequence: 10,
            timestamp,
            type: "final",
            status: "completed",
            message: "Task completed and validated.",
        },
    ];
}

function expectReplayError(
    code: EventReplayError["code"],
): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.ok(error instanceof EventReplayError);
        assert.equal(error.code, code);
        return true;
    };
}

test("rebuilds a completed immutable state from ordered events", () => {
    const events = normalEvents();
    const beforeReplay = structuredClone(events);
    const state = rebuildTaskState(events);

    assert.deepEqual(events, beforeReplay);
    assert.equal(state.sessionId, "session-1");
    assert.equal(state.specId, "test.replay");
    assert.equal(state.status, "completed");
    assert.equal(state.revision, 4);
    assert.equal(state.lastSequence, 10);
    assert.deepEqual(state.final, {
        status: "completed",
        message: "Task completed and validated.",
    });
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(state.final), true);
});

test("rebuilds an unfinished state for session resume", () => {
    const state = rebuildTaskState(normalEvents().slice(0, 6));

    assert.equal(state.status, "validating");
    assert.equal(state.lastSequence, 6);
    assert.equal(state.final, undefined);
});

test("rejects a gap in event sequence numbers", () => {
    const events = normalEvents();
    events[2] = { ...events[2], sequence: 4 };

    assert.throws(
        () => rebuildTaskState(events),
        expectReplayError("event_sequence_invalid"),
    );
});

test("rejects an event from another session", () => {
    const events = normalEvents();
    events[2] = { ...events[2], sessionId: "session-other" };

    assert.throws(
        () => rebuildTaskState(events),
        expectReplayError("event_session_mismatch"),
    );
});

test("requires state changes to reference an earlier event", () => {
    const events = normalEvents();
    const stateEvent = events[1];
    assert.equal(stateEvent.type, "state_changed");
    events[1] = { ...stateEvent, sourceEventId: "event-future" };

    assert.throws(
        () => rebuildTaskState(events),
        expectReplayError("state_source_invalid"),
    );
});

test("rejects a final declaration that disagrees with replay state", () => {
    const events = normalEvents();
    const finalEvent = events[9];
    assert.equal(finalEvent.type, "final");
    events[9] = { ...finalEvent, status: "failed" };

    assert.throws(
        () => rebuildTaskState(events),
        expectReplayError("final_state_mismatch"),
    );
});

test("rejects events appended after a final declaration", () => {
    const events = normalEvents();
    events.push({
        id: "event-11",
        sessionId: "session-1",
        sequence: 11,
        timestamp,
        type: "tool_result",
        toolCallId: "late-call",
        result: { ok: true, output: null },
    });

    assert.throws(
        () => rebuildTaskState(events),
        expectReplayError("event_after_final"),
    );
});

test("rejects a Session whose Spec snapshot was changed after hashing", () => {
    const events = normalEvents();
    const startEvent = events[0];
    assert.equal(startEvent.type, "session_started");
    events[0] = {
        ...startEvent,
        specSnapshot: {
            ...startEvent.specSnapshot,
            context: "Tampered context.",
        },
    };

    assert.throws(
        () => rebuildTaskState(events),
        expectReplayError("session_spec_digest_invalid"),
    );
});
