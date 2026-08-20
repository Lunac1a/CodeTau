import { open } from "node:fs/promises";

import type { ToolResult } from "../types.ts";
import { WorkspaceSandboxError } from "../workspace/errors.ts";
import type { WorkspaceSandbox } from "../workspace/sandbox.ts";
import type { AgentTool } from "./tool.ts";

function readPath(input: unknown): string | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return undefined;
    }
    const path = Reflect.get(input, "path");
    return typeof path === "string" ? path : undefined;
}

export class ReadFileTool implements AgentTool {
    readonly name = "read_file";
    readonly description = "Read a UTF-8 text file inside the allowed workspace.";
    readonly inputSchema = {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Workspace-relative file path.",
            },
        },
        required: ["path"],
        additionalProperties: false,
    } as const;
    readonly permission = { action: "workspace-read", risk: "read" } as const;
    private readonly sandbox: WorkspaceSandbox;
    private readonly maxBytes: number;

    constructor(sandbox: WorkspaceSandbox, maxBytes = 100_000) {
        this.sandbox = sandbox;
        this.maxBytes = maxBytes;
    }

    async execute(input: unknown): Promise<ToolResult> {
        const requestedPath = readPath(input);
        if (requestedPath === undefined) {
            return {
                ok: false,
                error: {
                    code: "tool_input_invalid",
                    message: "read_file input must contain a string path",
                },
            };
        }

        try {
            const resolved = await this.sandbox.resolveExistingPath(requestedPath);
            const handle = await open(resolved.absolutePath, "r");
            try {
                const stats = await handle.stat();
                if (!stats.isFile()) {
                    return {
                        ok: false,
                        error: {
                            code: "file_type_invalid",
                            message: `read_file can only read regular files: ${requestedPath}`,
                        },
                    };
                }
                if (stats.size > this.maxBytes) {
                    return {
                        ok: false,
                        error: {
                            code: "file_too_large",
                            message: `File exceeds the ${this.maxBytes} byte read limit: ${requestedPath}`,
                        },
                    };
                }

                const buffer = Buffer.alloc(this.maxBytes + 1);
                const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.length,
                    0,
                );
                if (bytesRead > this.maxBytes) {
                    return {
                        ok: false,
                        error: {
                            code: "file_too_large",
                            message: `File exceeds the ${this.maxBytes} byte read limit: ${requestedPath}`,
                        },
                    };
                }

                return {
                    ok: true,
                    output: {
                        path: resolved.relativePath,
                        content: buffer.subarray(0, bytesRead).toString("utf8"),
                        bytes: bytesRead,
                    },
                };
            } finally {
                await handle.close();
            }
        } catch (error) {
            if (error instanceof WorkspaceSandboxError) {
                return {
                    ok: false,
                    error: {
                        code: error.code,
                        message: error.message,
                    },
                };
            }
            return {
                ok: false,
                error: {
                    code: "file_read_failed",
                    message: error instanceof Error ? error.message : "Unknown file read error",
                },
            };
        }
    }
}
