import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { TauRunStart } from "./client.ts";
import { TauBridgeClientError, TauBridgeRemoteError } from "./client.ts";
import { TauAdapterError, type TauSessionResult } from "./adapter.ts";
import { observedPassAtK } from "../metrics.ts";

export type TauFailureCategory =
    | "none"
    | "benchmark_reward"
    | "model_provider_error"
    | "timeout"
    | "bridge_process_error"
    | "bridge_protocol_error"
    | "upstream_driver_error"
    | "adapter_error"
    | "unknown_error";

export type TauReproducibilityMetadata = Readonly<{
    codeTau: Readonly<{ version: string; gitCommit: string; dirty: boolean }>;
    upstream: Readonly<{
        displayName: string;
        distribution: string;
        repository: string;
        release: string;
        tagObject: string;
        commit: string;
        license: string;
        uvLockSha256: string;
    }>;
    runtime: Readonly<{ python: string; uv: string }>;
    protocolVersion: number;
    evaluation: Readonly<{
        modality: "text";
        communication: "half-duplex";
        evaluator: "env";
        user: string;
        modelMode: string;
        modelBaseUrl: string | null;
    }>;
}>;

export type TauReportRun = Readonly<{
    domain: string;
    taskSplit: string;
    taskId: string | null;
    trial: number;
    seed: number | null;
    status: "completed" | "failed";
    reward: number | null;
    passed: boolean;
    durationMs: number;
    modelTurns: number;
    toolCalls: number;
    toolCallsByName: Readonly<Record<string, number>>;
    usage: Readonly<{ inputTokens: number; outputTokens: number }>;
    failureCategory: TauFailureCategory;
    error: Readonly<{ code: string; message: string }> | null;
}>;

export type TauReport = Readonly<{
    version: 2;
    benchmarkId: string;
    model: string;
    startedAt: string;
    finishedAt: string;
    reproducibility: TauReproducibilityMetadata;
    results: readonly TauReportRun[];
    tasks: readonly TauTaskSummary[];
    overall: Readonly<{
        runs: number;
        successes: number;
        successRate: number;
        averageReward: number;
        averageDurationMs: number;
        averageToolCalls: number;
        totalModelTurns: number;
        totalToolCalls: number;
        toolCallsByName: Readonly<Record<string, number>>;
        failureCategories: Readonly<Record<string, number>>;
    }>;
}>;

export type TauTaskSummary = Readonly<{
    domain: string;
    taskSplit: string;
    taskId: string | null;
    runs: number;
    successes: number;
    successRate: number;
    passAtK: Readonly<Record<string, number>>;
    averageReward: number;
    averageDurationMs: number;
    averageToolCalls: number;
    failureCategories: Readonly<Record<string, number>>;
}>;

export type TauReportOutput = Readonly<{
    report: TauReport;
    reportPath: string;
    benchmarkDirectory: string;
}>;

