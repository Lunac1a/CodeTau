export type SpecErrorCode =
    | "spec_read_failed"
    | "spec_frontmatter_missing"
    | "spec_yaml_invalid"
    | "spec_schema_invalid";

export type SpecValidationIssue = {
    path: string;
    message: string;
    keyword: string;
};

export class SpecLoadError extends Error {
    readonly code: SpecErrorCode;
    readonly sourcePath: string;
    readonly issues: readonly SpecValidationIssue[];

    constructor(options: {
        code: SpecErrorCode;
        message: string;
        sourcePath: string;
        issues?: readonly SpecValidationIssue[];
        cause?: unknown;
    }) {
        super(options.message, { cause: options.cause });
        this.name = "SpecLoadError";
        this.code = options.code;
        this.sourcePath = options.sourcePath;
        this.issues = options.issues ?? [];
    }
}
