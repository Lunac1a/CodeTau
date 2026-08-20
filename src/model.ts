import type { ModelResponse } from "./types.ts";
import type { ToolDefinition } from "./tools/tool.ts";

export type { ModelResponse, ModelUsage } from "./types.ts";

export type ModelMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
};

export type ModelRequest = {
    messages: readonly ModelMessage[];
    availableTools: readonly ToolDefinition[];
};

export interface ModelProvider {
    generate(request: ModelRequest): Promise<ModelResponse>;
}
