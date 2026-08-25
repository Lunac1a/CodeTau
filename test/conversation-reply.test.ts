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
