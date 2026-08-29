import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { ToolResult } from "../types.ts";
import { WorkspaceSandboxError } from "../workspace/errors.ts";
import type { WorkspaceSandbox } from "../workspace/sandbox.ts";
import type { AgentTool } from "./tool.ts";

function readInput(input: unknown):
    | { path: string; startLine?: number; endLine?: number }
    | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return undefined;
    }
    const path = Reflect.get(input, "path");
    const startLine = Reflect.get(input, "startLine");
    const endLine = Reflect.get(input, "endLine");
    if (
        typeof path !== "string" ||
        (startLine !== undefined &&
            (!Number.isSafeInteger(startLine) || (startLine as number) < 1)) ||
        (endLine !== undefined &&
            (!Number.isSafeInteger(endLine) || (endLine as number) < 1)) ||
        (startLine !== undefined &&
            endLine !== undefined &&
            (endLine as number) < (startLine as number))
    ) {
        return undefined;
    }
    return {
        path,
        ...(startLine === undefined ? {} : { startLine: startLine as number }),
        ...(endLine === undefined ? {} : { endLine: endLine as number }),
    };
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
            startLine: {
                type: "integer",
                minimum: 1,
                description: "Optional 1-based first line to return.",
            },
            endLine: {
                type: "integer",
                minimum: 1,
                description: "Optional inclusive 1-based last line to return.",
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
        const parsed = readInput(input);
        if (parsed === undefined) {
            return {
                ok: false,
                error: {
                    code: "tool_input_invalid",
                    message:
                        "read_file input must contain a string path and a valid optional startLine/endLine range",
                },
            };
        }

        try {
            const requestedPath = parsed.path;
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
                const ranged =
                    parsed.startLine !== undefined || parsed.endLine !== undefined;
                if (!ranged && stats.size > this.maxBytes) {
                    return {
                        ok: false,
                        error: {
                            code: "file_too_large",
                            message: `File exceeds the ${this.maxBytes} byte read limit: ${requestedPath}`,
                        },
                    };
                }

                if (ranged) {
                    await handle.close();
                    const startLine = parsed.startLine ?? 1;
                    const requestedEnd = parsed.endLine ?? Number.MAX_SAFE_INTEGER;
                    const selected: string[] = [];
                    let totalLines = 0;
                    let selectedBytes = 0;
                    const lines = createInterface({
                        input: createReadStream(resolved.absolutePath, {
                            encoding: "utf8",
                        }),
                        crlfDelay: Infinity,
                    });
                    for await (const line of lines) {
                        totalLines += 1;
                        if (totalLines < startLine || totalLines > requestedEnd) {
                            continue;
                        }
                        const additionalBytes =
                            Buffer.byteLength(line, "utf8") +
                            (selected.length === 0 ? 0 : 1);
                        if (selectedBytes + additionalBytes > this.maxBytes) {
                            lines.close();
                            return {
                                ok: false,
                                error: {
                                    code: "file_too_large",
                                    message: `Selected line range exceeds the ${this.maxBytes} byte read limit: ${requestedPath}`,
                                },
                            };
                        }
                        selected.push(line);
                        selectedBytes += additionalBytes;
                    }
                    if (startLine > totalLines && !(startLine === 1 && totalLines === 0)) {
                        return {
                            ok: false,
                            error: {
                                code: "line_range_invalid",
                                message: `startLine ${startLine} exceeds the file's ${totalLines} lines: ${requestedPath}`,
                            },
                        };
                    }
                    const actualEnd = Math.min(requestedEnd, totalLines);
                    return {
                        ok: true,
                        output: {
                            path: resolved.relativePath,
                            content: selected.join("\n"),
                            bytes: selectedBytes,
                            startLine,
                            endLine: actualEnd,
                            totalLines,
                            truncated: startLine > 1 || actualEnd < totalLines,
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
                await handle.close().catch(() => undefined);
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
