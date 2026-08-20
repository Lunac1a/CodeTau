import type { TerminalStatus } from "../../src/events.ts";

export type BenchTask = Readonly<{
    id: string;
    specPath: string;
}>;

export type BenchManifest = Readonly<{
    version: 1;
    tasks: readonly BenchTask[];
}>;

export type BenchRunResult = Readonly<{
    taskId: string;
    runNumber: number;
    sessionId: string;
    status: TerminalStatus;
    passed: boolean;
    durationMs: number;
    toolCalls: number;
    approvals: number;
    validationCalls: number;
    finalMessage: string;
}>;

export type BenchTaskSummary = Readonly<{
    taskId: string;
    runs: number;
    successes: number;
    successRate: number;
    passAtK: Readonly<Record<string, number>>;
    averageDurationMs: number;
    averageToolCalls: number;
}>;

export type BenchReport = Readonly<{
    version: 1;
    benchmarkId: string;
    model: string;
    startedAt: string;
    finishedAt: string;
    runsPerTask: number;
    results: readonly BenchRunResult[];
    tasks: readonly BenchTaskSummary[];
    overall: Readonly<{
        runs: number;
        successes: number;
        successRate: number;
        averageDurationMs: number;
        averageToolCalls: number;
    }>;
}>;
