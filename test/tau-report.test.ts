import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TauAdapterError } from "../packages/bench/tau/adapter.ts";
import { TauBridgeClientError } from "../packages/bench/tau/client.ts";
import {
    buildTauEvidenceArtifact,
    buildTauReport,
    classifyTauFailure,
    completedTauRun,
    failedTauRun,
    writeTauReport,
    type TauReproducibilityMetadata,
} from "../packages/bench/tau/report.ts";

const evidence = {
    schemaVersion: 1,
    official: {
        terminationReason: "user_stop",
        rewardInfo: {
            reward: 1,
            reward_basis: ["DB"],
            reward_breakdown: { DB: 1 },
        },
    },
    session: {
        domainPolicy: "Follow the policy.",
        toolNames: ["create_task"],
        messageHistory: [],
        trajectory: [],
    },
} as const;

const run = {
    domain: "mock",
    taskSplit: "base",
    taskId: "create_task_1",
    trial: 1,
    seed: 42,
} as const;

const reproducibility: TauReproducibilityMetadata = {
    codeTau: { version: "0.1.0", gitCommit: "a".repeat(40), dirty: true },
    upstream: {
        displayName: "tau3-bench",
        distribution: "tau2",
        repository: "https://github.com/sierra-research/tau2-bench",
        release: "v1.0.1",
        tagObject: "d".repeat(40),
        commit: "b".repeat(40),
        license: "MIT",
        uvLockSha256: "c".repeat(64),
    },
    runtime: { python: "Python 3.12.10", uv: "uv 0.12.5" },
    protocolVersion: 2,
    evaluation: {
        modality: "text",
        communication: "half-duplex",
        evaluator: "env",
        user: "scripted-smoke",
        userModel: null,
        userBaseUrl: null,
        modelMode: "deterministic-model",
        modelBaseUrl: null,
    },
};

test("builds a tau report with unified success, timing, tool, and failure metrics", () => {
    const passed = completedTauRun(run, {
        reward: 1,
        status: "completed",
        metadata: {
            upstreamCommit: "b".repeat(40),
            protocolVersion: 2,
            ...run,
        },
        modelTurns: 2,
        toolCalls: 1,
        toolCallsByName: { create_task: 1 },
        durationMs: 200,
        usage: { inputTokens: 10, outputTokens: 5 },
        evidence,
    });
    const failed = failedTauRun(
        { ...run, trial: 2 },
        400,
        new TauBridgeClientError("response_timeout", "timed out"),
    );
    const report = buildTauReport({
        benchmarkId: "tau-report-test",
        model: "deterministic-smoke",
        startedAt: new Date("2026-08-22T00:00:00.000Z"),
        finishedAt: new Date("2026-08-22T00:00:01.000Z"),
        reproducibility,
        results: [passed, failed],
    });

    assert.equal(report.overall.runs, 2);
    assert.equal(report.version, 4);
    assert.equal(report.overall.successes, 1);
    assert.equal(report.overall.successRate, 0.5);
    assert.equal(report.overall.averageReward, 0.5);
    assert.equal(report.overall.averageDurationMs, 300);
    assert.equal(report.overall.averageToolCalls, 0.5);
    assert.equal(report.overall.totalModelTurns, 2);
    assert.deepEqual(report.overall.toolCallsByName, { create_task: 1 });
    assert.deepEqual(report.overall.failureCategories, { timeout: 1 });
    assert.equal(report.results[1]?.error?.code, "response_timeout");
    assert.deepEqual(report.tasks[0]?.passAtK, { "pass@1": 0.5, "pass@2": 1 });
});

test("classifies model provider failures without exposing their cause", () => {
    const failure = classifyTauFailure(
        new TauAdapterError("model_provider_error", "Model provider failed", {
            cause: new Error("secret upstream detail"),
        }),
    );
    assert.deepEqual(failure, {
        category: "model_provider_error",
        code: "model_provider_error",
        message: "Model provider failed",
    });
});

test("writes a reproducible tau report artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-tau-report-"));
    try {
        const result = completedTauRun(run, {
            reward: 1,
            status: "completed",
            metadata: {
                upstreamCommit: "b".repeat(40),
                protocolVersion: 2,
                ...run,
            },
            modelTurns: 1,
            toolCalls: 0,
            toolCallsByName: {},
            durationMs: 10,
            usage: { inputTokens: 0, outputTokens: 0 },
            evidence,
        });
        const evidenceArtifact = buildTauEvidenceArtifact(run, evidence);
        const report = buildTauReport({
            benchmarkId: "write-test",
            model: "fake",
            startedAt: new Date("2026-08-22T00:00:00.000Z"),
            finishedAt: new Date("2026-08-22T00:00:01.000Z"),
            reproducibility,
            results: [result],
        });
        const output = await writeTauReport({
            report,
            evidenceArtifacts: [evidenceArtifact],
            outputDirectory: directory,
        });
        assert.deepEqual(
            JSON.parse(await readFile(output.reportPath, "utf8")),
            report,
        );
        assert.deepEqual(
            JSON.parse(
                await readFile(
                    join(output.benchmarkDirectory, evidenceArtifact.path),
                    "utf8",
                ),
            ),
            evidenceArtifact.artifact,
        );
        assert.equal(report.results[0]?.evidenceArtifact, evidenceArtifact.path);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("refuses to write a report with missing diagnostic evidence", async () => {
    const result = completedTauRun(run, {
        reward: 1,
        status: "completed",
        metadata: {
            upstreamCommit: "b".repeat(40),
            protocolVersion: 2,
            ...run,
        },
        modelTurns: 1,
        toolCalls: 0,
        toolCallsByName: {},
        durationMs: 10,
        usage: { inputTokens: 0, outputTokens: 0 },
        evidence,
    });
    const report = buildTauReport({
        benchmarkId: "missing-evidence-test",
        model: "fake",
        startedAt: new Date("2026-08-22T00:00:00.000Z"),
        finishedAt: new Date("2026-08-22T00:00:01.000Z"),
        reproducibility,
        results: [result],
    });

    await assert.rejects(
        writeTauReport({ report }),
        /evidence artifacts do not match completed runs/u,
    );
});
