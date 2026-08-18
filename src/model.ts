import type { ToolCall } from "./types.ts";

export type ModelMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
};

export type ModelRequest = {
    messages: readonly ModelMessage[];
    availableToolNames: readonly string[];
};

export type ModelUsage = {
    inputTokens: number;
    outputTokens: number;
};

export type ModelResponse =
    | {
          kind: "text";
          text: string;
          usage: ModelUsage;
      }
    | {
          kind: "tool_calls";
          calls: readonly ToolCall[];
          usage: ModelUsage;
      }
    | {
          kind: "finish";
          outcome: "completed" | "failed" | "blocked";
          message: string;
          usage: ModelUsage;
      };

export interface ModelProvider {
    generate(request: ModelRequest): Promise<ModelResponse>;
}
