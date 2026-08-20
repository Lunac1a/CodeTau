import type { ToolCall, ToolResult } from "../types.ts";
import { ToolRegistryError } from "./errors.ts";
import type { AgentTool, ToolDefinition } from "./tool.ts";

function executionErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown tool execution error";
}

export class ToolRegistry {
    private readonly tools = new Map<string, AgentTool>();

    constructor(tools: readonly AgentTool[] = []) {
        for (const tool of tools) {
            this.register(tool);
        }
    }

    register(tool: AgentTool): void {
        if (tool.name.trim() === "") {
            throw new ToolRegistryError({
                code: "tool_name_invalid",
                message: "Tool name must not be empty",
                toolName: tool.name,
            });
        }

        if (tool.permission.action.trim() === "") {
            throw new ToolRegistryError({
                code: "tool_action_invalid",
                message: `Tool action must not be empty: ${tool.name}`,
                toolName: tool.name,
            });
        }

        if (tool.description.trim() === "") {
            throw new ToolRegistryError({
                code: "tool_description_invalid",
                message: `Tool description must not be empty: ${tool.name}`,
                toolName: tool.name,
            });
        }

        if (
            typeof tool.inputSchema !== "object" ||
            tool.inputSchema === null ||
            Array.isArray(tool.inputSchema)
        ) {
            throw new ToolRegistryError({
                code: "tool_schema_invalid",
                message: `Tool input schema must be an object: ${tool.name}`,
                toolName: tool.name,
            });
        }

        if (this.tools.has(tool.name)) {
            throw new ToolRegistryError({
                code: "tool_already_registered",
                message: `Tool is already registered: ${tool.name}`,
                toolName: tool.name,
            });
        }

        this.tools.set(tool.name, tool);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    get(name: string): AgentTool | undefined {
        return this.tools.get(name);
    }

    names(): readonly string[] {
        return [...this.tools.keys()].sort();
    }

    definitions(): readonly ToolDefinition[] {
        return this.names().map((name) => {
            const tool = this.tools.get(name);
            if (tool === undefined) {
                throw new Error(`Registered tool disappeared: ${name}`);
            }
            return {
                name: tool.name,
                description: tool.description,
                inputSchema: structuredClone(tool.inputSchema),
            };
        });
    }

    async execute(call: ToolCall): Promise<ToolResult> {
        const tool = this.tools.get(call.name);

        if (tool === undefined) {
            return {
                ok: false,
                error: {
                    code: "tool_not_found",
                    message: `Tool is not registered: ${call.name}`,
                },
            };
        }

        try {
            return await tool.execute(call.input);
        } catch (error) {
            return {
                ok: false,
                error: {
                    code: "tool_execution_failed",
                    message: executionErrorMessage(error),
                },
            };
        }
    }
}
