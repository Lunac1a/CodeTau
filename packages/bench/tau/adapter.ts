import type { ModelMessage, ModelProvider } from "../../../src/model.ts";
import type { ModelUsage, ToolCall } from "../../../src/types.ts";
import type { ToolDefinition } from "../../../src/tools/tool.ts";
import { TauBridgeClient, type TauRunStart } from "./client.ts";
import type {
    TauAssistantMessage,
    TauHistoryMessage,
    TauInputMessage,
    TauRunMetadata,
    TauToolCall,
    TauToolDefinition,
} from "./protocol.ts";

export class TauAdapterError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "TauAdapterError";
        this.code = code;
    }
}

export type TauSessionResult = Readonly<{
    reward: number;
    status: "completed" | "failed";
    metadata: TauRunMetadata;
    modelTurns: number;
    toolCalls: number;
    toolCallsByName: Readonly<Record<string, number>>;
    durationMs: number;
    usage: ModelUsage;
}>;

export type TauSessionAdapterOptions = Readonly<{
    client: TauBridgeClient;
    model: ModelProvider;
    now?: () => number;
}>;

function toolDefinition(tool: TauToolDefinition): ToolDefinition {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: structuredClone(tool.parameters),
    };
}

function toolCall(call: TauToolCall): ToolCall {
    return {
        id: call.id,
        name: call.name,
        input: structuredClone(call.arguments),
    };
}

function serializeResult(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TauAdapterError(
            "invalid_tool_result",
            "Tau tool result cannot be represented as JSON text",
        );
    }
    return serialized;
}

function appendHistory(messages: ModelMessage[], history: TauHistoryMessage): void {
    if (history.role !== "assistant" && history.role !== "tool") {
        messages.push({ role: history.role, content: history.content });
        return;
    }
    if (history.role === "assistant") {
        if (history.toolCalls.length === 0 && history.content !== null) {
            messages.push({ role: "assistant", content: history.content });
        } else {
            messages.push({
                role: "assistant",
                content: history.content,
                toolCalls: history.toolCalls.map(toolCall),
            });
        }
        return;
    }
    messages.push({
        role: "tool",
        toolCallId: history.toolCallId,
        content: serializeResult(history.result),
    });
}

function appendInput(messages: ModelMessage[], input: TauInputMessage): void {
    if (input.kind === "user") {
        messages.push({ role: "user", content: input.content });
        return;
    }
    const results = input.kind === "tool" ? [input] : input.results;
    for (const result of results) {
        messages.push({
            role: "tool",
            toolCallId: result.toolCallId,
            content: serializeResult(result.result),
        });
    }
}

function objectInput(value: unknown, toolName: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TauAdapterError(
            "invalid_tool_input",
            `Tau tool call input must be an object: ${toolName}`,
        );
    }
    return structuredClone(value as Record<string, unknown>);
}

function assistantFromResponse(
    response: Awaited<ReturnType<ModelProvider["generate"]>>,
): { protocol: TauAssistantMessage; model: ModelMessage } {
    if (response.kind === "finish") {
        throw new TauAdapterError(
            "unexpected_model_finish",
            "Tau sessions do not accept the coding-loop finish_task response",
        );
    }
    if (response.kind === "text") {
        return {
            protocol: { role: "assistant", content: response.text, toolCalls: [] },
            model: { role: "assistant", content: response.text },
        };
    }
    const calls = response.calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: objectInput(call.input, call.name),
    }));
    return {
        protocol: { role: "assistant", content: null, toolCalls: calls },
        model: {
            role: "assistant",
            content: null,
            toolCalls: response.calls,
        },
    };
}

export class TauSessionAdapter {
    readonly #client: TauBridgeClient;
    readonly #model: ModelProvider;
    readonly #now: () => number;

    constructor(options: TauSessionAdapterOptions) {
        this.#client = options.client;
        this.#model = options.model;
        this.#now = options.now ?? Date.now;
    }

    async run(options: TauRunStart): Promise<TauSessionResult> {
        let completed = false;
        let modelTurns = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let toolCalls = 0;
        const toolCallsByName: Record<string, number> = {};
        const startedAt = this.#now();
        try {
            await this.#client.handshake();
            const initialization = await this.#client.startRun(options);
            const messages: ModelMessage[] = [
                {
                    role: "system",
                    content: [
                        "You are the agent under evaluation in a tau benchmark session.",
                        "Follow the domain policy and use only the provided tools.",
                        initialization.payload.domainPolicy,
                    ].join("\n\n"),
                },
            ];
            for (const history of initialization.payload.messageHistory) {
                appendHistory(messages, history);
            }
            const availableTools = initialization.payload.tools.map(toolDefinition);
            let event = await this.#client.acknowledgeInitialization(
                initialization.id,
            );
            while (event.type === "agent_turn") {
                appendInput(messages, event.payload.message);
                let response: Awaited<ReturnType<ModelProvider["generate"]>>;
                try {
                    response = await this.#model.generate({
                        messages: structuredClone(messages),
                        availableTools,
                        includeFinishTool: false,
                    });
                } catch (error) {
                    throw new TauAdapterError(
                        "model_provider_error",
                        "Model provider failed during a tau turn",
                        { cause: error },
                    );
                }
                modelTurns += 1;
                inputTokens += response.usage.inputTokens;
                outputTokens += response.usage.outputTokens;
                const assistant = assistantFromResponse(response);
                for (const call of assistant.protocol.toolCalls) {
                    toolCalls += 1;
                    toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
                }
                messages.push(assistant.model);
                event = await this.#client.respondToTurn(
                    event.id,
                    assistant.protocol,
                );
            }
            await this.#client.shutdown();
            completed = true;
            return {
                reward: event.payload.reward,
                status: event.payload.status,
                metadata: event.payload.metadata,
                modelTurns,
                toolCalls,
                toolCallsByName,
                durationMs: this.#now() - startedAt,
                usage: { inputTokens, outputTokens },
            };
        } finally {
            if (!completed) {
                await this.#client.terminate();
            }
        }
    }
}
