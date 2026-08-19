import type { ToolResult } from "../types.ts";

export interface AgentTool {
    readonly name: string;

    execute(input: unknown): Promise<ToolResult>;
}
