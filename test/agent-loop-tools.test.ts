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
        assert.deepEqual(
            model.requests[0].availableTools.map((tool) => tool.name),
            ["read_file"],
        );
        assert.deepEqual(model.requests[1].messages.at(-2), {
            role: "assistant",
            content: null,
            toolCalls: [
                {
                    id: "read-call-1",
                    name: "read_file",
                    input: { path: "src/answer.txt" },
                },
            ],
        });
        const toolResultMessage = model.requests[1].messages.at(-1);
        assert.equal(toolResultMessage?.role, "tool");
        assert.equal(
            toolResultMessage?.role === "tool"
                ? toolResultMessage.toolCallId
                : undefined,
            "read-call-1",
        );
        assert.match(toolResultMessage?.content ?? "", /forty-two/);
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
        description: "Fetch a URL for testing.",
        inputSchema: { type: "object" },
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

test("pauses a write tool and resumes it after allow-once approval", async () => {
    let executed = false;
    const writeTool: AgentTool = {
        name: "write_file",
        description: "Write a file for testing.",
        inputSchema: { type: "object" },
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
        const pendingState = await runAgentLoop({
            sessionId: "session-write-approval",
            spec: createTestSpec(),
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([writeTool]),
            runtime: createRuntime("write-event"),
        });
        const pendingEvents = await store.loadSession("session-write-approval");

        assert.equal(pendingState.status, "awaiting_approval");
        assert.deepEqual(pendingState.pendingApproval, {
            toolCallId: "write-1",
            toolName: "write_file",
        });
        assert.equal(executed, false);
        assert.equal(pendingEvents.some((event) => event.type === "tool_result"), false);

        const finalState = await resumeAgentLoop({
            sessionId: "session-write-approval",
            spec: createTestSpec(),
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([writeTool]),
            approvalResponse: "allow-once",
            runtime: createRuntime("write-resume-event"),
        });
        const resumedEvents = await store.loadSession("session-write-approval");
        const result = resumedEvents.find(
            (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
                event.type === "tool_result",
        );

        assert.equal(executed, true);
        assert.equal(finalState.status, "blocked");
        assert.equal(result?.result.ok, true);
        assert.ok(
            resumedEvents.some(
                (event) =>
                    event.type === "approval_resolved" &&
                    event.response === "allow-once",
            ),
        );
    } finally {
        await store.close();
    }
});

test("deny resumes the model without executing the pending tool", async () => {
    let executions = 0;
    const writeTool: AgentTool = {
        name: "write_file",
        description: "Write a file for testing.",
        inputSchema: { type: "object" },
        permission: { action: "workspace-write", risk: "write" },
        async execute() {
            executions += 1;
            return { ok: true, output: null };
        },
    };
    const spec = createTestSpec();
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [{ id: "denied-write-1", name: "write_file", input: {} }],
            usage: { inputTokens: 10, outputTokens: 4 },
        },
        {
            kind: "finish",
            outcome: "blocked",
            message: "The write was denied.",
            usage: { inputTokens: 15, outputTokens: 4 },
        },
    ]);

    try {
        assert.equal(
            (
                await runAgentLoop({
                    sessionId: "session-denied-write",
                    spec,
                    model,
                    eventStore: store,
                    toolRegistry: new ToolRegistry([writeTool]),
                    runtime: createRuntime("denied-write-event"),
                })
            ).status,
            "awaiting_approval",
        );
        const finalState = await resumeAgentLoop({
            sessionId: "session-denied-write",
            spec,
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([writeTool]),
            approvalResponse: "deny",
            runtime: createRuntime("denied-write-resume"),
        });
        const result = (await store.loadSession("session-denied-write")).find(
            (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
                event.type === "tool_result",
        );

        assert.equal(executions, 0);
        assert.equal(finalState.status, "blocked");
        assert.deepEqual(result?.result, {
            ok: false,
            error: {
                code: "denied_by_user",
                message: "Action was denied by the user: workspace-write",
            },
        });
    } finally {
        await store.close();
    }
});

