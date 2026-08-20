import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ConfigLoadError } from "./errors.ts";

export type CodeTauConfig = Readonly<{
    databasePath: string;
    model: string;
    baseUrl: string;
    commandAllowlist: readonly string[];
    commandTimeoutMs: number;
    maxOutputBytes: number;
    sourcePath: string;
    rootDirectory: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function invalidShape(sourcePath: string, message: string): never {
    throw new ConfigLoadError({
        code: "config_shape_invalid",
        message,
        sourcePath,
    });
}

function parseConfig(value: unknown, sourcePath: string): CodeTauConfig {
    if (!isRecord(value)) {
        invalidShape(sourcePath, "CodeTau configuration must be a JSON object");
    }

    const allowedKeys = new Set([
        "database",
        "model",
        "baseUrl",
        "commandAllowlist",
        "commandTimeoutMs",
        "maxOutputBytes",
    ]);
    const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
        invalidShape(sourcePath, `Unknown CodeTau configuration field: ${unknownKey}`);
    }
    if (!nonEmptyString(value.database)) {
        invalidShape(sourcePath, "Configuration database must be a non-empty path");
    }
    if (!nonEmptyString(value.model)) {
        invalidShape(sourcePath, "Configuration model must be a non-empty string");
    }
    if (!nonEmptyString(value.baseUrl)) {
        invalidShape(sourcePath, "Configuration baseUrl must be a non-empty URL");
    }
    if (
        !Array.isArray(value.commandAllowlist) ||
        value.commandAllowlist.some((item) => !nonEmptyString(item))
    ) {
        invalidShape(
            sourcePath,
            "Configuration commandAllowlist must contain only non-empty strings",
        );
    }
    if (!positiveInteger(value.commandTimeoutMs)) {
        invalidShape(
            sourcePath,
            "Configuration commandTimeoutMs must be a positive integer",
        );
    }
    if (!positiveInteger(value.maxOutputBytes)) {
        invalidShape(
            sourcePath,
            "Configuration maxOutputBytes must be a positive integer",
        );
    }

    const rootDirectory = dirname(sourcePath);
    return {
        databasePath: resolve(rootDirectory, value.database),
        model: value.model.trim(),
        baseUrl: value.baseUrl.trim(),
        commandAllowlist: value.commandAllowlist.map((item) => item.trim()),
        commandTimeoutMs: value.commandTimeoutMs,
        maxOutputBytes: value.maxOutputBytes,
        sourcePath,
        rootDirectory,
    };
}

export async function loadCodeTauConfig(path: string): Promise<CodeTauConfig> {
    const sourcePath = resolve(path);
    let source: string;
    try {
        source = await readFile(sourcePath, "utf8");
    } catch (error) {
        throw new ConfigLoadError({
            code: "config_read_failed",
            message: `Unable to read CodeTau configuration: ${sourcePath}`,
            sourcePath,
            cause: error,
        });
    }

    let value: unknown;
    try {
        value = JSON.parse(source) as unknown;
    } catch (error) {
        throw new ConfigLoadError({
            code: "config_json_invalid",
            message: `CodeTau configuration is not valid JSON: ${sourcePath}`,
            sourcePath,
            cause: error,
        });
    }
    return parseConfig(value, sourcePath);
}
