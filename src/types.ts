export type TaskStatus =
    | "created"
    | "analyzing"
    | "awaiting_approval"
    | "editing"
    | "validating"
    | "completed"
    | "failed"
    | "blocked";

export type ToolCall = {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
};

export type ToolResult =
    | {
        readonly ok: true;
        readonly output: unknown;
      }
    | {
        readonly ok: false;
        readonly error: {
            readonly code: string;
            readonly message: string;
            readonly details?: unknown;
        };
      };

export type ModelUsage = {
    readonly inputTokens: number;
    readonly outputTokens: number;
};

export type ModelResponse =
    | {
          readonly kind: "text";
          readonly text: string;
          readonly usage: ModelUsage;
      }
    | {
          readonly kind: "tool_calls";
          readonly calls: readonly ToolCall[];
          readonly usage: ModelUsage;
      }
    | {
          readonly kind: "finish";
          readonly outcome: "completed" | "failed" | "blocked";
          readonly message: string;
          readonly usage: ModelUsage;
      };

export type EventBase = {
    readonly id: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly timestamp: string;
};

export type AgentEvent =
    | (EventBase & {
        readonly type: "session_started";
        readonly specId: string;
        readonly specPath: string;
      })
    | (EventBase & {
        readonly type: "state_changed";
        readonly from: TaskStatus;
        readonly to: TaskStatus;
        readonly reason: string;
        readonly sourceEventId: string;
      })
    | (EventBase & {
        readonly type: "model_tool_call";
        readonly toolCall: ToolCall;
      })
    | (EventBase & {
        readonly type: "model_text";
        readonly text: string;
        readonly usage: ModelUsage;
      })
    | (EventBase & {
        readonly type: "model_finish";
        readonly outcome: "completed" | "failed" | "blocked";
        readonly message: string;
        readonly usage: ModelUsage;
      })
    | (EventBase & {
        readonly type: "model_error";
        readonly error: {
            readonly code: string;
            readonly message: string;
        };
      })
    | (EventBase & {
        readonly type: "budget_exhausted";
        readonly budget: "model_turns" | "tool_calls" | "retries";
        readonly limit: number;
      })
    | (EventBase & {
        readonly type: "tool_result";
        readonly toolCallId: string;
        readonly result: ToolResult;
      })
    | (EventBase & {
        readonly type: "final";
        readonly status: "completed" | "failed" | "blocked";
        readonly message: string;
      });
