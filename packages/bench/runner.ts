import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { stringify } from "yaml";

import type { CodeTauConfig } from "../../src/config/loader.ts";
import type { TaskState } from "../../src/events.ts";
import type { ModelProvider } from "../../src/model.ts";
import { SQLiteEventStore } from "../../src/persistence/sqlite-event-store.ts";
import { loadSpec } from "../../src/spec/loader.ts";
import { SessionRunner } from "../../src/session/runner.ts";
import type { AgentEvent } from "../../src/types.ts";
import { countFailureCategories, summarizeTask } from "./metrics.ts";
import type {
    BenchFailureCategory,
    BenchManifest,
    BenchReport,
    BenchRunResult,
    BenchTask,
} from "./types.ts";

export type BenchRunnerOptions = Readonly<{
    config: CodeTauConfig;
    manifest: BenchManifest;
    runsPerTask: number;
    taskId?: string;
    outputDirectory?: string;
    model?: ModelProvider;
    now?: () => Date;
    nextBenchmarkId?: () => string;
    onProgress?: (message: string) => void;
}>;

export type BenchRunOutput = Readonly<{
    report: BenchReport;
    reportPath: string;
    benchmarkDirectory: string;
}>;

function validateRuns(runs: number): void {
    if (!Number.isSafeInteger(runs) || runs <= 0 || runs > 100) {
        throw new Error("Bench runs must be an integer between 1 and 100");
    }
}

function selectTasks(
    manifest: BenchManifest,
    taskId: string | undefined,
): readonly BenchTask[] {
    if (taskId === undefined) {
        return manifest.tasks;
    }
    const task = manifest.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
        throw new Error(`Bench task not found: ${taskId}`);
    }
    return [task];
}

