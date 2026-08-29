import assert from "node:assert/strict";
import test from "node:test";

import { runConversationCommand } from "../apps/cli/conversation.ts";
import type { ConversationUI } from "../apps/cli/terminal-ui.ts";
import type { CodeTauConfig } from "../src/config/loader.ts";
import { SQLiteConversationStore } from "../src/conversation/sqlite-conversation-store.ts";
import type { TaskState } from "../src/events.ts";
import type { EventStore } from "../src/persistence/event-store.ts";
import type { SessionRunnerLike } from "../src/session/runner.ts";

test("runs multiple messages in one persistent conversation", async () => {
    const store = new SQLiteConversationStore(":memory:");
    await store.createConversation({
        id: "conversation-1",
        validationCommands: [{ executable: "node", args: ["--test"] }],
        now: "2026-08-25T00:00:00.000Z",
    });
    const states = new Map<string, TaskState>();
    const eventStore: EventStore = {
        async append() {},
        async appendMany() {},
        async loadSession() {
            return [];
        },
        async loadTaskState(sessionId) {
            return states.get(sessionId);
        },
        async close() {},
    };
    const runner: SessionRunnerLike = {
        async run() {
            throw new Error("unused");
        },
        async runLoadedSpec() {
            throw new Error("unused");
        },
        async resume() {
            throw new Error("unused");
        },
    };
    const messages: Array<string | undefined> = [
        "Fix the greeting",
        "Now update the docs",
        undefined,
    ];
    const replies: string[] = [];
    const ui: ConversationUI = {
        interactive: true,
        async readTask() {
            return undefined;
        },
        async selectValidationCommands(commands) {
            return commands;
        },
        async confirmPreflight() {
            return true;
        },
        async requestApproval() {
            return "allow-once";
        },
        renderEvent() {},
        renderReport() {},
        writeError(message) {
            throw new Error(message);
        },
        close() {},
        renderConversationHeader(options) {
            assert.equal(options.resumed, true);
        },
        async readConversationMessage() {
            return messages.shift();
        },
        renderAssistantReply(message) {
            replies.push(message);
        },
    };
    const contexts: string[] = [];
    const reportRendering: Array<boolean | undefined> = [];
    let replyNumber = 0;
    const config: CodeTauConfig = {
        databasePath: ":memory:",
        model: "test-model",
        baseUrl: "http://localhost:1234/v1",
        commandAllowlist: ["node"],
        commandTimeoutMs: 1_000,
        maxOutputBytes: 1_000,
        contextManagement: {
            maxContextTokens: 16_384,
            reservedOutputTokens: 2_048,
            safetyMarginPercent: 10,
            recentConversationTurns: 4,
            recentToolExchanges: 6,
            maxSummaryTokens: 1_200,
            maxToolResultTokens: 2_048,
        },
        sourcePath: "codetau.config.json",
        rootDirectory: process.cwd(),
        naturalLanguage: {
            maxModelTurns: 20,
            maxToolCalls: 60,
            maxRetries: 3,
            additionalProtectedPaths: [],
        },
    };

    try {
        const exitCode = await runConversationCommand({
            command: { kind: "chat", conversationId: "conversation-1" },
            config,
            eventStore,
            conversationStore: store,
            runner,
            ui,
            async runTask(options) {
                contexts.push(options.conversationContext ?? "");
                reportRendering.push(options.renderReport);
                const sessionId = options.command.sessionId as string;
                states.set(sessionId, {
                    sessionId,
                    specId: "generated.test",
                    specPath: "generated://test",
                    specDigest: "digest",
                    status: "completed",
                    revision: 1,
                    lastSequence: 1,
                    lastEventId: "event-1",
                    final: { status: "completed", message: "Done" },
                });
                return 0;
            },
            async createReply() {
                replyNumber += 1;
                return `reply ${replyNumber}`;
            },
        });
        assert.equal(exitCode, 0);
        assert.deepEqual(replies, ["reply 1", "reply 2"]);
        assert.deepEqual(reportRendering, [false, false]);
        assert.match(contexts[1] ?? "", /Fix the greeting/u);
        assert.match(contexts[1] ?? "", /reply 1/u);
        const turns = await store.loadTurns("conversation-1");
        assert.deepEqual(
            turns.map((turn) => turn.status),
            ["completed", "completed"],
        );
    } finally {
        await store.close();
    }
});
