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
    id: string;
    name: string;
    input: unknown;
};

export type ToolResult =
    | {
        ok: true;
        output: unknown;
      }
    | {
        ok: false;
        error: {
            code: string;
            message: string;
            details?: unknown;
        };
      };

type EventBase = {
    id: string;
    sessionId: string;
    timestamp: string;
};

export type AgentEvent =
    | (EventBase & {
        type: "session_started";
        specPath: string;
      })
    | (EventBase & {
        type: "state_changed";
        from: TaskStatus;
        to: TaskStatus;
        reason: string;
        sourceEventId: string;
      })
    | (EventBase & {
        type: "model_tool_call";
        toolCall: ToolCall;
      })
    | (EventBase & {
        type: "tool_result";
        toolCallId: string;
        result: ToolResult;
      })
    | (EventBase & {
        type: "final";
        status: "completed" | "failed" | "blocked";
        message: string;
      });