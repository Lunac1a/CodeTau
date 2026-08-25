import { open } from "node:fs/promises";

import type { ToolResult } from "../types.ts";
import { WorkspaceSandboxError } from "../workspace/errors.ts";
import type { WorkspaceSandbox } from "../workspace/sandbox.ts";
import type { AgentTool } from "./tool.ts";

type CreateFileInput = {
    readonly path: string;
    readonly content: string;
};

function parseInput(input: unknown): CreateFileInput | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return undefined;
    }
    const path = Reflect.get(input, "path");
    const content = Reflect.get(input, "content");
    return typeof path === "string" && typeof content === "string"
        ? { path, content }
        : undefined;
}

function failure(code: string, message: string): ToolResult {
    return { ok: false, error: { code, message } };
}

export class CreateFileTool implements AgentTool {
    readonly name = "create_file";
    readonly description =
        "Create a new UTF-8 text file in an existing workspace directory. Never overwrites a file.";
    readonly inputSchema = {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Workspace-relative path for the new file.",
            },
            content: {
                type: "string",
                description: "Complete UTF-8 text content for the new file.",
            },
        },
        required: ["path", "content"],
        additionalProperties: false,
    } as const;
    readonly permission = { action: "workspace-write", risk: "write" } as const;
    private readonly sandbox: WorkspaceSandbox;
    private readonly maxBytes: number;

    constructor(
        sandbox: WorkspaceSandbox,
        maxBytes = 500_000,
    ) {
        this.sandbox = sandbox;
        this.maxBytes = maxBytes;
    }

    async execute(input: unknown): Promise<ToolResult> {
        const parsed = parseInput(input);
        if (parsed === undefined || parsed.path.trim() === "") {
            return failure(
                "tool_input_invalid",
                "create_file input must contain a path and text content",
            );
        }
        const bytes = Buffer.byteLength(parsed.content, "utf8");
        if (bytes > this.maxBytes) {
            return failure(
                "file_too_large",
                `File exceeds the ${this.maxBytes} byte creation limit: ${parsed.path}`,
            );
        }

        try {
            const resolved = await this.sandbox.resolveNewFilePath(parsed.path);
            const handle = await open(resolved.absolutePath, "wx");
            try {
                await handle.writeFile(parsed.content, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            return {
                ok: true,
                output: { path: resolved.relativePath, bytes },
            };
        } catch (error) {
            if (error instanceof WorkspaceSandboxError) {
                return failure(error.code, error.message);
            }
            if (
                typeof error === "object" &&
                error !== null &&
                Reflect.get(error, "code") === "EEXIST"
            ) {
                return failure(
                    "file_already_exists",
                    `File already exists: ${parsed.path}`,
                );
            }
            return failure(
                "file_create_failed",
                error instanceof Error ? error.message : "Unknown file creation error",
            );
        }
    }
}
