import assert from "node:assert/strict";
import test from "node:test";

import type { TaskState } from "../src/events.ts";
import { buildSessionReport } from "../src/session/report.ts";
import type { AgentEvent } from "../src/types.ts";
import { createSessionStartedEvent, createTestSpec } from "./fixtures/spec.ts";

test("summarizes changed files, current validation, and model usage", () => {
    const sessionId = "report-session";
    const spec = createTestSpec({
        acceptanceCommands: [
            { executable: "node", args: ["test-a"] },
            { executable: "node", args: ["test-b"] },
        ],
    });
    const started = createSessionStartedEvent({
        eventId: "event-1",
        sessionId,
        spec,
        timestamp: "2026-08-25T00:00:00.000Z",
    });
    const base = (sequence: number) => ({
        id: `event-${sequence}`,
        sessionId,
        sequence,
        timestamp: "2026-08-25T00:00:00.000Z",
    });
    const events: AgentEvent[] = [
        started,
        {
            ...base(2),
            type: "model_tool_call",
            toolCall: { id: "validation-1", name: "run_validation", input: { commandIndex: 0 } },
            usage: { inputTokens: 10, outputTokens: 2 },
        },
        {
            ...base(3),
            type: "tool_result",
            toolCallId: "validation-1",
            result: { ok: true, output: { commandIndex: 0, passed: true } },
        },
        {
            ...base(4),
            type: "model_tool_call",
            toolCall: { id: "patch-1", name: "apply_patch", input: { path: "src/a.ts" } },
            usage: { inputTokens: 12, outputTokens: 4 },
        },
        {
            ...base(5),
            type: "tool_result",
            toolCallId: "patch-1",
            result: { ok: true, output: { path: "src/a.ts" } },
        },
        {
            ...base(6),
            type: "model_tool_call",
            toolCall: { id: "validation-2", name: "run_validation", input: { commandIndex: 1 } },
            usage: { inputTokens: 14, outputTokens: 3 },
        },
        {
            ...base(7),
            type: "tool_result",
            toolCallId: "validation-2",
            result: { ok: true, output: { commandIndex: 1, passed: true } },
        },
    ];
    const state: TaskState = {
        sessionId,
        specId: spec.contract.id,
        specPath: spec.sourcePath,
        specDigest: spec.digest,
        status: "analyzing",
        revision: 1,
        lastSequence: 7,
        lastEventId: "event-7",
    };
    const report = buildSessionReport(state, events);
    assert.deepEqual(report.changedFiles, ["src/a.ts"]);
    assert.deepEqual(report.passedValidationIndexes, [1]);
    assert.equal(report.validationCount, 2);
    assert.equal(report.modelTurns, 3);
    assert.equal(report.toolCalls, 3);
    assert.equal(report.inputTokens, 36);
    assert.equal(report.outputTokens, 9);
});
