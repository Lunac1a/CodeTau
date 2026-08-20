import type {
    ModelMessage,
    ModelProvider,
    ModelRequest,
} from "../model.ts";
import type { ModelResponse, ModelUsage, ToolCall } from "../types.ts";
import type { ToolDefinition } from "../tools/tool.ts";
import { ModelProviderError } from "./errors.ts";

const FINISH_TOOL_NAME = "finish_task";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_LENGTH = 2_000;

type FetchLike = (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
) => Promise<Response>;

export type OpenAICompatibleModelProviderOptions = Readonly<{
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
    fetch?: FetchLike;
}>;

type OpenAIMessage =
    | { role: "system" | "user" | "assistant"; content: string }
    | {
          role: "assistant";
          content: null;
          tool_calls: OpenAIToolCall[];
      }
    | { role: "tool"; content: string; tool_call_id: string };

type OpenAIToolCall = {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
};

type OpenAITool = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Readonly<Record<string, unknown>>;
    };
};

function requiredText(value: string, label: string): string {
    const trimmed = value.trim();
    if (trimmed === "") {
        throw new ModelProviderError({
            code: "invalid_configuration",
            message: `${label} must not be empty`,
        });
    }
    return trimmed;
}

function normalizeBaseUrl(value: string): string {
    const baseUrl = requiredText(value, "Model base URL").replace(/\/+$/, "");
    let parsed: URL;
    try {
        parsed = new URL(baseUrl);
    } catch (error) {
        throw new ModelProviderError({
            code: "invalid_configuration",
            message: `Model base URL is invalid: ${baseUrl}`,
            cause: error,
        });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ModelProviderError({
            code: "invalid_configuration",
            message: "Model base URL must use http or https",
        });
    }
    return baseUrl;
}

function usageFrom(value: unknown): ModelUsage {
    if (typeof value !== "object" || value === null) {
        return { inputTokens: 0, outputTokens: 0 };
    }
    const usage = value as Record<string, unknown>;
    return {
        inputTokens:
            typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
        outputTokens:
            typeof usage.completion_tokens === "number"
                ? usage.completion_tokens
                : 0,
    };
}

function toOpenAIToolCall(call: ToolCall): OpenAIToolCall {
    return {
        id: call.id,
        type: "function",
        function: {
            name: call.name,
            arguments: JSON.stringify(call.input),
        },
    };
}

function toOpenAIMessage(message: ModelMessage): OpenAIMessage {
    if (message.role === "tool") {
        return {
            role: "tool",
            content: message.content,
            tool_call_id: message.toolCallId,
        };
    }
    if (message.role === "assistant" && "toolCalls" in message) {
        return {
            role: "assistant",
            content: null,
            tool_calls: message.toolCalls.map(toOpenAIToolCall),
        };
    }
    return { role: message.role, content: message.content };
}

function toOpenAITool(definition: ToolDefinition): OpenAITool {
    return {
        type: "function",
        function: {
            name: definition.name,
            description: definition.description,
            parameters: definition.inputSchema,
        },
    };
}

function finishTool(): OpenAITool {
    return {
        type: "function",
        function: {
            name: FINISH_TOOL_NAME,
            description:
                "Declare the final task outcome. Use completed only after every required validation command has passed.",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    outcome: {
                        type: "string",
                        enum: ["completed", "failed", "blocked"],
                    },
                    message: { type: "string" },
                },
                required: ["outcome", "message"],
            },
        },
    };
}

function parseArguments(value: unknown, toolName: string): unknown {
    if (typeof value !== "string") {
        throw new ModelProviderError({
            code: "invalid_tool_call",
            message: `Tool arguments must be JSON text: ${toolName}`,
        });
    }
    try {
        return JSON.parse(value) as unknown;
    } catch (error) {
        throw new ModelProviderError({
            code: "invalid_tool_call",
            message: `Tool arguments are not valid JSON: ${toolName}`,
            cause: error,
        });
    }
}

function parseToolCall(value: unknown): ToolCall {
    if (typeof value !== "object" || value === null) {
        throw new ModelProviderError({
            code: "invalid_tool_call",
            message: "Model returned an invalid tool call",
        });
    }
    const call = value as Record<string, unknown>;
    const fn = call.function;
    if (typeof fn !== "object" || fn === null) {
        throw new ModelProviderError({
            code: "invalid_tool_call",
            message: "Model tool call is missing its function",
        });
    }
    const functionCall = fn as Record<string, unknown>;
    if (
        typeof call.id !== "string" ||
        call.id.trim() === "" ||
        typeof functionCall.name !== "string" ||
        functionCall.name.trim() === ""
    ) {
        throw new ModelProviderError({
            code: "invalid_tool_call",
            message: "Model tool call is missing an id or function name",
        });
    }
    return {
        id: call.id,
        name: functionCall.name,
        input: parseArguments(functionCall.arguments, functionCall.name),
    };
}

