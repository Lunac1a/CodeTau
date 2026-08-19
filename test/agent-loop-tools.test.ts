import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    resumeAgentLoop,
    runAgentLoop,
    type AgentLoopRuntime,
} from "../src/agent-loop/run.ts";
import { InMemoryEventStore } from "../src/persistence/in-memory-event-store.ts";
import { ReadFileTool } from "../src/tools/read-file.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { AgentTool } from "../src/tools/tool.ts";
import type { AgentEvent } from "../src/types.ts";
import { WorkspaceSandbox } from "../src/workspace/sandbox.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";
import { createSessionStartedEvent, createTestSpec } from "./fixtures/spec.ts";

function createRuntime(prefix: string): AgentLoopRuntime {
    let eventNumber = 0;
    return {
        nextEventId: () => `${prefix}-${++eventNumber}`,
        now: () => "2026-08-19T00:00:00.000Z",
    };
}

test("executes read_file and returns its recorded result to the model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-loop-tools-"));
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "answer.txt"), "forty-two", "utf8");
    const sandbox = await WorkspaceSandbox.create(directory, ["src/**"]);
    const registry = new ToolRegistry([new ReadFileTool(sandbox)]);
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [
                {
                    id: "read-call-1",
                    name: "read_file",
                    input: { path: "src/answer.txt" },
                },
            ],
            usage: { inputTokens: 20, outputTokens: 8 },
        },
        {
            kind: "finish",
            outcome: "blocked",
            message: "The file was inspected successfully.",
            usage: { inputTokens: 30, outputTokens: 6 },
        },
    ]);

    try {
        const state = await runAgentLoop({
            sessionId: "session-read-tool",
            spec: createTestSpec(),
            model,
            eventStore: store,
            toolRegistry: registry,
            runtime: createRuntime("read-event"),
        });
        const events = await store.loadSession("session-read-tool");
        const resultEvent = events.find(
            (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
                event.type === "tool_result",
        );

        assert.equal(state.status, "blocked");
        assert.deepEqual(model.requests[0].availableToolNames, ["read_file"]);
        assert.equal(model.requests[1].messages.at(-1)?.role, "tool");
        assert.equal(model.requests[1].messages.at(-1)?.toolCallId, "read-call-1");
        assert.match(model.requests[1].messages.at(-1)?.content ?? "", /forty-two/);
        assert.equal(resultEvent?.toolCallId, "read-call-1");
        assert.equal(resultEvent?.result.ok, true);
    } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("records a forbidden tool result without executing the tool", async () => {
    let executed = false;
    const forbiddenTool: AgentTool = {
        name: "fetch_url",
        permission: { action: "network-access", risk: "read" },
        async execute() {
            executed = true;
            return { ok: true, output: "unexpected" };
        },
    };
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [{ id: "network-1", name: "fetch_url", input: {} }],
            usage: { inputTokens: 10, outputTokens: 4 },
        },
        {
            kind: "finish",
            outcome: "blocked",
            message: "Network access is forbidden.",
            usage: { inputTokens: 15, outputTokens: 4 },
        },
    ]);

    try {
        await runAgentLoop({
            sessionId: "session-forbidden-tool",
            spec: createTestSpec(),
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([forbiddenTool]),
            runtime: createRuntime("forbidden-event"),
        });
        const result = (await store.loadSession("session-forbidden-tool")).find(
            (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
                event.type === "tool_result",
        );

        assert.equal(executed, false);
        assert.deepEqual(result?.result, {
            ok: false,
            error: {
                code: "action_forbidden",
                message: "Action is forbidden by the task Spec: network-access",
            },
        });
    } finally {
        await store.close();
    }
});

