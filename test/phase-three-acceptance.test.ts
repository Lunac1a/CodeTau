import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    resumeAgentLoop,
    runAgentLoop,
    type AgentLoopRuntime,
} from "../src/agent-loop/run.ts";
import { InMemoryEventStore } from "../src/persistence/in-memory-event-store.ts";
import { ApplyPatchTool } from "../src/tools/apply-patch.ts";
import { RunValidationTool } from "../src/tools/run-validation.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { WorkspaceSandbox } from "../src/workspace/sandbox.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";
import { createTestSpec } from "./fixtures/spec.ts";

function runtime(prefix: string): AgentLoopRuntime {
    let eventNumber = 0;
    return {
        nextEventId: () => `${prefix}-${++eventNumber}`,
        now: () => "2026-08-19T00:00:00.000Z",
    };
}

test("phase three: approved patch plus all validations can complete the task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-phase-three-"));
    const sourceDirectory = join(directory, "src");
    const filePath = join(sourceDirectory, "answer.txt");
    await mkdir(sourceDirectory);
    await writeFile(filePath, "41\n", "utf8");
    const validationCommands = [
        {
            executable: process.execPath,
            args: [
                "-e",
                "const fs=require('node:fs');process.exit(fs.readFileSync('src/answer.txt','utf8')==='42\\n'?0:1)",
            ],
        },
        {
            executable: process.execPath,
            args: ["-e", "process.stdout.write('second validation passed')"],
        },
    ];
    const spec = createTestSpec({
        id: "spec.phase-three",
        maxModelTurns: 6,
        acceptanceCommands: validationCommands,
    });
    const sandbox = await WorkspaceSandbox.create(directory, ["src/**"]);
    const registry = new ToolRegistry([
        new ApplyPatchTool(sandbox),
        new RunValidationTool({
            workspaceRoot: sandbox.workspaceRoot(),
            commands: validationCommands,
            commandAllowlist: [process.execPath],
            timeoutMs: 2_000,
            maxOutputBytes: 10_000,
        }),
    ]);
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [
                {
                    id: "phase-three-patch",
                    name: "apply_patch",
                    input: {
                        path: "src/answer.txt",
                        edits: [{ oldText: "41", newText: "42" }],
                    },
                },
            ],
            usage: { inputTokens: 20, outputTokens: 8 },
        },
        {
            kind: "tool_calls",
            calls: [
                {
                    id: "phase-three-validation-1",
                    name: "run_validation",
                    input: { commandIndex: 0 },
                },
            ],
            usage: { inputTokens: 30, outputTokens: 6 },
        },
        {
            kind: "tool_calls",
            calls: [
                {
                    id: "phase-three-validation-2",
                    name: "run_validation",
                    input: { commandIndex: 1 },
                },
            ],
            usage: { inputTokens: 35, outputTokens: 6 },
        },
        {
            kind: "finish",
            outcome: "completed",
            message: "The approved change passed every validation command.",
            usage: { inputTokens: 40, outputTokens: 8 },
        },
    ]);

    try {
        const patchApproval = await runAgentLoop({
            sessionId: "session-phase-three",
            spec,
            model,
            eventStore: store,
            toolRegistry: registry,
            runtime: runtime("phase-three-start"),
        });
        assert.equal(patchApproval.status, "awaiting_approval");
        assert.equal(await readFile(filePath, "utf8"), "41\n");

        const validationApproval = await resumeAgentLoop({
            sessionId: "session-phase-three",
            spec,
            model,
            eventStore: store,
            toolRegistry: registry,
            approvalResponse: "allow-once",
            runtime: runtime("phase-three-patch-resume"),
        });
        assert.equal(validationApproval.status, "awaiting_approval");
        assert.equal(validationApproval.pendingApproval?.toolName, "run_validation");
        assert.equal(await readFile(filePath, "utf8"), "42\n");

        const completed = await resumeAgentLoop({
            sessionId: "session-phase-three",
            spec,
            model,
            eventStore: store,
            toolRegistry: registry,
            approvalResponse: "allow-session",
            runtime: runtime("phase-three-validation-resume"),
        });
        const events = await store.loadSession("session-phase-three");

        assert.equal(completed.status, "completed");
        assert.equal(completed.final?.status, "completed");
        assert.equal(
            events.filter(
                (event) =>
                    event.type === "tool_result" &&
                    event.result.ok &&
                    typeof event.result.output === "object" &&
                    event.result.output !== null &&
                    Reflect.get(event.result.output, "passed") === true,
            ).length,
            2,
        );
    } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("validation failures are fed back and bounded by maxRetries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-validation-retry-"));
    const validationCommands = [
        {
            executable: process.execPath,
            args: ["-e", "console.error('still failing');process.exit(2)"],
        },
    ];
    const spec = createTestSpec({
        id: "spec.validation-retry",
        maxModelTurns: 4,
        maxRetries: 1,
        acceptanceCommands: validationCommands,
    });
    const registry = new ToolRegistry([
        new RunValidationTool({
            workspaceRoot: directory,
            commands: validationCommands,
            commandAllowlist: [process.execPath],
            timeoutMs: 2_000,
            maxOutputBytes: 10_000,
        }),
    ]);
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [
                { id: "failed-validation-1", name: "run_validation", input: { commandIndex: 0 } },
            ],
            usage: { inputTokens: 10, outputTokens: 4 },
        },
        {
            kind: "tool_calls",
            calls: [
                { id: "failed-validation-2", name: "run_validation", input: { commandIndex: 0 } },
            ],
            usage: { inputTokens: 15, outputTokens: 4 },
        },
    ]);

    try {
        await runAgentLoop({
            sessionId: "session-validation-retry",
            spec,
            model,
            eventStore: store,
            toolRegistry: registry,
            runtime: runtime("validation-retry-start"),
        });
        const failed = await resumeAgentLoop({
            sessionId: "session-validation-retry",
            spec,
            model,
            eventStore: store,
            toolRegistry: registry,
            approvalResponse: "allow-session",
            runtime: runtime("validation-retry-resume"),
        });
        const events = await store.loadSession("session-validation-retry");

        assert.equal(failed.status, "failed");
        assert.ok(
            events.some(
                (event) =>
                    event.type === "budget_exhausted" && event.budget === "retries",
            ),
        );
        assert.match(model.requests[1].messages.at(-1)?.content ?? "", /still failing/);
    } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    }
});
