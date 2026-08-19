import type { ModelResponse } from "./types.ts";

export type { ModelResponse, ModelUsage } from "./types.ts";

export type ModelMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
};

export type ModelRequest = {
    messages: readonly ModelMessage[];
    availableToolNames: readonly string[];
};

export interface ModelProvider {
    generate(request: ModelRequest): Promise<ModelResponse>;
}
