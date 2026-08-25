import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { WorkspaceSandboxError } from "./errors.ts";

export type ResolvedWorkspacePath = {
    readonly absolutePath: string;
    readonly relativePath: string;
};

function normalizeRelativePath(target: string): string {
    if (target.trim() === "" || target.includes("\0")) {
        throw new WorkspaceSandboxError({
            code: "workspace_path_invalid",
            message: "Workspace path must be a non-empty relative path",
            target,
        });
    }

    const portablePath = target.replaceAll("\\", "/");
    if (isAbsolute(target) || portablePath.startsWith("/")) {
        throw new WorkspaceSandboxError({
            code: "workspace_path_outside",
            message: `Absolute workspace paths are not allowed: ${target}`,
            target,
        });
    }

    const segments = portablePath.split("/").filter((segment) => segment !== "");
    if (segments.some((segment) => segment === "..")) {
        throw new WorkspaceSandboxError({
            code: "workspace_path_outside",
            message: `Workspace path traversal is not allowed: ${target}`,
            target,
        });
    }

    const normalized = segments.filter((segment) => segment !== ".").join("/");
    if (normalized === "") {
        throw new WorkspaceSandboxError({
            code: "workspace_path_invalid",
            message: "Workspace path must identify a file or directory",
            target,
        });
    }
    return normalized;
}

function normalizePattern(pattern: string): readonly string[] {
    const portablePattern = pattern.replaceAll("\\", "/");
    if (
        portablePattern.trim() === "" ||
        portablePattern.startsWith("/") ||
        isAbsolute(pattern)
    ) {
        throw new WorkspaceSandboxError({
            code: "workspace_pattern_invalid",
            message: `Allowed path pattern must be relative: ${pattern}`,
            target: pattern,
        });
    }

    const segments = portablePattern.split("/").filter((segment) => segment !== "");
    if (segments.some((segment) => segment === ".." || segment === ".")) {
        throw new WorkspaceSandboxError({
            code: "workspace_pattern_invalid",
            message: `Allowed path pattern cannot contain traversal: ${pattern}`,
            target: pattern,
        });
    }
    return segments;
}

function segmentMatches(value: string, pattern: string): boolean {
    let expression = "^";
    for (const character of pattern) {
        if (character === "*") {
            expression += ".*";
        } else if (character === "?") {
            expression += ".";
        } else {
            expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
        }
    }
    expression += "$";
    return new RegExp(expression).test(value);
}

function pathMatches(
    pathSegments: readonly string[],
    patternSegments: readonly string[],
    pathIndex = 0,
    patternIndex = 0,
): boolean {
    if (patternIndex === patternSegments.length) {
        return pathIndex === pathSegments.length;
    }

    const pattern = patternSegments[patternIndex];
    if (pattern === "**") {
        return (
            pathMatches(pathSegments, patternSegments, pathIndex, patternIndex + 1) ||
            (pathIndex < pathSegments.length &&
                pathMatches(pathSegments, patternSegments, pathIndex + 1, patternIndex))
        );
    }

    return (
        pathIndex < pathSegments.length &&
        segmentMatches(pathSegments[pathIndex], pattern) &&
        pathMatches(pathSegments, patternSegments, pathIndex + 1, patternIndex + 1)
    );
}

function isWithinRoot(root: string, target: string): boolean {
    const difference = relative(root, target);
    return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== "..");
}

function filesystemErrorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
    }
    return typeof error.code === "string" ? error.code : undefined;
}

export class WorkspaceSandbox {
    private readonly root: string;
    private readonly allowedPatterns: readonly (readonly string[])[];
    private readonly deniedPatterns: readonly (readonly string[])[];

    private constructor(
        root: string,
        allowedPatterns: readonly (readonly string[])[],
        deniedPatterns: readonly (readonly string[])[],
    ) {
        this.root = root;
        this.allowedPatterns = allowedPatterns;
        this.deniedPatterns = deniedPatterns;
    }

