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
        readonly type: "tool_result";
        readonly toolCallId: string;
        readonly result: ToolResult;
      })
    | (EventBase & {
        readonly type: "final";
        readonly status: "completed" | "failed" | "blocked";
        readonly message: string;
      });
