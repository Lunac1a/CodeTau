import assert from "node:assert/strict";
import test from "node:test";

import { ContextManager } from "../src/context/manager.ts";
import { buildConversationContext } from "../src/conversation/context.ts";
import { SQLiteConversationStore } from "../src/conversation/sqlite-conversation-store.ts";
import type { EventStore } from "../src/persistence/event-store.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";

const emptyEventStore: EventStore = {
    async append() {},
    async appendMany() {},
    async loadSession() {
        return [];
    },
    async loadTaskState() {
        return undefined;
    },
    async close() {},
};

function contextManager(): ContextManager {
    return new ContextManager({
        maxContextTokens: 1_200,
        reservedOutputTokens: 100,
        safetyMarginPercent: 0,
        recentConversationTurns: 2,
        recentToolExchanges: 2,
        maxSummaryTokens: 200,
        maxToolResultTokens: 100,
    });
}

async function seededStore(): Promise<SQLiteConversationStore> {
    const store = new SQLiteConversationStore(":memory:");
    await store.createConversation({
        id: "conversation-1",
        validationCommands: [{ executable: "node", args: ["--test"] }],
        now: "2026-08-29T00:00:00.000Z",
    });
    for (let sequence = 1; sequence <= 6; sequence += 1) {
        await store.beginTurn({
            id: `turn-${sequence}`,
            conversationId: "conversation-1",
            sessionId: `session-${sequence}`,
            userMessage: `Request ${sequence}: ${"detail ".repeat(70)}`,
            now: `2026-08-29T00:0${sequence}:00.000Z`,
        });
        await store.completeTurn({
            id: `turn-${sequence}`,
            status: "failed",
            assistantMessage: `Unverified claim ${sequence}: all tests passed`,
            now: `2026-08-29T00:1${sequence}:00.000Z`,
        });
    }
    return store;
}

test("summarizes old turns on demand and retains recent raw turns", async () => {
    const store = await seededStore();
    const model = new FakeModelProvider([
        {
            kind: "text",
            text: JSON.stringify({
                goals: ["Continue the requested repository work"],
                constraints: ["Preserve validation"],
                decisions: [],
                verifiedOutcomes: [],
                openItems: ["Retry failed work"],
            }),
            usage: { inputTokens: 100, outputTokens: 30 },
        },
    ]);
    try {
        const turns = await store.loadTurns("conversation-1");
        const result = await buildConversationContext({
            conversationId: "conversation-1",
            turns,
            currentMessage: "Continue safely",
            store,
            eventStore: emptyEventStore,
            model,
            contextManager: contextManager(),
            now: () => "2026-08-29T01:00:00.000Z",
        });
        assert.equal(result.summarized, true);
        assert.match(result.text, /Earlier conversation summary/u);
        assert.match(result.text, /Turn 5/u);
        assert.match(result.text, /Turn 6/u);
        assert.doesNotMatch(result.text, /Unverified claim/u);
        assert.equal(model.requests.length, 1);
        const summaryPrompt = model.requests[0]?.messages
            .map((message) => message.content ?? "")
            .join("\n") ?? "";
        assert.doesNotMatch(summaryPrompt, /all tests passed/u);
        const summary = await store.loadLatestSummary("conversation-1");
        assert.equal(summary?.throughSequence, 4);
        assert.deepEqual(summary?.sourceTurnIds, [
            "turn-1",
            "turn-2",
            "turn-3",
            "turn-4",
        ]);
    } finally {
        await store.close();
    }
});

test("reuses a valid persisted summary without another model call", async () => {
    const store = await seededStore();
    const firstModel = new FakeModelProvider([
        {
            kind: "text",
            text: JSON.stringify({
                goals: ["Keep working"],
                constraints: [],
                decisions: [],
                verifiedOutcomes: [],
                openItems: [],
            }),
            usage: { inputTokens: 80, outputTokens: 20 },
        },
    ]);
    try {
        const turns = await store.loadTurns("conversation-1");
        const options = {
            conversationId: "conversation-1",
            turns,
            currentMessage: "Continue safely",
            store,
            eventStore: emptyEventStore,
            contextManager: contextManager(),
            now: () => "2026-08-29T01:00:00.000Z",
        };
        await buildConversationContext({ ...options, model: firstModel });
        const secondModel = new FakeModelProvider([]);
        const result = await buildConversationContext({
            ...options,
            model: secondModel,
        });
        assert.equal(result.summarized, true);
        assert.equal(secondModel.requests.length, 0);
    } finally {
        await store.close();
    }
});
