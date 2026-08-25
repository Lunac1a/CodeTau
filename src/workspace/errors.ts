export type WorkspaceSandboxErrorCode =
    | "workspace_root_invalid"
    | "workspace_pattern_invalid"
    | "workspace_path_invalid"
    | "workspace_path_outside"
    | "workspace_path_not_allowed"
    | "workspace_parent_invalid"
    | "workspace_path_not_found"
    | "workspace_path_unavailable";

export class WorkspaceSandboxError extends Error {
    readonly code: WorkspaceSandboxErrorCode;
    readonly target?: string;

    constructor(options: {
        code: WorkspaceSandboxErrorCode;
        message: string;
        target?: string;
        cause?: unknown;
    }) {
        super(options.message, { cause: options.cause });
        this.name = "WorkspaceSandboxError";
        this.code = options.code;
        this.target = options.target;
    }
}
