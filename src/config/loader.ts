import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
    DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
} from "../context/manager.ts";
import type { ContextManagementConfig } from "../context/types.ts";
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
    contextManagement: ContextManagementConfig;
    naturalLanguage: Readonly<{
        maxModelTurns: number;
        maxToolCalls: number;
        maxRetries: number;
        additionalProtectedPaths: readonly string[];
    }>;
}>;

const NATURAL_LANGUAGE_DEFAULTS = {
    maxModelTurns: 20,
    maxToolCalls: 60,
    maxRetries: 3,
    additionalProtectedPaths: [] as readonly string[],
};

function parseContextManagement(
    value: unknown,
    sourcePath: string,
): ContextManagementConfig {
    if (value === undefined) return DEFAULT_CONTEXT_MANAGEMENT_CONFIG;
    if (!isRecord(value)) {
        invalidShape(sourcePath, "Configuration contextManagement must be an object");
    }
    const allowedKeys = new Set(Object.keys(DEFAULT_CONTEXT_MANAGEMENT_CONFIG));
    const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
        invalidShape(
            sourcePath,
            `Unknown contextManagement configuration field: ${unknownKey}`,
        );
    }
    const parsed = {
        ...DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
        ...value,
    } as Record<keyof ContextManagementConfig, unknown>;
    for (const key of [
        "maxContextTokens",
        "reservedOutputTokens",
        "recentConversationTurns",
        "recentToolExchanges",
        "maxSummaryTokens",
        "maxToolResultTokens",
    ] as const) {
        if (!positiveInteger(parsed[key])) {
            invalidShape(sourcePath, `contextManagement.${key} must be positive`);
        }
    }
    if (
        !nonNegativeInteger(parsed.safetyMarginPercent) ||
        (parsed.safetyMarginPercent as number) >= 100
    ) {
        invalidShape(
            sourcePath,
            "contextManagement.safetyMarginPercent must be between 0 and 99",
        );
    }
    if (
        (parsed.reservedOutputTokens as number) >=
        (parsed.maxContextTokens as number)
    ) {
        invalidShape(
            sourcePath,
            "contextManagement.reservedOutputTokens must be less than maxContextTokens",
        );
    }
    if (
        Math.floor(
            ((parsed.maxContextTokens as number) -
                (parsed.reservedOutputTokens as number)) *
                (1 - (parsed.safetyMarginPercent as number) / 100),
        ) < 1
    ) {
        invalidShape(
            sourcePath,
            "contextManagement leaves no effective input budget",
        );
    }
    return parsed as ContextManagementConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function invalidShape(sourcePath: string, message: string): never {
    throw new ConfigLoadError({
        code: "config_shape_invalid",
        message,
        sourcePath,
    });
}

function parseNaturalLanguage(
    value: unknown,
    sourcePath: string,
): CodeTauConfig["naturalLanguage"] {
    if (value === undefined) {
        return NATURAL_LANGUAGE_DEFAULTS;
    }
    if (!isRecord(value)) {
        invalidShape(sourcePath, "Configuration naturalLanguage must be an object");
    }
    const allowedKeys = new Set([
        "maxModelTurns",
        "maxToolCalls",
        "maxRetries",
        "additionalProtectedPaths",
    ]);
    const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
        invalidShape(
            sourcePath,
            `Unknown naturalLanguage configuration field: ${unknownKey}`,
        );
    }

    const maxModelTurns = value.maxModelTurns ?? NATURAL_LANGUAGE_DEFAULTS.maxModelTurns;
    const maxToolCalls = value.maxToolCalls ?? NATURAL_LANGUAGE_DEFAULTS.maxToolCalls;
    const maxRetries = value.maxRetries ?? NATURAL_LANGUAGE_DEFAULTS.maxRetries;
    const additionalProtectedPaths =
        value.additionalProtectedPaths ??
        NATURAL_LANGUAGE_DEFAULTS.additionalProtectedPaths;

    if (!positiveInteger(maxModelTurns)) {
        invalidShape(sourcePath, "naturalLanguage.maxModelTurns must be positive");
    }
    if (!nonNegativeInteger(maxToolCalls) || !nonNegativeInteger(maxRetries)) {
        invalidShape(
            sourcePath,
            "naturalLanguage tool and retry budgets must be non-negative integers",
        );
    }
    if (
        !Array.isArray(additionalProtectedPaths) ||
        additionalProtectedPaths.some((item) => !nonEmptyString(item))
    ) {
        invalidShape(
            sourcePath,
            "naturalLanguage.additionalProtectedPaths must contain non-empty paths",
        );
    }
    return {
        maxModelTurns,
        maxToolCalls,
        maxRetries,
        additionalProtectedPaths: additionalProtectedPaths.map((item) => item.trim()),
    };
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
        "contextManagement",
        "naturalLanguage",
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
        contextManagement: parseContextManagement(value.contextManagement, sourcePath),
        naturalLanguage: parseNaturalLanguage(value.naturalLanguage, sourcePath),
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
