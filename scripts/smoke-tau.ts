import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { TauSessionAdapter } from "../packages/bench/tau/adapter.ts";
import { ProcessTauBridgeTransport, TauBridgeClient } from "../packages/bench/tau/client.ts";
import {
    buildTauEvidenceArtifact,
    buildTauReport,
    completedTauRun,
    failedTauRun,
    nextTauBenchmarkId,
    writeTauReport,
    type TauReportRun,
    type TauEvidenceArtifactOutput,
} from "../packages/bench/tau/report.ts";
import type { ModelProvider, ModelResponse } from "../src/model.ts";

type UpstreamLock = Readonly<{
    benchmark: Readonly<{
        displayName: string;
        distribution: string;
        repository: string;
        release: string;
        tagObject: string;
        commit: string;
        license: string;
    }>;
    transport: Readonly<{ protocolVersion: number }>;
}>;

type PackageMetadata = Readonly<{ version: string }>;

const runCommand = promisify(execFile);

class DeterministicSmokeModel implements ModelProvider {
    #turn = 0;

    async generate(): Promise<ModelResponse> {
        this.#turn += 1;
        if (this.#turn === 1) {
            return {
                kind: "tool_calls",
                calls: [{
                    id: "smoke-create-1",
                    name: "create_task",
                    input: { user_id: "user_1", title: "Important Meeting" },
                }],
                usage: { inputTokens: 0, outputTokens: 0 },
            };
        }
        if (this.#turn === 2) {
            return {
                kind: "text",
                text: "The Important Meeting task was created successfully.",
                usage: { inputTokens: 0, outputTokens: 0 },
            };
        }
        throw new Error("Official tau smoke requested an unexpected model turn");
    }
}

const projectRoot = resolve(".");
const lock = JSON.parse(
    await readFile(resolve("python/tau_bridge/upstream-lock.json"), "utf8"),
) as UpstreamLock;
const checkout = resolve(`.codetau/upstream/tau2-bench-${lock.benchmark.commit.slice(0, 8)}`);
const python = resolve(checkout, ".venv/Scripts/python.exe");
const uv = resolve(".codetau/upstream/uv-tool/Scripts/uv.exe");
await access(python);
await access(uv);

const startedAt = new Date();
const benchmarkId = nextTauBenchmarkId(startedAt);
const run = {
    domain: "mock",
    taskSplit: "base",
    taskId: "create_task_1",
    trial: 1,
    seed: 42,
} as const;

const transport = new ProcessTauBridgeTransport({
    command: python,
    args: ["-m", "tau_bridge"],
    cwd: resolve(projectRoot, "python"),
    timeoutMs: 60_000,
});
const adapter = new TauSessionAdapter({
    client: new TauBridgeClient(transport),
    model: new DeterministicSmokeModel(),
});
const runStartedAt = Date.now();
let reportRun: TauReportRun;
const evidenceArtifacts: TauEvidenceArtifactOutput[] = [];
try {
    const result = await adapter.run(run);
    assert.equal(result.metadata.upstreamCommit, lock.benchmark.commit);
    reportRun = completedTauRun(run, result);
    evidenceArtifacts.push(buildTauEvidenceArtifact(run, result.evidence));
} catch (error) {
    reportRun = failedTauRun(run, Date.now() - runStartedAt, error);
}

const [packageSource, uvLock, pythonResult, uvResult, gitCommitResult, gitStatusResult] =
    await Promise.all([
        readFile(resolve("package.json"), "utf8"),
        readFile(resolve(checkout, "uv.lock")),
        runCommand(python, ["--version"]),
        runCommand(uv, ["--version"]),
        runCommand("git", ["rev-parse", "HEAD"], { cwd: projectRoot }),
        runCommand("git", ["status", "--porcelain"], { cwd: projectRoot }),
    ]);
const packageMetadata = JSON.parse(packageSource) as PackageMetadata;
const report = buildTauReport({
    benchmarkId,
    model: "deterministic-smoke",
    startedAt,
    finishedAt: new Date(),
    reproducibility: {
        codeTau: {
            version: packageMetadata.version,
            gitCommit: gitCommitResult.stdout.trim(),
            dirty: gitStatusResult.stdout.trim().length > 0,
        },
        upstream: {
            ...lock.benchmark,
            uvLockSha256: createHash("sha256").update(uvLock).digest("hex"),
        },
        runtime: {
            python: `${pythonResult.stdout}${pythonResult.stderr}`.trim(),
            uv: `${uvResult.stdout}${uvResult.stderr}`.trim(),
        },
        protocolVersion: lock.transport.protocolVersion,
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
    },
    results: [reportRun],
});
const output = await writeTauReport({ report, evidenceArtifacts });

console.log(JSON.stringify({
    benchmarkId: report.benchmarkId,
    reportPath: output.reportPath,
    runs: report.overall.runs,
    successes: report.overall.successes,
    successRate: report.overall.successRate,
    averageDurationMs: report.overall.averageDurationMs,
    totalToolCalls: report.overall.totalToolCalls,
    failureCategories: report.overall.failureCategories,
}, null, 2));

if (!reportRun.passed) {
    process.exitCode = 1;
}