    static async create(
        workspaceRoot: string,
        allowedPaths: readonly string[],
        deniedPaths: readonly string[] = [],
    ): Promise<WorkspaceSandbox> {
        const allowedPatterns = allowedPaths.map(normalizePattern);
        const deniedPatterns = deniedPaths.map(normalizePattern);
        try {
            const canonicalRoot = await realpath(resolve(workspaceRoot));
            const rootStats = await stat(canonicalRoot);
            if (!rootStats.isDirectory()) {
                throw new WorkspaceSandboxError({
                    code: "workspace_root_invalid",
                    message: `Workspace root is not a directory: ${workspaceRoot}`,
                    target: workspaceRoot,
                });
            }
            return new WorkspaceSandbox(
                canonicalRoot,
                allowedPatterns,
                deniedPatterns,
            );
        } catch (error) {
            if (error instanceof WorkspaceSandboxError) {
                throw error;
            }
            throw new WorkspaceSandboxError({
                code: "workspace_root_invalid",
                message: `Workspace root is unavailable: ${workspaceRoot}`,
                target: workspaceRoot,
                cause: error,
            });
        }
    }

    workspaceRoot(): string {
        return this.root;
    }

    async resolveExistingPath(target: string): Promise<ResolvedWorkspacePath> {
        const normalizedTarget = normalizeRelativePath(target);
        this.assertAllowed(normalizedTarget, target);

        const lexicalPath = resolve(this.root, ...normalizedTarget.split("/"));
        if (!isWithinRoot(this.root, lexicalPath)) {
            throw new WorkspaceSandboxError({
                code: "workspace_path_outside",
                message: `Workspace path escapes the root: ${target}`,
                target,
            });
        }

        let canonicalPath: string;
        try {
            canonicalPath = await realpath(lexicalPath);
        } catch (error) {
            const code = filesystemErrorCode(error);
            throw new WorkspaceSandboxError({
                code:
                    code === "ENOENT"
                        ? "workspace_path_not_found"
                        : "workspace_path_unavailable",
                message:
                    code === "ENOENT"
                        ? `Workspace path does not exist: ${target}`
                        : `Workspace path is unavailable: ${target}`,
                target,
                cause: error,
            });
        }

        if (!isWithinRoot(this.root, canonicalPath)) {
            throw new WorkspaceSandboxError({
                code: "workspace_path_outside",
                message: `Workspace path resolves outside the root: ${target}`,
                target,
            });
        }

        const canonicalRelativePath = relative(this.root, canonicalPath).split(sep).join("/");
        this.assertAllowed(canonicalRelativePath, target);
        return { absolutePath: canonicalPath, relativePath: canonicalRelativePath };
    }

    async resolveNewFilePath(target: string): Promise<ResolvedWorkspacePath> {
        const normalizedTarget = normalizeRelativePath(target);
        this.assertAllowed(normalizedTarget, target);

        const lexicalPath = resolve(this.root, ...normalizedTarget.split("/"));
        if (!isWithinRoot(this.root, lexicalPath)) {
            throw new WorkspaceSandboxError({
                code: "workspace_path_outside",
                message: `Workspace path escapes the root: ${target}`,
                target,
            });
        }

        let canonicalParent: string;
        try {
            canonicalParent = await realpath(dirname(lexicalPath));
            const parentStats = await stat(canonicalParent);
            if (!parentStats.isDirectory()) {
                throw new Error("Parent path is not a directory");
            }
        } catch (error) {
            throw new WorkspaceSandboxError({
                code: "workspace_parent_invalid",
                message: `Parent directory is unavailable: ${target}`,
                target,
                cause: error,
            });
        }

        if (!isWithinRoot(this.root, canonicalParent)) {
            throw new WorkspaceSandboxError({
                code: "workspace_path_outside",
                message: `Workspace parent resolves outside the root: ${target}`,
                target,
            });
        }
        const absolutePath = join(canonicalParent, basename(lexicalPath));
        const relativePath = relative(this.root, absolutePath).split(sep).join("/");
        this.assertAllowed(relativePath, target);
        return { absolutePath, relativePath };
    }

    private assertAllowed(normalizedPath: string, originalTarget: string): void {
        const pathSegments = normalizedPath.split("/");
        if (
            this.deniedPatterns.some((pattern) =>
                pathMatches(pathSegments, pattern),
            )
        ) {
            throw new WorkspaceSandboxError({
                code: "workspace_path_not_allowed",
                message: `Workspace path is protected by deniedPaths: ${originalTarget}`,
                target: originalTarget,
            });
        }
        if (
            !this.allowedPatterns.some((pattern) =>
                pathMatches(pathSegments, pattern),
            )
        ) {
            throw new WorkspaceSandboxError({
                code: "workspace_path_not_allowed",
                message: `Workspace path is outside allowedPaths: ${originalTarget}`,
                target: originalTarget,
            });
        }
    }
}
