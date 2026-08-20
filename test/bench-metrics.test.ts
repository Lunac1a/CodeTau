import assert from "node:assert/strict";
import test from "node:test";

import {
    observedPassAtK,
    summarizeTask,
} from "../packages/bench/metrics.ts";
import type { BenchRunResult } from "../packages/bench/types.ts";

function result(runNumber: number, passed: boolean): BenchRunResult {
    return {
        taskId: "task",
        runNumber,
        sessionId: `session-${runNumber}`,
        status: passed ? "completed" : "failed",
        passed,
        durationMs: runNumber * 100,
        toolCalls: runNumber,
        approvals: 0,
        validationCalls: passed ? 1 : 0,
        failureCategory: passed ? "none" : "model_turn_budget",
        diagnostics: {
            toolErrors: passed ? 0 : 1,
            patchFailures: 0,
            failedValidations: 0,
        },
        finalMessage: passed ? "passed" : "failed",
    };
}

test("computes observed pass@k", () => {
    assert.equal(observedPassAtK(4, 1, 1), 0.25);
    assert.equal(observedPassAtK(4, 1, 2), 0.5);
    assert.equal(observedPassAtK(4, 1, 4), 1);
});

test("summarizes repeated task runs", () => {
    const summary = summarizeTask("task", [
        result(1, true),
        result(2, false),
    ]);

    assert.equal(summary.successes, 1);
    assert.equal(summary.successRate, 0.5);
    assert.deepEqual(summary.passAtK, { "pass@1": 0.5, "pass@2": 1 });
    assert.equal(summary.averageDurationMs, 150);
    assert.equal(summary.averageToolCalls, 1.5);
    assert.deepEqual(summary.failureCategories, { model_turn_budget: 1 });
    assert.equal(summary.toolErrors, 1);
});
