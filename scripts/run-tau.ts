import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { TauSessionAdapter } from "../packages/bench/tau/adapter.ts";
import { ProcessTauBridgeTransport, TauBridgeClient } from "../packages/bench/tau/client.ts";
import { parseTauCliArgs } from "../packages/bench/tau/cli.ts";
import {
    DeterministicTauModel,
    deterministicTauTaskIds,
} from "../packages/bench/tau/deterministic-model.ts";
import { runTauEvaluation } from "../packages/bench/tau/runner.ts";
import type { TauReproducibilityMetadata } from "../packages/bench/tau/report.ts";
import { OpenAICompatibleModelProvider } from "../src/providers/openai-compatible.ts";

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
const options = parseTauCliArgs(process.argv.slice(2));
if (
    options.modelMode === "deterministic" &&
    options.taskIds.some((taskId) => !deterministicTauTaskIds.includes(taskId))
) {
    throw new Error(
        `Deterministic mode supports only: ${deterministicTauTaskIds.join(", ")}`,
    );
}

const projectRoot = resolve(".");
const lock = JSON.parse(
    await readFile(resolve("python/tau_bridge/upstream-lock.json"), "utf8"),
) as UpstreamLock;
const packageMetadata = JSON.parse(
    await readFile(resolve("package.json"), "utf8"),
) as PackageMetadata;
const checkout = resolve(`.codetau/upstream/tau2-bench-${lock.benchmark.commit.slice(0, 8)}`);
const python = resolve(checkout, ".venv/Scripts/python.exe");
const uv = resolve(".codetau/upstream/uv-tool/Scripts/uv.exe");
await Promise.all([access(python), access(uv)]);

const [uvLock, pythonResult, uvResult, gitCommitResult, gitStatusResult] =
    await Promise.all([
        readFile(resolve(checkout, "uv.lock")),
        runCommand(python, ["--version"]),
        runCommand(uv, ["--version"]),
        runCommand("git", ["rev-parse", "HEAD"], { cwd: projectRoot }),
        runCommand("git", ["status", "--porcelain"], { cwd: projectRoot }),
    ]);

const reproducibility: TauReproducibilityMetadata = {
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
        modelMode: options.modelMode,
        modelBaseUrl: options.modelMode === "lmstudio" ? options.baseUrl : null,
    },
};

const output = await runTauEvaluation({
    tasks: options.taskIds.map((taskId) => ({
        domain: "mock",
        taskSplit: "base",
        taskId,
    })),
    runsPerTask: options.runsPerTask,
    baseSeed: options.baseSeed,
    model: options.modelMode === "deterministic" ? "deterministic-smoke" : options.model,
    reproducibility,
    ...(options.outputDirectory === undefined
        ? {}
        : { outputDirectory: options.outputDirectory }),
    onProgress: (message) => process.stderr.write(`${message}\n`),
    runSession: async (run) => {
        const model = options.modelMode === "deterministic"
            ? new DeterministicTauModel(run.taskId as string)
            : new OpenAICompatibleModelProvider({
                  baseUrl: options.baseUrl,
                  model: options.model,
                  apiKey: process.env.CODETAU_MODEL_API_KEY,
              });
        const transport = new ProcessTauBridgeTransport({
            command: python,
            args: ["-m", "tau_bridge"],
            cwd: resolve(projectRoot, "python"),
            timeoutMs: 180_000,
        });
        return await new TauSessionAdapter({
            client: new TauBridgeClient(transport),
            model,
        }).run(run);
    },
});

console.log(JSON.stringify({
    benchmarkId: output.report.benchmarkId,
    reportPath: output.reportPath,
    tasks: output.report.tasks.length,
    runs: output.report.overall.runs,
    successes: output.report.overall.successes,
    successRate: output.report.overall.successRate,
    averageReward: output.report.overall.averageReward,
    averageDurationMs: output.report.overall.averageDurationMs,
    totalToolCalls: output.report.overall.totalToolCalls,
    failureCategories: output.report.overall.failureCategories,
}, null, 2));

if (output.report.overall.successes !== output.report.overall.runs) {
    process.exitCode = 1;
}
