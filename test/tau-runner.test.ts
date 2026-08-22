import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runTauEvaluation } from "../packages/bench/tau/runner.ts";
import type { TauReproducibilityMetadata } from "../packages/bench/tau/report.ts";

const reproducibility: TauReproducibilityMetadata = {
    codeTau: { version: "0.1.0", gitCommit: "a".repeat(40), dirty: false },
    upstream: {
        displayName: "tau3-bench",
        distribution: "tau2",
        repository: "https://github.com/sierra-research/tau2-bench",
        release: "v1.0.1",
        tagObject: "b".repeat(40),
        commit: "c".repeat(40),
        license: "MIT",
        uvLockSha256: "d".repeat(64),
    },
    runtime: { python: "Python 3.12.10", uv: "uv 0.12.5" },
    protocolVersion: 1,
    evaluation: {
        modality: "text",
        communication: "half-duplex",
        evaluator: "env",
        user: "scripted-smoke",
        userModel: null,
        userBaseUrl: null,
        modelMode: "fake",
        modelBaseUrl: null,
    },
};

test("runs multiple tau tasks and trials with stable distinct seeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-tau-runner-"));
    const seeds: Array<number | null> = [];
    try {
        const output = await runTauEvaluation({
            tasks: [
                { domain: "mock", taskSplit: "base", taskId: "create_task_1" },
                { domain: "mock", taskSplit: "base", taskId: "update_task_1" },
            ],
            runsPerTask: 2,
            baseSeed: 10,
            model: "fake",
            reproducibility,
            outputDirectory: directory,
            nextBenchmarkId: () => "repeated-test",
            runSession: async (run) => {
                seeds.push(run.seed);
                return {
                    reward: 1,
                    status: "completed",
                    metadata: { upstreamCommit: "c".repeat(40), protocolVersion: 1, ...run },
                    modelTurns: 2,
                    toolCalls: 1,
                    toolCallsByName: { tool: 1 },
                    durationMs: 25,
                    usage: { inputTokens: 5, outputTokens: 2 },
                };
            },
        });
        assert.deepEqual(seeds, [10, 11, 12, 13]);
        assert.equal(output.report.results.length, 4);
        assert.equal(output.report.tasks.length, 2);
        assert.deepEqual(output.report.tasks.map((task) => task.passAtK), [
            { "pass@1": 1, "pass@2": 1 },
            { "pass@1": 1, "pass@2": 1 },
        ]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
