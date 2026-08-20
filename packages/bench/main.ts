import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadCodeTauConfig } from "../../src/config/loader.ts";
import { loadBenchManifest } from "./manifest.ts";
import { runBench } from "./runner.ts";

export type BenchCliOptions = Readonly<{
    configPath: string;
    manifestPath: string;
    runs: number;
    taskId?: string;
}>;

export const benchUsage = [
    "Usage: codetau-bench [--runs <count>] [--task <task-id>]",
    "                     [--manifest <path>] [--config <path>]",
].join("\n");

export function parseBenchArgs(
    argv: readonly string[],
    cwd = process.cwd(),
): BenchCliOptions {
    const args = argv[0] === "--" ? argv.slice(1) : [...argv];
    let configPath = resolve(cwd, "codetau.config.json");
    let manifestPath = resolve(cwd, "packages", "bench", "manifest.json");
    let runs = 1;
    let taskId: string | undefined;

    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (value === undefined || value.trim() === "") {
            throw new Error(benchUsage);
        }
        if (flag === "--runs") {
            runs = Number(value);
        } else if (flag === "--task") {
            taskId = value;
        } else if (flag === "--manifest") {
            manifestPath = resolve(cwd, value);
        } else if (flag === "--config") {
            configPath = resolve(cwd, value);
        } else {
            throw new Error(benchUsage);
        }
    }
    if (!Number.isSafeInteger(runs) || runs <= 0 || runs > 100) {
        throw new Error("--runs must be an integer between 1 and 100");
    }
    return { configPath, manifestPath, runs, taskId };
}

export async function main(): Promise<void> {
    try {
        const options = parseBenchArgs(process.argv.slice(2));
        const [config, manifest] = await Promise.all([
            loadCodeTauConfig(options.configPath),
            loadBenchManifest(options.manifestPath),
        ]);
        const output = await runBench({
            config,
            manifest,
            runsPerTask: options.runs,
            taskId: options.taskId,
            onProgress: (message) => process.stdout.write(`${message}\n`),
        });
        const percentage = (output.report.overall.successRate * 100).toFixed(1);
        process.stdout.write(
            [
                `Benchmark: ${output.report.benchmarkId}`,
                `Model: ${output.report.model}`,
                `Runs: ${output.report.overall.runs}`,
                `Passed: ${output.report.overall.successes}`,
                `Success rate: ${percentage}%`,
                `Report: ${output.reportPath}`,
                "",
            ].join("\n"),
        );
    } catch (error) {
        process.stderr.write(
            `${error instanceof Error ? error.message : "Unknown Bench error"}\n`,
        );
        process.exitCode = 1;
    }
}

const entryPath = process.argv[1];
if (
    entryPath !== undefined &&
    import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
    await main();
}
