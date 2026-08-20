import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseBenchArgs } from "../packages/bench/main.ts";
import { runBench } from "../packages/bench/runner.ts";
import type { CodeTauConfig } from "../src/config/loader.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";

function configFor(directory: string): CodeTauConfig {
    return {
        databasePath: join(directory, ".codetau", "main.db"),
        model: "fake-bench-model",
        baseUrl: "http://localhost:1234/v1",
        commandAllowlist: [],
        commandTimeoutMs: 1_000,
        maxOutputBytes: 1_000,
        sourcePath: join(directory, "codetau.config.json"),
        rootDirectory: directory,
    };
}

async function createTask(directory: string): Promise<void> {
    await mkdir(join(directory, "fixture", "src"), { recursive: true });
    await mkdir(join(directory, "specs"), { recursive: true });
    await writeFile(join(directory, "fixture", "src", "value.txt"), "original", "utf8");
    await writeFile(
        join(directory, "specs", "task.md"),
        [
            "---",
            "version: 1",
            "id: test.bench",
            "goal: Exercise an isolated Bench run.",
            "workspace:",
            "  root: fixture",
            "  allowedPaths: [src/**]",
            "policy:",
            "  forbiddenActions: [network-access]",
            "acceptance:",
            "  commands: []",
            "  assertions: []",
            "phases:",
            "  - id: finish",
            "    description: Finish the task.",
            "budget:",
            "  maxModelTurns: 2",
            "  maxToolCalls: 0",
            "  maxRetries: 0",
            "userInteraction:",
            "  allowQuestions: false",
            "  approvalResponses: [deny]",
            "---",
            "",
            "Finish immediately.",
        ].join("\n"),
        "utf8",
    );
}

test("runs repeated tasks in separate copied workspaces and writes a report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-bench-runner-"));
    try {
        await createTask(directory);
        const model = new FakeModelProvider([
            {
                kind: "finish",
                outcome: "blocked",
                message: "Run one stopped without validation.",
                usage: { inputTokens: 5, outputTokens: 2 },
            },
            {
                kind: "finish",
                outcome: "blocked",
                message: "Run two stopped without validation.",
                usage: { inputTokens: 5, outputTokens: 2 },
            },
        ]);

        const output = await runBench({
            config: configFor(directory),
            manifest: {
                version: 1,
                tasks: [{ id: "isolated", specPath: "specs/task.md" }],
            },
            runsPerTask: 2,
            outputDirectory: join(directory, "bench-output"),
            model,
            nextBenchmarkId: () => "bench-test",
            now: () => new Date("2026-08-20T00:00:00.000Z"),
        });

        assert.equal(output.report.overall.runs, 2);
        assert.equal(output.report.overall.successes, 0);
        assert.equal(output.report.tasks[0].passAtK["pass@1"], 0);
        assert.deepEqual(
            output.report.results.map((result) => result.status),
            ["blocked", "blocked"],
        );
        await access(output.reportPath);
        assert.equal(
            await readFile(
                join(output.benchmarkDirectory, "runs", "isolated", "1", "workspace", "src", "value.txt"),
                "utf8",
            ),
            "original",
        );
        assert.equal(
            await readFile(join(directory, "fixture", "src", "value.txt"), "utf8"),
            "original",
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("parses Bench CLI options including pnpm's separator", () => {
    assert.deepEqual(
        parseBenchArgs(
            ["--", "--runs", "3", "--task", "fix-greeting"],
            "C:\\repo",
        ),
        {
            configPath: "C:\\repo\\codetau.config.json",
            manifestPath: "C:\\repo\\packages\\bench\\manifest.json",
            runs: 3,
            taskId: "fix-greeting",
        },
    );
});
