export type TaskStatus = "created" | "analyzing" | "awaiting_approval" | "editing" | "validating" | "completed" | "failed" | "blocked";
export type Risk = "read" | "write" | "execute" | "high";
export type PermissionDecision = "allow" | "ask" | "deny";

export interface Budget { maxTurns: number; maxToolCalls: number; maxRetries: number; }
export interface ValidationCommand { executable: string; args: string[]; }
export interface TaskSpec {
  id: string; title: string; goal: string; workspace: string;
  allowedPaths: string[]; forbiddenTools: string[]; policy: string[];
  validation: ValidationCommand[]; finalAssertions: string[];
  budget: Budget; allowQuestions: boolean; hiddenAssertions?: string;
  body: string;
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface ToolResult { ok: boolean; output?: unknown; error?: string; metadata?: Record<string, unknown>; }
export interface ModelMessage { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string; }
export interface ModelResponse { content?: string; toolCalls?: ToolCall[]; finish?: "stop" | "tool_calls"; usage?: Record<string, number>; }
export interface ModelProvider { complete(messages: ModelMessage[], tools: ToolDefinition[]): Promise<ModelResponse>; }
export interface ToolContext { sessionId: string; spec: TaskSpec; workspace: string; signal?: AbortSignal; }
export interface ToolDefinition {
  name: string; description: string; risk: Risk; sideEffect: boolean;
  schema: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
export interface ApprovalRequest { sessionId: string; tool: string; args: Record<string, unknown>; risk: Risk; reason: string; }
export type ApprovalResponse = "allow-once" | "allow-session" | "deny";
export interface UserChannel { approve(request: ApprovalRequest): Promise<ApprovalResponse>; ask?(question: string): Promise<string>; }
export interface PermissionResult { decision: PermissionDecision; rule: string; reason: string; }
export interface PermissionPolicy { evaluate(tool: ToolDefinition, args: Record<string, unknown>, spec: TaskSpec): PermissionResult; }
export interface AgentEvent<T = unknown> { id: number; sessionId: string; type: string; at: string; parentId?: number; payload: T; }

export interface RunSummary {
  sessionId: string; status: TaskStatus; turns: number; toolCalls: number;
  validationRuns: number; approvals: number; policyViolations: number;
  error?: string; finalStateDigest?: string;
}
