export type ModelProviderErrorCode =
    | "invalid_configuration"
    | "request_failed"
    | "http_error"
    | "invalid_response"
    | "invalid_tool_call";

export class ModelProviderError extends Error {
    readonly code: ModelProviderErrorCode;
    readonly status?: number;

    constructor(options: {
        code: ModelProviderErrorCode;
        message: string;
        status?: number;
        cause?: unknown;
    }) {
        super(options.message, { cause: options.cause });
        this.name = "ModelProviderError";
        this.code = options.code;
        this.status = options.status;
    }
}
