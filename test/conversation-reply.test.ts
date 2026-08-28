import assert from "node:assert/strict";
import test from "node:test";

import {
    conversationHistoryContext,
    generateConversationReply,
} from "../src/conversation/reply.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";

test("builds bounded history and generates a grounded assistant reply", async () => {
    const turns = [
        {
            id: "turn-1",
            conversationId: "conversation-1",
            sequence: 1,
            sessionId: "session-1",
            userMessage: "Fix the greeting",
            assistantMessage: "Updated greeting.ts and tests passed.",
            status: "completed" as const,
            createdAt: "2026-08-25T00:00:00.000Z",
            completedAt: "2026-08-25T00:01:00.000Z",
        },
    ];
    const context = conversationHistoryContext(turns, "Now update the docs");
    assert.match(context, /Fix the greeting/u);
    assert.match(context, /Now update the docs/u);

    const model = new FakeModelProvider([
        {
            kind: "text",
            text: "Documentation updated; validation passed.",
            usage: { inputTokens: 12, outputTokens: 5 },
        },
    ]);
    const reply = await generateConversationReply({
        model,
        userMessage: "Now update the docs",
        turns,
        report: {
            sessionId: "session-2",
            status: "completed",
            message: "Done",
            changedFiles: ["README.md"],
            passedValidationIndexes: [0],
            validationCount: 1,
            modelTurns: 2,
            toolCalls: 3,
            inputTokens: 20,
            outputTokens: 10,
        },
        events: [],
    });
    assert.equal(reply, "Documentation updated; validation passed.");
    assert.equal(model.requests[0]?.includeFinishTool, false);
    assert.deepEqual(model.requests[0]?.availableTools, []);
});

test("omits unverified replies from failed conversation turns", () => {
    const context = conversationHistoryContext([
        {
            id: "turn-failed",
            conversationId: "conversation-1",
            sequence: 1,
            sessionId: "session-failed",
            userMessage: "Add a formatter",
            assistantMessage: "All tests passed, but this was not verified.",
            status: "failed",
            createdAt: "2026-08-29T00:00:00.000Z",
            completedAt: "2026-08-29T00:01:00.000Z",
        },
    ], "Try again");

    assert.match(context, /Add a formatter/u);
    assert.match(context, /failed turn; unverified response omitted/u);
    assert.doesNotMatch(context, /All tests passed/u);
});

test("uses an authoritative fallback when a turn failed validation", async () => {
    const model = new FakeModelProvider([
        {
            kind: "text",
            text: "All tests passed.",
            usage: { inputTokens: 1, outputTokens: 1 },
        },
    ]);
    const reply = await generateConversationReply({
        model,
        userMessage: "Add a formatter",
        turns: [],
        report: {
            sessionId: "session-failed",
            status: "failed",
            message: "Model turn budget exhausted.",
            changedFiles: ["src/format-user.js", "test/format-user.test.js"],
            passedValidationIndexes: [],
            validationCount: 1,
            modelTurns: 20,
            toolCalls: 8,
            inputTokens: 100,
            outputTokens: 50,
        },
        events: [{
            id: "event-1",
            sessionId: "session-failed",
            sequence: 1,
            timestamp: "2026-08-29T00:00:00.000Z",
            type: "model_text",
            text: "Validation passed. All tests succeeded.",
            usage: { inputTokens: 1, outputTokens: 1 },
        }],
    });

    assert.equal(
        reply,
        "failed: Model turn budget exhausted. Changed: src/format-user.js, test/format-user.test.js. Validation 0/1.",
    );
    assert.equal(model.requests.length, 0);
});

test("does not treat model prose as execution evidence", async () => {
    const model = new FakeModelProvider([
        {
            kind: "text",
            text: "Delivered and verified.",
            usage: { inputTokens: 1, outputTokens: 1 },
        },
    ]);
    await generateConversationReply({
        model,
        userMessage: "Fix the task",
        turns: [],
        report: {
            sessionId: "session-completed",
            status: "completed",
            message: "Done",
            changedFiles: ["src/example.js"],
            passedValidationIndexes: [0],
            validationCount: 1,
            modelTurns: 2,
            toolCalls: 1,
            inputTokens: 10,
            outputTokens: 5,
        },
        events: [{
            id: "event-1",
            sessionId: "session-completed",
            sequence: 1,
            timestamp: "2026-08-29T00:00:00.000Z",
            type: "model_text",
            text: "Unverified execution claim",
            usage: { inputTokens: 1, outputTokens: 1 },
        }],
    });

    const requestText = model.requests[0]?.messages
        .map((message) => message.content ?? "")
        .join("\n") ?? "";
    assert.doesNotMatch(requestText, /Unverified execution claim/u);
    assert.doesNotMatch(requestText, /Agent reasoning/u);
});
