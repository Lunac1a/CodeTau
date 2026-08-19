import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunValidationTool } from "../src/tools/run-validation.ts";

async function withDirectory(
    run: (directory: string) => Promise<void>,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "codetau-validation-"));
    try {
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function nodeCommand(script: string): { executable: string; args: string[] } {
    return { executable: process.execPath, args: ["-e", script] };
}

test("runs only the selected Spec command in the workspace", async () => {
    await withDirectory(async (directory) => {
        const tool = new RunValidationTool({
            workspaceRoot: directory,
            commands: [nodeCommand("console.log(process.cwd());")],
            commandAllowlist: [process.execPath],
            timeoutMs: 2_000,
            maxOutputBytes: 10_000,
        });
        const result = await tool.execute({ commandIndex: 0 });

        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(Reflect.get(result.output as object, "passed"), true);
            assert.match(
                String(Reflect.get(result.output as object, "stdout")),
                /codetau-validation-/,
            );
        }
    });
});

test("returns validation output for a non-zero exit", async () => {
    await withDirectory(async (directory) => {
        const tool = new RunValidationTool({
            workspaceRoot: directory,
            commands: [nodeCommand("console.error('failed'); process.exit(3);")],
            commandAllowlist: [process.execPath],
            timeoutMs: 2_000,
            maxOutputBytes: 10_000,
        });
        const result = await tool.execute({ commandIndex: 0 });

        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(Reflect.get(result.output as object, "passed"), false);
            assert.equal(Reflect.get(result.output as object, "exitCode"), 3);
            assert.match(String(Reflect.get(result.output as object, "stderr")), /failed/);
        }
    });
});

test("enforces executable allowlist, timeout, and output limit", async () => {
    await withDirectory(async (directory) => {
        const denied = new RunValidationTool({
            workspaceRoot: directory,
            commands: [nodeCommand("process.exit(0)")],
            commandAllowlist: [],
            timeoutMs: 2_000,
            maxOutputBytes: 10_000,
        });
        const deniedResult = await denied.execute({ commandIndex: 0 });
        assert.equal(deniedResult.ok, false);
        if (!deniedResult.ok) {
            assert.equal(deniedResult.error.code, "command_not_allowed");
        }

        const timeout = new RunValidationTool({
            workspaceRoot: directory,
            commands: [nodeCommand("setInterval(() => {}, 1000)")],
            commandAllowlist: [process.execPath],
            timeoutMs: 50,
            maxOutputBytes: 10_000,
        });
        const timeoutResult = await timeout.execute({ commandIndex: 0 });
        assert.equal(timeoutResult.ok, true);
        if (timeoutResult.ok) {
            assert.equal(Reflect.get(timeoutResult.output as object, "timedOut"), true);
            assert.equal(Reflect.get(timeoutResult.output as object, "passed"), false);
        }

        const capped = new RunValidationTool({
            workspaceRoot: directory,
            commands: [nodeCommand("process.stdout.write('x'.repeat(10000))")],
            commandAllowlist: [process.execPath],
            timeoutMs: 2_000,
            maxOutputBytes: 100,
        });
        const cappedResult = await capped.execute({ commandIndex: 0 });
        assert.equal(cappedResult.ok, true);
        if (cappedResult.ok) {
            assert.equal(
                Reflect.get(cappedResult.output as object, "outputLimitExceeded"),
                true,
            );
            assert.equal(Reflect.get(cappedResult.output as object, "passed"), false);
        }
    });
});
