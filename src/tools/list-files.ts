import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ToolResult } from "../types.ts";
import { WorkspaceSandboxError } from "../workspace/errors.ts";
import type { WorkspaceSandbox } from "../workspace/sandbox.ts";
import type { AgentTool } from "./tool.ts";

function isEmptyObject(input: unknown): boolean {
    return (
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Object.keys(input).length === 0
    );
}

export class ListFilesTool implements AgentTool {
    readonly name = "list_files";
    readonly description =
        "List regular files visible inside the allowed workspace paths.";
    readonly inputSchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
    } as const;
    readonly permission = { action: "workspace-read", risk: "read" } as const;

    private readonly sandbox: WorkspaceSandbox;
    private readonly maxFiles: number;
    private readonly maxVisitedEntries: number;

    constructor(
        sandbox: WorkspaceSandbox,
        maxFiles = 200,
        maxVisitedEntries = 10_000,
    ) {
        this.sandbox = sandbox;
        this.maxFiles = maxFiles;
        this.maxVisitedEntries = maxVisitedEntries;
    }

    async execute(input: unknown): Promise<ToolResult> {
        if (!isEmptyObject(input)) {
            return {
                ok: false,
                error: {
                    code: "tool_input_invalid",
                    message: "list_files input must be an empty object",
                },
            };
        }

        const pendingDirectories = [""];
        const paths: string[] = [];
        let visitedEntries = 0;
        let truncated = false;

        try {
            while (pendingDirectories.length > 0 && !truncated) {
                const relativeDirectory = pendingDirectories.pop() ?? "";
                const absoluteDirectory = join(
                    this.sandbox.workspaceRoot(),
                    ...relativeDirectory.split("/").filter(Boolean),
                );
                const entries = await readdir(absoluteDirectory, {
                    withFileTypes: true,
                });
                entries.sort((left, right) => left.name.localeCompare(right.name));

                for (const entry of entries) {
                    visitedEntries += 1;
                    if (visitedEntries > this.maxVisitedEntries) {
                        truncated = true;
                        break;
                    }

                    const relativePath = [relativeDirectory, entry.name]
                        .filter(Boolean)
                        .join("/");
                    if (entry.isDirectory()) {
                        try {
                            await this.sandbox.resolveExistingPath(relativePath);
                            pendingDirectories.push(relativePath);
                        } catch (error) {
                            if (
                                error instanceof WorkspaceSandboxError &&
                                (error.code === "workspace_path_not_allowed" ||
                                    error.code === "workspace_path_outside")
                            ) {
                                continue;
                            }
                            throw error;
                        }
                        continue;
                    }
                    if (!entry.isFile()) {
                        continue;
                    }

                    try {
                        const resolved = await this.sandbox.resolveExistingPath(relativePath);
                        paths.push(resolved.relativePath);
                    } catch (error) {
                        if (
                            error instanceof WorkspaceSandboxError &&
                            (error.code === "workspace_path_not_allowed" ||
                                error.code === "workspace_path_outside")
                        ) {
                            continue;
                        }
                        throw error;
                    }

                    if (paths.length >= this.maxFiles) {
                        truncated = true;
                        break;
                    }
                }
            }

            paths.sort((left, right) => left.localeCompare(right));
            return {
                ok: true,
                output: { paths, truncated },
            };
        } catch (error) {
            return {
                ok: false,
                error: {
                    code: "file_list_failed",
                    message:
                        error instanceof Error
                            ? error.message
                            : "Unknown workspace listing error",
                },
            };
        }
    }
}
