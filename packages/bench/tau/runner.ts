import type { TauSessionResult } from "./adapter.ts";
import type { TauRunStart } from "./client.ts";
import {
    buildTauReport,
    completedTauRun,
    failedTauRun,
    nextTauBenchmarkId,
    writeTauReport,
    type TauReportOutput,
    type TauReportRun,
    type TauReproducibilityMetadata,
} from "./report.ts";

export type TauEvaluationTask = Readonly<{
    domain: string;
    taskSplit: string;
    taskId: string;
}>;

export type TauEvaluationRunnerOptions = Readonly<{
    tasks: readonly TauEvaluationTask[];
    runsPerTask: number;
    baseSeed: number;
    model: string;
    reproducibility: TauReproducibilityMetadata;
    runSession(run: TauRunStart): Promise<TauSessionResult>;
    outputDirectory?: string;
    now?: () => Date;
    nextBenchmarkId?: (startedAt: Date) => string;
    onProgress?: (message: string) => void;
}>;

function validate(options: TauEvaluationRunnerOptions): void {
    if (options.tasks.length === 0) {
        throw new Error("Tau evaluation requires at least one task");
    }
    if (!Number.isSafeInteger(options.runsPerTask) || options.runsPerTask < 1 || options.runsPerTask > 100) {
        throw new Error("Tau runs must be an integer between 1 and 100");
    }
    if (!Number.isSafeInteger(options.baseSeed) || options.baseSeed < 0) {
        throw new Error("Tau base seed must be a non-negative integer");
    }
    const keys = options.tasks.map((task) => `${task.domain}\0${task.taskSplit}\0${task.taskId}`);
    if (new Set(keys).size !== keys.length) {
        throw new Error("Tau evaluation tasks must be unique");
    }
}

export async function runTauEvaluation(
    options: TauEvaluationRunnerOptions,
): Promise<TauReportOutput> {
    validate(options);
    const now = options.now ?? (() => new Date());
    const startedAt = now();
    const benchmarkId = options.nextBenchmarkId?.(startedAt) ?? nextTauBenchmarkId(startedAt);
    const results: TauReportRun[] = [];

    for (let taskIndex = 0; taskIndex < options.tasks.length; taskIndex += 1) {
        const task = options.tasks[taskIndex] as TauEvaluationTask;
        for (let trial = 1; trial <= options.runsPerTask; trial += 1) {
            const run: TauRunStart = {
                ...task,
                trial,
                seed: options.baseSeed + taskIndex * options.runsPerTask + trial - 1,
            };
            options.onProgress?.(
                `Starting ${task.taskId} trial ${trial}/${options.runsPerTask} (seed ${run.seed})`,
            );
            const runStartedAt = now().getTime();
            try {
                results.push(completedTauRun(run, await options.runSession(run)));
            } catch (error) {
                results.push(failedTauRun(run, now().getTime() - runStartedAt, error));
            }
            const result = results.at(-1) as TauReportRun;
            options.onProgress?.(
                `Finished ${task.taskId} trial ${trial}/${options.runsPerTask}: ${result.failureCategory}`,
            );
        }
    }

    const report = buildTauReport({
        benchmarkId,
        model: options.model,
        startedAt,
        finishedAt: now(),
        reproducibility: options.reproducibility,
        results,
    });
    return await writeTauReport({ report, outputDirectory: options.outputDirectory });
}