function parseFinish(call: ToolCall, usage: ModelUsage): ModelResponse {
    if (typeof call.input !== "object" || call.input === null) {
        throw new ModelProviderError({
            code: "invalid_tool_call",
            message: `${FINISH_TOOL_NAME} requires an object input`,
        });
    }
    const input = call.input as Record<string, unknown>;
    if (
        input.outcome !== "completed" &&
        input.outcome !== "failed" &&
        input.outcome !== "blocked"
    ) {
        throw new ModelProviderError({
            code: "invalid_tool_call",
            message: `${FINISH_TOOL_NAME} returned an invalid outcome`,
        });
    }
    if (typeof input.message !== "string") {
        throw new ModelProviderError({
            code: "invalid_tool_call",
            message: `${FINISH_TOOL_NAME} requires a message`,
        });
    }
    return {
        kind: "finish",
        outcome: input.outcome,
        message: input.message,
        usage,
    };
}

function parseResponse(value: unknown): ModelResponse {
    if (typeof value !== "object" || value === null) {
        throw new ModelProviderError({
            code: "invalid_response",
            message: "Model response must be an object",
        });
    }
    const response = value as Record<string, unknown>;
    const choices = response.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
        throw new ModelProviderError({
            code: "invalid_response",
            message: "Model response is missing choices",
        });
    }
    const firstChoice = choices[0];
    if (typeof firstChoice !== "object" || firstChoice === null) {
        throw new ModelProviderError({
            code: "invalid_response",
            message: "Model response contains an invalid choice",
        });
    }
    const message = (firstChoice as Record<string, unknown>).message;
    if (typeof message !== "object" || message === null) {
        throw new ModelProviderError({
            code: "invalid_response",
            message: "Model response choice is missing a message",
        });
    }

    const usage = usageFrom(response.usage);
    const modelMessage = message as Record<string, unknown>;
    if (Array.isArray(modelMessage.tool_calls) && modelMessage.tool_calls.length > 0) {
        const calls = modelMessage.tool_calls.map(parseToolCall);
        const finishCalls = calls.filter((call) => call.name === FINISH_TOOL_NAME);
        if (finishCalls.length > 0) {
            if (calls.length !== 1) {
                throw new ModelProviderError({
                    code: "invalid_tool_call",
                    message: `${FINISH_TOOL_NAME} cannot be combined with other tool calls`,
                });
            }
            return parseFinish(finishCalls[0], usage);
        }
        return { kind: "tool_calls", calls, usage };
    }

    if (typeof modelMessage.content !== "string") {
        throw new ModelProviderError({
            code: "invalid_response",
            message: "Model response contains neither text nor tool calls",
        });
    }
    return { kind: "text", text: modelMessage.content, usage };
}

export class OpenAICompatibleModelProvider implements ModelProvider {
    readonly #endpoint: string;
    readonly #model: string;
    readonly #apiKey?: string;
    readonly #timeoutMs: number;
    readonly #fetch: FetchLike;

    constructor(options: OpenAICompatibleModelProviderOptions) {
        this.#endpoint = `${normalizeBaseUrl(options.baseUrl)}/chat/completions`;
        this.#model = requiredText(options.model, "Model name");
        this.#apiKey = options.apiKey?.trim() || undefined;
        this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
            throw new ModelProviderError({
                code: "invalid_configuration",
                message: "Model timeout must be a positive integer",
            });
        }
        this.#fetch = options.fetch ?? globalThis.fetch;
    }

    async generate(request: ModelRequest): Promise<ModelResponse> {
        if (request.availableTools.some((tool) => tool.name === FINISH_TOOL_NAME)) {
            throw new ModelProviderError({
                code: "invalid_configuration",
                message: `${FINISH_TOOL_NAME} is reserved by the model provider`,
            });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
        let response: Response;
        try {
            response = await this.#fetch(this.#endpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.#apiKey === undefined
                        ? {}
                        : { authorization: `Bearer ${this.#apiKey}` }),
                },
                body: JSON.stringify({
                    model: this.#model,
                    messages: request.messages.map(toOpenAIMessage),
                    tools: [
                        ...request.availableTools.map(toOpenAITool),
                        finishTool(),
                    ],
                    tool_choice: "auto",
                    temperature: 0,
                    stream: false,
                }),
                signal: controller.signal,
            });
        } catch (error) {
            throw new ModelProviderError({
                code: "request_failed",
                message: `Model request failed: ${
                    error instanceof Error ? error.message : "unknown error"
                }`,
                cause: error,
            });
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            const body = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
            throw new ModelProviderError({
                code: "http_error",
                message: `Model server returned HTTP ${response.status}${
                    body === "" ? "" : `: ${body}`
                }`,
                status: response.status,
            });
        }

        let body: unknown;
        try {
            body = await response.json();
        } catch (error) {
            throw new ModelProviderError({
                code: "invalid_response",
                message: "Model server returned invalid JSON",
                cause: error,
            });
        }
        return parseResponse(body);
    }
}
