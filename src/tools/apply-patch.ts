import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ToolResult } from "../types.ts";
import { WorkspaceSandboxError } from "../workspace/errors.ts";
import {
    applyStructuredEdits,
    type StructuredEdit,
} from "../workspace/patch.ts";
import type { WorkspaceSandbox } from "../workspace/sandbox.ts";
import type { AgentTool } from "./tool.ts";

type ApplyPatchInput = {
    readonly path: string;
    readonly edits: readonly StructuredEdit[];
};

export type ApplyPatchRuntime = {
    nextTemporaryName(): string;
    beforeCommit?(absolutePath: string): Promise<void>;
};

const defaultRuntime: ApplyPatchRuntime = {
    nextTemporaryName: randomUUID,
};

function parseInput(input: unknown): ApplyPatchInput | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return undefined;
    }
    const path = Reflect.get(input, "path");
    const edits = Reflect.get(input, "edits");
    if (typeof path !== "string" || !Array.isArray(edits)) {
        return undefined;
    }

    const parsedEdits: StructuredEdit[] = [];
    for (const edit of edits) {
        if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
            return undefined;
        }
        const oldText = Reflect.get(edit, "oldText");
        const newText = Reflect.get(edit, "newText");
        if (typeof oldText !== "string" || typeof newText !== "string") {
            return undefined;
        }
        parsedEdits.push({ oldText, newText });
    }
    return { path, edits: parsedEdits };
}

function failure(code: string, message: string, details?: unknown): ToolResult {
    return {
        ok: false,
        error: details === undefined ? { code, message } : { code, message, details },
    };
}

export class ApplyPatchTool implements AgentTool {
    readonly name = "apply_patch";
    readonly description =
        "Apply ordered exact source-text replacements to an existing workspace file. Patch text must come from file content, never command output or logs.";
    readonly inputSchema = {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Workspace-relative file path.",
            },
            edits: {
                type: "array",
                minItems: 1,
                items: {
                    type: "object",
                    properties: {
                        oldText: {
                            type: "string",
                            description:
                                "Exact substring copied from the latest read_file result, including whitespace and quote or backtick delimiters.",
                        },
                        newText: {
                            type: "string",
                            description:
                                "Syntactically valid replacement source text only. Preserve surrounding quote or backtick delimiters unless changing them is required.",
                        },
                    },
                    required: ["oldText", "newText"],
                    additionalProperties: false,
                },
            },
        },
        required: ["path", "edits"],
        additionalProperties: false,
    } as const;
    readonly permission = { action: "workspace-write", risk: "write" } as const;
    private readonly sandbox: WorkspaceSandbox;
    private readonly maxBytes: number;
    private readonly runtime: ApplyPatchRuntime;

    constructor(
        sandbox: WorkspaceSandbox,
        maxBytes = 500_000,
        runtime: ApplyPatchRuntime = defaultRuntime,
    ) {
        this.sandbox = sandbox;
        this.maxBytes = maxBytes;
        this.runtime = runtime;
    }

    async execute(input: unknown): Promise<ToolResult> {
        const patch = parseInput(input);
        if (patch === undefined) {
            return failure(
                "tool_input_invalid",
                "apply_patch input must contain path and an edits array of oldText/newText pairs",
            );
        }

        let temporaryPath: string | undefined;
        try {
            const resolved = await this.sandbox.resolveExistingPath(patch.path);
            const originalBuffer = await readFile(resolved.absolutePath);
            if (originalBuffer.byteLength > this.maxBytes) {
                return failure(
                    "file_too_large",
                    `File exceeds the ${this.maxBytes} byte patch limit: ${patch.path}`,
                );
            }
            if (originalBuffer.includes(0)) {
                return failure(
                    "file_type_invalid",
                    `apply_patch can only modify text files: ${patch.path}`,
                );
            }

            const patchResult = applyStructuredEdits(
                originalBuffer.toString("utf8"),
                patch.edits,
            );
            if (!patchResult.ok) {
                return failure(
                    patchResult.error.code,
                    patchResult.error.message,
                    { editIndex: patchResult.error.editIndex },
                );
            }

            await this.runtime.beforeCommit?.(resolved.absolutePath);
            const latestResolved = await this.sandbox.resolveExistingPath(patch.path);
            if (latestResolved.absolutePath !== resolved.absolutePath) {
                return failure(
                    "patch_conflict",
                    `File target changed before the patch could be written: ${patch.path}`,
                );
            }
            const latestBuffer = await readFile(latestResolved.absolutePath);
            if (!latestBuffer.equals(originalBuffer)) {
                return failure(
                    "patch_conflict",
                    `File changed before the patch could be written: ${patch.path}`,
                );
            }

            const originalStats = await stat(resolved.absolutePath);
            temporaryPath = join(
                dirname(resolved.absolutePath),
                `.codetau-patch-${this.runtime.nextTemporaryName()}.tmp`,
            );
            const handle = await open(temporaryPath, "wx", originalStats.mode);
            try {
                await handle.writeFile(patchResult.content, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(temporaryPath, resolved.absolutePath);
            temporaryPath = undefined;

            return {
                ok: true,
                output: {
                    path: resolved.relativePath,
                    editsApplied: patchResult.editsApplied,
                    bytes: Buffer.byteLength(patchResult.content, "utf8"),
                },
            };
        } catch (error) {
            if (error instanceof WorkspaceSandboxError) {
                return failure(error.code, error.message);
            }
            return failure(
                "patch_write_failed",
                error instanceof Error ? error.message : "Unknown patch write error",
            );
        } finally {
            if (temporaryPath !== undefined) {
                await rm(temporaryPath, { force: true }).catch(() => undefined);
            }
        }
    }
}
