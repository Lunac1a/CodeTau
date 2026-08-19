import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoopError } from "../src/agent-loop/errors.ts";
import { runAgentLoop, type AgentLoopRuntime } from "../src/agent-loop/run.ts";
import { InMemoryEventStore } from "../src/persistence/in-memory-event-store.ts";
import type { LoadedSpec } from "../src/spec/types.ts";
import type { AgentEvent } from "../src/types.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";

function createSpec(maxModelTurns = 3): LoadedSpec {
    return {
        sourcePath: "C:\\workspace\\specs\\test.md",
        context: "Analyze the task and report whether it can continue.",
        contract: {
            version: 1,
            id: "test.minimal-loop",
            goal: "Exercise the minimal Agent loop.",
            workspace: {
                root: "fixtures/example",
                allowedPaths: ["src/**"],
            },
            policy: {
                forbiddenActions: ["network-access"],
            },
            acceptance: {
                commands: [{ executable: "pnpm", args: ["test"] }],
                assertions: ["All tests pass."],
            },
            phases: [
                { id: "analyze", description: "Analyze the task." },
                { id: "validate", description: "Validate the result." },
            ],
            budget: {
                maxModelTurns,
                maxToolCalls: 10,
                maxRetries: 1,
            },
            userInteraction: {
                allowQuestions: false,
                approvalResponses: ["allow-once", "allow-session", "deny"],
            },
        },
    };
}

function createRuntime(): AgentLoopRuntime {
    let eventNumber = 0;
    return {
        nextEventId: () => `event-${++eventNumber}`,
        now: () => "2026-08-19T00:00:00.000Z",
    };
}

test("runs multiple model turns and records a blocked terminal state", async () => {
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "text",
            text: "I need a tool that is not available yet.",
            usage: { inputTokens: 20, outputTokens: 9 },
        },
        {
            kind: "finish",
            outcome: "blocked",
            message: "Repository inspection tools are required.",
            usage: { inputTokens: 31, outputTokens: 7 },
        },
    ]);

    try {
        const state = await runAgentLoop({
            sessionId: "session-loop",
            spec: createSpec(),
            model,
            eventStore: store,
            runtime: createRuntime(),
        });
        const events = await store.loadSession("session-loop");

        assert.equal(state.status, "blocked");
        assert.equal(state.final?.message, "Repository inspection tools are required.");
        assert.deepEqual(
            events.map((event) => event.type),
            [
                "session_started",
                "state_changed",
                "model_text",
                "model_finish",
                "state_changed",
                "final",
            ],
        );
        assert.equal(model.requests.length, 2);
        assert.equal(model.requests[0].availableToolNames.length, 0);
        assert.equal(
            model.requests[1].messages.at(-1)?.content,
            "I need a tool that is not available yet.",
        );
    } finally {
        await store.close();
    }
});

test("fails deterministically when the model turn budget is exhausted", async () => {
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "text",
            text: "One unfinished analysis turn.",
            usage: { inputTokens: 10, outputTokens: 5 },
        },
    ]);

    try {
        const state = await runAgentLoop({
            sessionId: "session-budget",
            spec: createSpec(1),
            model,
            eventStore: store,
            runtime: createRuntime(),
        });
        const events = await store.loadSession("session-budget");

        assert.equal(state.status, "failed");
        assert.equal(model.requests.length, 1);
        assert.ok(events.some((event) => event.type === "budget_exhausted"));
    } finally {
        await store.close();
    }
});

test("records a model provider error and terminates safely", async () => {
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([]);

    try {
        const state = await runAgentLoop({
            sessionId: "session-model-error",
            spec: createSpec(),
            model,
            eventStore: store,
            runtime: createRuntime(),
        });
        const events = await store.loadSession("session-model-error");
        const errorEvent = events.find(
            (event): event is Extract<AgentEvent, { type: "model_error" }> =>
                event.type === "model_error",
        );

        assert.equal(state.status, "failed");
        assert.equal(errorEvent?.error.code, "model_provider_error");
        assert.match(errorEvent?.error.message ?? "", /no response left/);
    } finally {
        await store.close();
    }
});

test("rejects an unvalidated model completion claim", async () => {
    const store = new InMemoryEventStore();
    const model = new FakeModelProvider([
        {
            kind: "finish",
            outcome: "completed",
            message: "I am done.",
            usage: { inputTokens: 10, outputTokens: 4 },
        },
    ]);

    try {
        const state = await runAgentLoop({
            sessionId: "session-false-completion",
            spec: createSpec(),
            model,
            eventStore: store,
            runtime: createRuntime(),
        });

        assert.equal(state.status, "failed");
        assert.match(state.final?.message ?? "", /rejected.*validation/i);
    } finally {
        await store.close();
    }
});

test("refuses to overwrite an existing session", async () => {
    const store = new InMemoryEventStore();
    await store.append({
        id: "existing-event",
        sessionId: "session-existing",
        sequence: 1,
        timestamp: "2026-08-19T00:00:00.000Z",
        type: "session_started",
        specId: "test.existing",
        specPath: "specs/existing.md",
    });

    try {
        await assert.rejects(
            runAgentLoop({
                sessionId: "session-existing",
                spec: createSpec(),
                model: new FakeModelProvider([]),
                eventStore: store,
                runtime: createRuntime(),
            }),
            (error: unknown) => {
                assert.ok(error instanceof AgentLoopError);
                assert.equal(error.code, "session_already_exists");
                return true;
            },
        );
        assert.equal((await store.loadSession("session-existing")).length, 1);
    } finally {
        await store.close();
    }
});
