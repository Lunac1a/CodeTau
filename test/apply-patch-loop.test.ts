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

test("apply_patch changes a file only after Agent loop approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-patch-loop-"));
    const sourceDirectory = join(directory, "src");
    const filePath = join(sourceDirectory, "answer.ts");
    await mkdir(sourceDirectory);
    await writeFile(filePath, "export const answer = 41;\n", "utf8");
    const sandbox = await WorkspaceSandbox.create(directory, ["src/**"]);
    const registry = new ToolRegistry([new ApplyPatchTool(sandbox)]);
    const store = new InMemoryEventStore();
    const spec = createTestSpec({ id: "spec.patch-loop" });
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [
                {
                    id: "patch-call-1",
                    name: "apply_patch",
                    input: {
                        path: "src/answer.ts",
                        edits: [
                            { oldText: "answer = 41", newText: "answer = 42" },
                        ],
                    },
                },
            ],
            usage: { inputTokens: 20, outputTokens: 10 },
        },
        {
            kind: "finish",
            outcome: "blocked",
            message: "The patch was applied and now requires validation.",
            usage: { inputTokens: 30, outputTokens: 8 },
        },
    ]);

    try {
        const pending = await runAgentLoop({
            sessionId: "session-patch-loop",
            spec,
            model,
            eventStore: store,
            toolRegistry: registry,
            runtime: runtime("patch-loop-event"),
        });

        assert.equal(pending.status, "awaiting_approval");
        assert.equal(await readFile(filePath, "utf8"), "export const answer = 41;\n");

        const state = await resumeAgentLoop({
            sessionId: "session-patch-loop",
            spec,
            model,
            eventStore: store,
            toolRegistry: registry,
            approvalResponse: "allow-once",
            runtime: runtime("patch-loop-resume"),
        });
        const events = await store.loadSession("session-patch-loop");

        assert.equal(state.status, "blocked");
        assert.equal(await readFile(filePath, "utf8"), "export const answer = 42;\n");
        assert.ok(
            events.some(
                (event) =>
                    event.type === "tool_result" &&
                    event.toolCallId === "patch-call-1" &&
                    event.result.ok,
            ),
        );
    } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    }
});
