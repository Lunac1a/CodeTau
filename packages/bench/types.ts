import type { TerminalStatus } from "../../src/events.ts";

export type BenchTask = Readonly<{
    id: string;
    specPath: string;
}>;

export type BenchManifest = Readonly<{
    version: 1;
    tasks: readonly BenchTask[];
}>;

export type BenchFailureCategory =
    | "none"
    | "blocked"
    | "model_turn_budget"
    | "tool_call_budget"
    | "validation_retry_budget"
    | "repeated_tool_call"
    | "model_provider_error"
    | "validation_failure"
    | "agent_failure";

export type BenchRunDiagnostics = Readonly<{
    toolErrors: number;
    patchFailures: number;
    failedValidations: number;
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
    failureCategory: BenchFailureCategory;
    diagnostics: BenchRunDiagnostics;
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
    failureCategories: Readonly<Record<string, number>>;
    toolErrors: number;
    patchFailures: number;
    failedValidations: number;
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
        failureCategories: Readonly<Record<string, number>>;
        toolErrors: number;
        patchFailures: number;
        failedValidations: number;
    }>;
}>;