test("returns approval_required without executing a write tool", async () => {
    let executed = false;
    const writeTool: AgentTool = {
        name: "write_file",
        permission: { action: "workspace-write", risk: "write" },
        async execute() {
            executed = true;
            return { ok: true, output: "unexpected" };
        },
    };
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [{ id: "write-1", name: "write_file", input: {} }],
            usage: { inputTokens: 10, outputTokens: 4 },
        },
        {
            kind: "finish",
            outcome: "blocked",
            message: "Write approval is required.",
            usage: { inputTokens: 15, outputTokens: 4 },
        },
    ]);

    try {
        await runAgentLoop({
            sessionId: "session-write-approval",
            spec: createTestSpec(),
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([writeTool]),
            runtime: createRuntime("write-event"),
        });
        const result = (await store.loadSession("session-write-approval")).find(
            (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
                event.type === "tool_result",
        );

        assert.equal(executed, false);
        assert.equal(result?.result.ok, false);
        if (result?.result.ok === false) {
            assert.equal(result.result.error.code, "approval_required");
            assert.deepEqual(result.result.error.details, {
                allowedResponses: ["allow-once", "allow-session", "deny"],
            });
        }
    } finally {
        await store.close();
    }
});

test("stops before executing a tool call beyond the Spec budget", async () => {
    let executions = 0;
    const echoTool: AgentTool = {
        name: "echo",
        permission: { action: "workspace-read", risk: "read" },
        async execute(input) {
            executions += 1;
            return { ok: true, output: input };
        },
    };
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [
                { id: "echo-budget-1", name: "echo", input: 1 },
                { id: "echo-budget-2", name: "echo", input: 2 },
            ],
            usage: { inputTokens: 10, outputTokens: 5 },
        },
    ]);

    try {
        const state = await runAgentLoop({
            sessionId: "session-tool-budget",
            spec: createTestSpec({ maxToolCalls: 1 }),
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([echoTool]),
            runtime: createRuntime("budget-tool-event"),
        });
        const events = await store.loadSession("session-tool-budget");

        assert.equal(executions, 1);
        assert.equal(state.status, "failed");
        assert.ok(
            events.some(
                (event) =>
                    event.type === "budget_exhausted" && event.budget === "tool_calls",
            ),
        );
    } finally {
        await store.close();
    }
});

test("resume completes a recorded tool call before asking the model again", async () => {
    let executions = 0;
    const echoTool: AgentTool = {
        name: "echo",
        permission: { action: "workspace-read", risk: "read" },
        async execute(input) {
            executions += 1;
            return { ok: true, output: input };
        },
    };
    const spec = createTestSpec({ id: "spec.resume-tool" });
    const store = new InMemoryEventStore();
    const historicalEvents: AgentEvent[] = [
        createSessionStartedEvent({
            eventId: "tool-history-1",
            sessionId: "session-resume-tool",
            spec,
            timestamp: "2026-08-19T00:00:00.000Z",
        }),
        {
            id: "tool-history-2",
            sessionId: "session-resume-tool",
            sequence: 2,
            timestamp: "2026-08-19T00:00:01.000Z",
            type: "state_changed",
            from: "created",
            to: "analyzing",
            reason: "Analysis started.",
            sourceEventId: "tool-history-1",
        },
        {
            id: "tool-history-3",
            sessionId: "session-resume-tool",
            sequence: 3,
            timestamp: "2026-08-19T00:00:02.000Z",
            type: "model_tool_call",
            toolCall: { id: "echo-1", name: "echo", input: { value: 42 } },
        },
    ];
    for (const event of historicalEvents) {
        await store.append(event);
    }
    const model = new FakeModelProvider([
        {
            kind: "finish",
            outcome: "blocked",
            message: "Recovered after the tool call.",
            usage: { inputTokens: 10, outputTokens: 4 },
        },
    ]);

    try {
        await resumeAgentLoop({
            sessionId: "session-resume-tool",
            spec,
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([echoTool]),
            runtime: createRuntime("resume-tool-event"),
        });
        const events = await store.loadSession("session-resume-tool");

        assert.equal(executions, 1);
        assert.equal(events[3].type, "tool_result");
        assert.equal(model.requests[0].messages.at(-1)?.role, "tool");
        assert.match(model.requests[0].messages.at(-1)?.content ?? "", /42/);
    } finally {
        await store.close();
    }
});