function average(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function counts(values: readonly string[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const value of values) {
        result[value] = (result[value] ?? 0) + 1;
    }
    return result;
}

export function classifyTauFailure(error: unknown): {
    category: TauFailureCategory;
    code: string;
    message: string;
} {
    if (error instanceof TauAdapterError) {
        return {
            category: error.code === "model_provider_error" ? "model_provider_error" : "adapter_error",
            code: error.code,
            message: error.message,
        };
    }
    if (error instanceof TauBridgeRemoteError) {
        return {
            category: error.code === "driver_failure" ? "upstream_driver_error" : "bridge_protocol_error",
            code: error.code,
            message: error.message,
        };
    }
    if (error instanceof TauBridgeClientError) {
        const processCodes = new Set([
            "process_start_failed",
            "process_write_failed",
            "process_exited",
            "process_exit_failed",
        ]);
        return {
            category: error.code === "response_timeout"
                ? "timeout"
                : processCodes.has(error.code)
                  ? "bridge_process_error"
                  : "bridge_protocol_error",
            code: error.code,
            message: error.message,
        };
    }
    return {
        category: "unknown_error",
        code: "unknown_error",
        message: error instanceof Error ? error.message : "Unknown tau evaluation failure",
    };
}

export function completedTauRun(
    run: TauRunStart,
    result: TauSessionResult,
): TauReportRun {
    const passed = result.status === "completed" && result.reward === 1;
    return {
        ...run,
        status: result.status,
        reward: result.reward,
        passed,
        durationMs: result.durationMs,
        modelTurns: result.modelTurns,
        toolCalls: result.toolCalls,
        toolCallsByName: structuredClone(result.toolCallsByName),
        usage: structuredClone(result.usage),
        failureCategory: passed ? "none" : "benchmark_reward",
        error: null,
    };
}

export function failedTauRun(
    run: TauRunStart,
    durationMs: number,
    error: unknown,
): TauReportRun {
    const failure = classifyTauFailure(error);
    return {
        ...run,
        status: "failed",
        reward: null,
        passed: false,
        durationMs,
        modelTurns: 0,
        toolCalls: 0,
        toolCallsByName: {},
        usage: { inputTokens: 0, outputTokens: 0 },
        failureCategory: failure.category,
        error: { code: failure.code, message: failure.message },
    };
}

export function buildTauReport(options: Readonly<{
    benchmarkId: string;
    model: string;
    startedAt: Date;
    finishedAt: Date;
    reproducibility: TauReproducibilityMetadata;
    results: readonly TauReportRun[];
}>): TauReport {
    if (options.results.length === 0) {
        throw new Error("Tau report requires at least one run");
    }
    const successes = options.results.filter((result) => result.passed).length;
    const calledTools = options.results.flatMap((result) =>
        Object.entries(result.toolCallsByName).flatMap(([name, count]) =>
            Array.from({ length: count }, () => name),
        ),
    );
    const failures = options.results
        .filter((result) => result.failureCategory !== "none")
        .map((result) => result.failureCategory);
    const taskGroups = new Map<string, TauReportRun[]>();
    for (const result of options.results) {
        const key = `${result.domain}\0${result.taskSplit}\0${result.taskId ?? ""}`;
        const group = taskGroups.get(key) ?? [];
        group.push(result);
        taskGroups.set(key, group);
    }
    const tasks = [...taskGroups.values()].map((taskResults): TauTaskSummary => {
        const first = taskResults[0] as TauReportRun;
        const taskSuccesses = taskResults.filter((result) => result.passed).length;
        const passAtK: Record<string, number> = {};
        for (let k = 1; k <= taskResults.length; k += 1) {
            passAtK[`pass@${k}`] = observedPassAtK(taskResults.length, taskSuccesses, k);
        }
        return {
            domain: first.domain,
            taskSplit: first.taskSplit,
            taskId: first.taskId,
            runs: taskResults.length,
            successes: taskSuccesses,
            successRate: taskSuccesses / taskResults.length,
            passAtK,
            averageReward: average(taskResults.map((result) => result.reward ?? 0)),
            averageDurationMs: average(taskResults.map((result) => result.durationMs)),
            averageToolCalls: average(taskResults.map((result) => result.toolCalls)),
            failureCategories: counts(
                taskResults
                    .filter((result) => result.failureCategory !== "none")
                    .map((result) => result.failureCategory),
            ),
        };
    });
    return {
        version: 2,
        benchmarkId: options.benchmarkId,
        model: options.model,
        startedAt: options.startedAt.toISOString(),
        finishedAt: options.finishedAt.toISOString(),
        reproducibility: structuredClone(options.reproducibility),
        results: structuredClone(options.results),
        tasks,
        overall: {
            runs: options.results.length,
            successes,
            successRate: successes / options.results.length,
            averageReward: average(options.results.map((result) => result.reward ?? 0)),
            averageDurationMs: average(options.results.map((result) => result.durationMs)),
            averageToolCalls: average(options.results.map((result) => result.toolCalls)),
            totalModelTurns: options.results.reduce((sum, result) => sum + result.modelTurns, 0),
            totalToolCalls: options.results.reduce((sum, result) => sum + result.toolCalls, 0),
            toolCallsByName: counts(calledTools),
            failureCategories: counts(failures),
        },
    };
}

export async function writeTauReport(options: Readonly<{
    report: TauReport;
    outputDirectory?: string;
}>): Promise<TauReportOutput> {
    const outputDirectory = resolve(options.outputDirectory ?? ".codetau/tau");
    const benchmarkDirectory = join(outputDirectory, options.report.benchmarkId);
    await mkdir(outputDirectory, { recursive: true });
    await mkdir(benchmarkDirectory, { recursive: false });
    const reportPath = join(benchmarkDirectory, "report.json");
    await writeFile(reportPath, `${JSON.stringify(options.report, null, 2)}\n`, "utf8");
    return { report: options.report, reportPath, benchmarkDirectory };
}

export function nextTauBenchmarkId(now = new Date()): string {
    return `${now.toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
}
