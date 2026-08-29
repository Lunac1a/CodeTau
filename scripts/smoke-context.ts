import { ContextManager, DEFAULT_CONTEXT_MANAGEMENT_CONFIG } from "../src/context/manager.ts";
import { buildConversationContext } from "../src/conversation/context.ts";
import { SQLiteConversationStore } from "../src/conversation/sqlite-conversation-store.ts";
import type { EventStore } from "../src/persistence/event-store.ts";
import type { ModelProvider, ModelRequest } from "../src/model.ts";
import type { ModelResponse } from "../src/types.ts";
import { OpenAICompatibleModelProvider } from "../src/providers/openai-compatible.ts";

const baseUrl = process.env.CODETAU_MODEL_BASE_URL ?? "http://localhost:1234/v1";
const modelName = process.env.CODETAU_MODEL ?? "qwen2.5-7b-instruct";
const provider = new OpenAICompatibleModelProvider({ baseUrl, model: modelName });
const observations: string[] = [];
const model: ModelProvider = {
    async generate(request: ModelRequest): Promise<ModelResponse> {
        try {
            const response = await provider.generate(request);
            observations.push(
                response.kind === "text"
                    ? response.text.slice(0, 1_000)
                    : JSON.stringify(response).slice(0, 1_000),
            );
            return response;
        } catch (error) {
            observations.push(
                error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            );
            throw error;
        }
    },
};
const store = new SQLiteConversationStore(":memory:");
const eventStore: EventStore = {
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

try {
    await store.createConversation({
        id: "context-smoke",
        validationCommands: [{ executable: "pnpm", args: ["test"] }],
        now: new Date().toISOString(),
    });
    for (let sequence = 1; sequence <= 30; sequence += 1) {
        await store.beginTurn({
            id: `turn-${sequence}`,
            conversationId: "context-smoke",
            sessionId: `session-${sequence}`,
            userMessage: `Iteration ${sequence}: preserve the sandbox, event replay, and validation requirements. ${"Inspect the current repository before making changes. ".repeat(40)}`,
            now: new Date().toISOString(),
        });
        await store.completeTurn({
            id: `turn-${sequence}`,
            status: "failed",
            assistantMessage: "Synthetic unverified response; it must not enter the summary.",
            now: new Date().toISOString(),
        });
    }

    const contextManager = new ContextManager(DEFAULT_CONTEXT_MANAGEMENT_CONFIG);
    const result = await buildConversationContext({
        conversationId: "context-smoke",
        turns: await store.loadTurns("context-smoke"),
        currentMessage: "Summarize the stable requirements and continue safely.",
        store,
        eventStore,
        model,
        contextManager,
        now: () => new Date().toISOString(),
    });
    const summary = await store.loadLatestSummary("context-smoke");
    if (!result.summarized || summary === undefined) {
        throw new Error(
            `LM Studio did not produce a valid persisted conversation summary. Observations: ${JSON.stringify(observations)}`,
        );
    }
    process.stdout.write(
        `${JSON.stringify({
            ok: true,
            baseUrl,
            model: modelName,
            throughSequence: summary.throughSequence,
            sourceTurnCount: summary.sourceTurnIds.length,
            renderedCharacters: result.text.length,
            omittedTurns: result.omittedTurns,
        })}\n`,
    );
} finally {
    await store.close();
}
