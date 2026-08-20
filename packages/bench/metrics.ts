import type {
    BenchRunResult,
    BenchTaskSummary,
} from "./types.ts";

function combination(n: number, k: number): number {
    if (k < 0 || k > n) {
        return 0;
    }
    const effectiveK = Math.min(k, n - k);
    let result = 1;
    for (let index = 1; index <= effectiveK; index += 1) {
        result = (result * (n - effectiveK + index)) / index;
    }
    return result;
}

export function observedPassAtK(
    runs: number,
    successes: number,
    k: number,
): number {
    if (
        !Number.isInteger(runs) ||
        !Number.isInteger(successes) ||
        !Number.isInteger(k) ||
        runs <= 0 ||
        successes < 0 ||
        successes > runs ||
        k <= 0 ||
        k > runs
    ) {
        throw new Error("pass@k inputs are invalid");
    }
    return 1 - combination(runs - successes, k) / combination(runs, k);
}

function average(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeTask(
    taskId: string,
    results: readonly BenchRunResult[],
): BenchTaskSummary {
    if (results.length === 0 || results.some((result) => result.taskId !== taskId)) {
        throw new Error(`Cannot summarize missing or mixed results for task: ${taskId}`);
    }
    const successes = results.filter((result) => result.passed).length;
    const passAtK: Record<string, number> = {};
    for (let k = 1; k <= results.length; k += 1) {
        passAtK[`pass@${k}`] = observedPassAtK(results.length, successes, k);
    }
    return {
        taskId,
        runs: results.length,
        successes,
        successRate: successes / results.length,
        passAtK,
        averageDurationMs: average(results.map((result) => result.durationMs)),
        averageToolCalls: average(results.map((result) => result.toolCalls)),
    };
}
