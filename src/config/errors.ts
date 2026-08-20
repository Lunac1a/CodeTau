export type ConfigLoadErrorCode =
    | "config_read_failed"
    | "config_json_invalid"
    | "config_shape_invalid";

export class ConfigLoadError extends Error {
    readonly code: ConfigLoadErrorCode;
    readonly sourcePath: string;

    constructor(options: {
        code: ConfigLoadErrorCode;
        message: string;
        sourcePath: string;
        cause?: unknown;
    }) {
        super(options.message, { cause: options.cause });
        this.name = "ConfigLoadError";
        this.code = options.code;
        this.sourcePath = options.sourcePath;
    }
}