function benchmarkId(now: Date): string {
    return `${now.toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
}

function materializedSpecSource(
    contract: object,
    context: string,
): string {
    return `---\n${stringify(contract).trimEnd()}\n---\n${context}`;
}

function terminalState(state: TaskState): asserts state is TaskState & {
    status: "completed" | "failed" | "blocked";
    final: NonNullable<TaskState["final"]>;
} {
    if (
        (state.status !== "completed" &&
            state.status !== "failed" &&
            state.status !== "blocked") ||
        state.final === undefined
    ) {
        throw new Error(`Bench Session did not reach a terminal state: ${state.sessionId}`);
    }
}

function countValidationCalls(events: readonly AgentEvent[]): number {
    return events.filter(
        (event) =>
            event.type === "model_tool_call" &&
            event.toolCall.name === "run_validation",
    ).length;
}

function toolNamesByCallId(events: readonly AgentEvent[]): Map<string, string> {
    const names = new Map<string, string>();
    for (const event of events) {
        if (event.type === "model_tool_call") {
            names.set(event.toolCall.id, event.toolCall.name);
        }
    }
    return names;
}

function validationPassed(output: unknown): boolean | undefined {
    if (typeof output !== "object" || output === null) {
        return undefined;
    }
    const passed = Reflect.get(output, "passed");
    return typeof passed === "boolean" ? passed : undefined;
}

function runDiagnostics(events: readonly AgentEvent[]) {
    const toolNames = toolNamesByCallId(events);
    let toolErrors = 0;
    let patchFailures = 0;
    let failedValidations = 0;
    let repeatedToolCalls = 0;
    for (const event of events) {
        if (event.type !== "tool_result") {
            continue;
        }
        const toolName = toolNames.get(event.toolCallId);
        if (!event.result.ok) {
            toolErrors += 1;
            if (event.result.error.code === "repeated_failed_tool_call") {
                repeatedToolCalls += 1;
            }
            if (toolName === "apply_patch") {
                patchFailures += 1;
            }
        } else if (
            toolName === "run_validation" &&
            validationPassed(event.result.output) === false
        ) {
            failedValidations += 1;
        }
    }
    return { toolErrors, patchFailures, failedValidations, repeatedToolCalls };
}

function failureCategory(
    status: "completed" | "failed" | "blocked",
    events: readonly AgentEvent[],
): BenchFailureCategory {
    if (status === "completed") {
        return "none";
    }
    const exhausted = [...events].reverse().find(
        (event): event is Extract<AgentEvent, { type: "budget_exhausted" }> =>
            event.type === "budget_exhausted",
    );
    if (exhausted?.budget === "model_turns") {
        return "model_turn_budget";
    }
    if (exhausted?.budget === "tool_calls") {
        return "tool_call_budget";
    }
    if (exhausted?.budget === "retries") {
        return "validation_retry_budget";
    }
    if (
        events.some(
            (event) =>
                event.type === "tool_result" &&
                !event.result.ok &&
                event.result.error.code === "repeated_failed_tool_call",
        )
    ) {
        return "repeated_tool_call";
    }
    if (events.some((event) => event.type === "model_error")) {
        return "model_provider_error";
    }
    if (status === "blocked") {
        return "blocked";
    }
    if (runDiagnostics(events).failedValidations > 0) {
        return "validation_failure";
    }
    return "agent_failure";
}

function resultFrom(options: {
    taskId: string;
    runNumber: number;
    state: TaskState & {
        status: "completed" | "failed" | "blocked";
        final: NonNullable<TaskState["final"]>;
    };
    durationMs: number;
    events: readonly AgentEvent[];
}): BenchRunResult {
    const started = options.events.find(
        (event): event is Extract<AgentEvent, { type: "session_started" }> =>
            event.type === "session_started",
    );
    if (started === undefined) {
        throw new Error(`Bench Session is missing session_started: ${options.state.sessionId}`);
    }
    return {
        taskId: options.taskId,
        specDigest: started.specDigest,
        runNumber: options.runNumber,
        sessionId: options.state.sessionId,
        status: options.state.status,
        passed: options.state.status === "completed",
        durationMs: options.durationMs,
        toolCalls: options.events.filter(
            (event) => event.type === "model_tool_call",
        ).length,
        approvals: options.events.filter(
            (event) => event.type === "approval_resolved",
        ).length,
        validationCalls: countValidationCalls(options.events),
        failureCategory: failureCategory(options.state.status, options.events),
        diagnostics: runDiagnostics(options.events),
        finalMessage: options.state.final.message,
    };
}

function average(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function runBench(options: BenchRunnerOptions): Promise<BenchRunOutput> {
    validateRuns(options.runsPerTask);
    const tasks = selectTasks(options.manifest, options.taskId);
    const now = options.now ?? (() => new Date());
    const startedAt = now();
    const id = options.nextBenchmarkId?.() ?? benchmarkId(startedAt);
    if (!/^[A-Za-z0-9_-]+$/u.test(id)) {
        throw new Error("Benchmark id may contain only letters, numbers, _ and -");
    }
    const outputDirectory = resolve(
        options.outputDirectory ??
            join(options.config.rootDirectory, ".codetau", "bench"),
    );
    const benchmarkDirectory = join(outputDirectory, id);
    await mkdir(outputDirectory, { recursive: true });
    await mkdir(benchmarkDirectory, { recursive: false });
    const eventStore = new SQLiteEventStore(join(benchmarkDirectory, "bench.db"));
    const results: BenchRunResult[] = [];

    try {
        for (const task of tasks) {
            const sourceSpecPath = resolve(
                options.config.rootDirectory,
                task.specPath,
            );
            const sourceSpec = await loadSpec(sourceSpecPath);
            const sourceWorkspace = resolve(
                options.config.rootDirectory,
                sourceSpec.contract.workspace.root,
            );

            for (let runNumber = 1; runNumber <= options.runsPerTask; runNumber += 1) {
                options.onProgress?.(
                    `Starting ${task.id} run ${runNumber}/${options.runsPerTask}`,
                );
                const runDirectory = join(
                    benchmarkDirectory,
                    "runs",
                    task.id,
                    String(runNumber),
                );
                const workspaceDirectory = join(runDirectory, "workspace");
                await mkdir(runDirectory, { recursive: true });
                await cp(sourceWorkspace, workspaceDirectory, {
                    recursive: true,
                    errorOnExist: true,
                    force: false,
                });

                const materializedContract = structuredClone(sourceSpec.contract);
                materializedContract.workspace.root = "workspace";
                const specPath = join(runDirectory, "task.md");
                await writeFile(
                    specPath,
                    materializedSpecSource(
                        materializedContract,
                        sourceSpec.context,
                    ),
                    "utf8",
                );

                const runConfig: CodeTauConfig = {
                    ...options.config,
                    databasePath: join(benchmarkDirectory, "bench.db"),
                    rootDirectory: runDirectory,
                };
                const runner = new SessionRunner({
                    config: runConfig,
                    eventStore,
                    model: options.model,
                });
                const sessionId = `bench-${id}-${task.id}-${runNumber}`;
                const runStartedAt = Date.now();
                let state = await runner.run({ specPath, sessionId });
                const maximumApprovals =
                    materializedContract.budget.maxModelTurns +
                    materializedContract.budget.maxToolCalls +
                    1;
                let approvalCount = 0;
                while (state.status === "awaiting_approval") {
                    approvalCount += 1;
                    if (approvalCount > maximumApprovals) {
                        throw new Error(`Bench approval loop exceeded its bound: ${sessionId}`);
                    }
                    state = await runner.resume({
                        sessionId,
                        approvalResponse: "allow-session",
                    });
                }
                terminalState(state);
                const events = await eventStore.loadSession(sessionId);
                results.push(
                    resultFrom({
                        taskId: task.id,
                        runNumber,
                        state,
                        durationMs: Date.now() - runStartedAt,
                        events,
                    }),
                );
                options.onProgress?.(
                    `Finished ${task.id} run ${runNumber}/${options.runsPerTask}: ${state.status}`,
                );
            }
        }
    } finally {
        await eventStore.close();
    }

    const taskSummaries = tasks.map((task) =>
        summarizeTask(
            task.id,
            results.filter((result) => result.taskId === task.id),
        ),
    );
    const successes = results.filter((result) => result.passed).length;
    const report: BenchReport = {
        version: 1,
        benchmarkId: id,
        model: options.config.model,
        startedAt: startedAt.toISOString(),
        finishedAt: now().toISOString(),
        runsPerTask: options.runsPerTask,
        results,
        tasks: taskSummaries,
        overall: {
            runs: results.length,
            successes,
            successRate: successes / results.length,
            averageDurationMs: average(results.map((result) => result.durationMs)),
            averageToolCalls: average(results.map((result) => result.toolCalls)),
            failureCategories: countFailureCategories(results),
            toolErrors: results.reduce(
                (sum, result) => sum + result.diagnostics.toolErrors,
                0,
            ),
            patchFailures: results.reduce(
                (sum, result) => sum + result.diagnostics.patchFailures,
                0,
            ),
            failedValidations: results.reduce(
                (sum, result) => sum + result.diagnostics.failedValidations,
                0,
            ),
            repeatedToolCalls: results.reduce(
                (sum, result) => sum + result.diagnostics.repeatedToolCalls,
                0,
            ),
        },
    };
    const reportPath = join(benchmarkDirectory, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { report, reportPath, benchmarkDirectory };
}
