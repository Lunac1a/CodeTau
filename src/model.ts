import type { ModelResponse, ToolCall } from "./types.ts";
import type { ToolDefinition } from "./tools/tool.ts";

export type { ModelResponse, ModelUsage } from "./types.ts";

export type ModelMessage =
    | {
          readonly role: "system" | "user";
          readonly content: string;
      }
    | {
          readonly role: "assistant";
          readonly content: string;
      }
    | {
          readonly role: "assistant";
          readonly content: null;
          readonly toolCalls: readonly ToolCall[];
      }
    | {
          readonly role: "tool";
          readonly content: string;
          readonly toolCallId: string;
      };

export type ModelRequest = {
    messages: readonly ModelMessage[];
    availableTools: readonly ToolDefinition[];
};

export interface ModelProvider {
    generate(request: ModelRequest): Promise<ModelResponse>;
}
