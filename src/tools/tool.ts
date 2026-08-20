import type { ToolResult } from "../types.ts";

export type ToolRisk = "read" | "write" | "execute";

export type ToolPermission = {
    readonly action: string;
    readonly risk: ToolRisk;
};

export type ToolInputSchema = Readonly<Record<string, unknown>>;

export type ToolDefinition = Readonly<{
    name: string;
    description: string;
    inputSchema: ToolInputSchema;
}>;

export interface AgentTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: ToolInputSchema;
    readonly permission: ToolPermission;

    execute(input: unknown): Promise<ToolResult>;
}
