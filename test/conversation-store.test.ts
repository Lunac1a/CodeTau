import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteConversationStore } from "../src/conversation/sqlite-conversation-store.ts";

test("persists conversations and ordered turns", async () => {
    const store = new SQLiteConversationStore(":memory:");
    try {
        const conversation = await store.createConversation({
            id: "conversation-1",
            validationCommands: [{ executable: "node", args: ["--test"] }],
            now: "2026-08-25T00:00:00.000Z",
        });
        assert.equal(conversation.id, "conversation-1");

        const first = await store.beginTurn({
            id: "turn-1",
            conversationId: conversation.id,
            sessionId: "session-1",
            userMessage: "Fix the greeting",
            now: "2026-08-25T00:01:00.000Z",
        });
        assert.equal(first.sequence, 1);
        await store.completeTurn({
            id: first.id,
            status: "completed",
            assistantMessage: "Fixed and verified.",
            now: "2026-08-25T00:02:00.000Z",
        });
        await store.beginTurn({
            id: "turn-2",
            conversationId: conversation.id,
            sessionId: "session-2",
            userMessage: "Also update the docs",
            now: "2026-08-25T00:03:00.000Z",
        });
        await store.failOpenTurns(
            conversation.id,
            "2026-08-25T00:04:00.000Z",
        );

        const turns = await store.loadTurns(conversation.id);
        assert.deepEqual(
            turns.map((turn) => [turn.sequence, turn.status]),
            [
                [1, "completed"],
                [2, "failed"],
            ],
        );
        assert.equal(turns[0]?.assistantMessage, "Fixed and verified.");
        assert.match(turns[1]?.assistantMessage ?? "", /process ended/u);
    } finally {
        await store.close();
    }
});