test("allow-session executes later uses of the same action without pausing", async () => {
    let executions = 0;
    const writeTool: AgentTool = {
        name: "write_file",
        description: "Write a file for testing.",
        inputSchema: { type: "object" },
        permission: { action: "workspace-write", risk: "write" },
        async execute(input) {
            executions += 1;
            return { ok: true, output: input };
        },
    };
    const spec = createTestSpec();
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [{ id: "session-write-1", name: "write_file", input: 1 }],
            usage: { inputTokens: 10, outputTokens: 4 },
        },
        {
            kind: "tool_calls",
            calls: [{ id: "session-write-2", name: "write_file", input: 2 }],
            usage: { inputTokens: 12, outputTokens: 4 },
        },
        {
            kind: "finish",
            outcome: "blocked",
            message: "Both writes were handled.",
            usage: { inputTokens: 14, outputTokens: 4 },
        },
    ]);

    try {
        await runAgentLoop({
            sessionId: "session-allow-session",
            spec,
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([writeTool]),
            runtime: createRuntime("session-write-event"),
        });
        const state = await resumeAgentLoop({
            sessionId: "session-allow-session",
            spec,
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([writeTool]),
            approvalResponse: "allow-session",
            runtime: createRuntime("session-write-resume"),
        });
        const events = await store.loadSession("session-allow-session");

        assert.equal(state.status, "blocked");
        assert.equal(executions, 2);
        assert.equal(
            events.filter((event) => event.type === "approval_resolved").length,
            1,
        );
        assert.equal(
            events.filter(
                (event) =>
                    event.type === "state_changed" &&
                    event.to === "awaiting_approval",
            ).length,
            1,
        );
    } finally {
        await store.close();
    }
});

test("stops before executing a tool call beyond the Spec budget", async () => {
    let executions = 0;
    const echoTool: AgentTool = {
        name: "echo",
        description: "Echo input for testing.",
        inputSchema: { type: "object" },
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
        description: "Echo input for testing.",
        inputSchema: { type: "object" },
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

test("resume restores allow-session approval from the event history", async () => {
    let executions = 0;
    const writeTool: AgentTool = {
        name: "write_file",
        description: "Write a file for testing.",
        inputSchema: { type: "object" },
        permission: { action: "workspace-write", risk: "write" },
        async execute(input) {
            executions += 1;
            return { ok: true, output: input };
        },
    };
    const spec = createTestSpec({ id: "spec.persisted-approval" });
    const sessionId = "session-persisted-approval";
    const store = new InMemoryEventStore();
    const historicalEvents: AgentEvent[] = [
        createSessionStartedEvent({
            eventId: "approval-history-1",
            sessionId,
            spec,
            timestamp: "2026-08-19T00:00:00.000Z",
        }),
        {
            id: "approval-history-2",
            sessionId,
            sequence: 2,
            timestamp: "2026-08-19T00:00:01.000Z",
            type: "state_changed",
            from: "created",
            to: "analyzing",
            reason: "Analysis started.",
            sourceEventId: "approval-history-1",
        },
        {
            id: "approval-history-3",
            sessionId,
            sequence: 3,
            timestamp: "2026-08-19T00:00:02.000Z",
            type: "model_tool_call",
            toolCall: { id: "approved-write-1", name: "write_file", input: 1 },
        },
        {
            id: "approval-history-4",
            sessionId,
            sequence: 4,
            timestamp: "2026-08-19T00:00:03.000Z",
            type: "state_changed",
            from: "analyzing",
            to: "awaiting_approval",
            reason: "Write approval is required.",
            sourceEventId: "approval-history-3",
        },
        {
            id: "approval-history-5",
            sessionId,
            sequence: 5,
            timestamp: "2026-08-19T00:00:04.000Z",
            type: "approval_resolved",
            toolCallId: "approved-write-1",
            response: "allow-session",
        },
        {
            id: "approval-history-6",
            sessionId,
            sequence: 6,
            timestamp: "2026-08-19T00:00:05.000Z",
            type: "state_changed",
            from: "awaiting_approval",
            to: "analyzing",
            reason: "Approval was resolved.",
            sourceEventId: "approval-history-5",
        },
        {
            id: "approval-history-7",
            sessionId,
            sequence: 7,
            timestamp: "2026-08-19T00:00:06.000Z",
            type: "tool_result",
            toolCallId: "approved-write-1",
            result: { ok: true, output: 1 },
        },
        {
            id: "approval-history-8",
            sessionId,
            sequence: 8,
            timestamp: "2026-08-19T00:00:07.000Z",
            type: "model_tool_call",
            toolCall: { id: "approved-write-2", name: "write_file", input: 2 },
        },
    ];
    for (const event of historicalEvents) {
        await store.append(event);
    }
    const model = new FakeModelProvider([
        {
            kind: "finish",
            outcome: "blocked",
            message: "The persisted approval was restored.",
            usage: { inputTokens: 10, outputTokens: 4 },
        },
    ]);

    try {
        const state = await resumeAgentLoop({
            sessionId,
            spec,
            model,
            eventStore: store,
            toolRegistry: new ToolRegistry([writeTool]),
            runtime: createRuntime("persisted-approval-resume"),
        });

        assert.equal(state.status, "blocked");
        assert.equal(executions, 1);
        assert.equal(
            (await store.loadSession(sessionId)).filter(
                (event) =>
                    event.type === "state_changed" &&
                    event.to === "awaiting_approval",
            ).length,
            1,
        );
    } finally {
        await store.close();
    }
});
