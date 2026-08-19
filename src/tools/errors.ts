export type ToolRegistryErrorCode =
    | "tool_name_invalid"
    | "tool_already_registered";

export class ToolRegistryError extends Error {
    readonly code: ToolRegistryErrorCode;
    readonly toolName: string;

    constructor(options: {
        code: ToolRegistryErrorCode;
        message: string;
        toolName: string;
    }) {
        super(options.message);
        this.name = "ToolRegistryError";
        this.code = options.code;
        this.toolName = options.toolName;
    }
}
