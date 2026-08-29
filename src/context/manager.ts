import { createHash } from "node:crypto";

import type { ModelMessage } from "../model.ts";
import type { ToolDefinition } from "../tools/tool.ts";
import type { ToolCall } from "../types.ts";
import {
    ContextBudgetExceededError,
    type CompiledContext,
    type ContextManagementConfig,
    type ContextOperation,
    type ContextSectionUsage,
} from "./types.ts";

export const DEFAULT_CONTEXT_MANAGEMENT_CONFIG: ContextManagementConfig = {
    maxContextTokens: 16_384,
    reservedOutputTokens: 2_048,
    safetyMarginPercent: 10,
    recentConversationTurns: 4,
    recentToolExchanges: 6,
    maxSummaryTokens: 1_200,
    maxToolResultTokens: 2_048,
};

function canonicalJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalJsonValue);
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, canonicalJsonValue(child)]),
        );
    }
    return value;
}

export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalJsonValue(value));
}

export function estimateTextTokens(value: string): number {
    const codePoints = [...value].length;
    const bytes = Buffer.byteLength(value, "utf8");
    return Math.ceil(Math.max(codePoints / 3, bytes / 3));
}

export function estimateModelRequestTokens(
    messages: readonly ModelMessage[],
    availableTools: readonly ToolDefinition[],
): number {
    return estimateTextTokens(canonicalJson({ messages, availableTools }));
}

function section(
    kind: ContextSectionUsage["kind"],
    messages: readonly ModelMessage[],
    sourceCount: number,
): ContextSectionUsage {
    return {
        kind,
        estimatedTokens: estimateTextTokens(canonicalJson(messages)),
        sourceCount,
    };
}

function boundedText(value: string, maxTokens: number): string {
    if (estimateTextTokens(value) <= maxTokens) return value;
    const maxCharacters = Math.max(80, maxTokens * 2);
    const headLength = Math.floor(maxCharacters * 0.55);
    const tailLength = Math.floor(maxCharacters * 0.35);
    return `${value.slice(0, headLength)}\n[context omitted]\n${value.slice(-tailLength)}`;
}

function structuralToolResult(content: string): string {
    let value: unknown;
    try {
        value = JSON.parse(content) as unknown;
    } catch {
        return JSON.stringify({
            contextCompacted: true,
            excerpt: boundedText(content, 512),
        });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return JSON.stringify({ contextCompacted: true, value });
    }
    const record = value as Record<string, unknown>;
    if (record.ok === false) {
        const error =
            typeof record.error === "object" && record.error !== null
                ? (record.error as Record<string, unknown>)
                : {};
        return JSON.stringify({
            ok: false,
            error: { code: error.code, message: error.message },
            contextCompacted: true,
        });
    }
    const output =
        typeof record.output === "object" && record.output !== null
            ? (record.output as Record<string, unknown>)
            : {};
    const retainedKeys = [
        "path",
        "bytes",
        "startLine",
        "endLine",
        "totalLines",
        "truncated",
        "commandIndex",
        "exitCode",
        "passed",
        "timedOut",
        "outputLimitExceeded",
    ];
    return JSON.stringify({
        ok: record.ok,
        output: Object.fromEntries(
            retainedKeys
                .filter((key) => output[key] !== undefined)
                .map((key) => [key, output[key]]),
        ),
        contextCompacted: true,
        recoveryGuidance:
            "Large output was omitted from the model view. The complete result remains in the event store. Re-read files with startLine/endLine when exact source is needed.",
    });
}

function compactRecentMessages(
    messages: readonly ModelMessage[],
    maxToolResultTokens: number,
): { messages: ModelMessage[]; compacted: number } {
    let compacted = 0;
    return {
        messages: messages.map((message) => {
            if (
                message.role !== "tool" ||
                estimateTextTokens(message.content) <= maxToolResultTokens
            ) {
                return message;
            }
            compacted += 1;
            return { ...message, content: structuralToolResult(message.content) };
        }),
        compacted,
    };
}

function checkpointLines(messages: readonly ModelMessage[]): string[] {
    const calls = new Map<string, ToolCall>();
    const lines: string[] = [];
    for (const message of messages) {
        if (message.role === "assistant" && "toolCalls" in message) {
            for (const call of message.toolCalls) calls.set(call.id, call);
            continue;
        }
        if (message.role !== "tool") continue;
        const call = calls.get(message.toolCallId);
        const summary = structuralToolResult(message.content);
        lines.push(
            `- ${call?.name ?? "tool"} (${message.toolCallId}): ${summary}`,
        );
    }
    return lines;
}

function checkpointMessage(
    messages: readonly ModelMessage[],
    maxTokens: number,
): ModelMessage | undefined {
    const lines = checkpointLines(messages);
    if (lines.length === 0) return undefined;
    return {
        role: "user",
        content: boundedText(
            [
                "[CodeTau execution checkpoint generated from authoritative events]",
                "Older tool exchanges were compacted. Use current workspace reads for exact source.",
                ...lines,
            ].join("\n"),
            maxTokens,
        ),
    };
}

function toolExchangeStarts(messages: readonly ModelMessage[], offset: number): number[] {
    const starts: number[] = [];
    for (let index = offset; index < messages.length; index += 1) {
        const message = messages[index];
        if (message?.role === "assistant" && "toolCalls" in message) starts.push(index);
    }
    return starts;
}

export class ContextManager {
    readonly config: ContextManagementConfig;

    constructor(config: ContextManagementConfig = DEFAULT_CONTEXT_MANAGEMENT_CONFIG) {
        const positiveKeys = [
            "maxContextTokens",
            "reservedOutputTokens",
            "recentConversationTurns",
            "recentToolExchanges",
            "maxSummaryTokens",
            "maxToolResultTokens",
        ] as const;
        if (
            positiveKeys.some(
                (key) => !Number.isSafeInteger(config[key]) || config[key] <= 0,
            ) ||
            !Number.isSafeInteger(config.safetyMarginPercent) ||
            config.safetyMarginPercent < 0 ||
            config.safetyMarginPercent >= 100 ||
            config.reservedOutputTokens >= config.maxContextTokens ||
            Math.floor(
                (config.maxContextTokens - config.reservedOutputTokens) *
                    (1 - config.safetyMarginPercent / 100),
            ) < 1
        ) {
            throw new RangeError("Context management configuration is invalid");
        }
        this.config = config;
    }

    effectiveInputLimit(): number {
        return Math.floor(
            (this.config.maxContextTokens - this.config.reservedOutputTokens) *
                (1 - this.config.safetyMarginPercent / 100),
        );
    }

    compile(options: {
        messages: readonly ModelMessage[];
        availableTools: readonly ToolDefinition[];
        mode?: "required" | "agent";
        requiredPrefixMessages?: number;
    }): CompiledContext {
        const limit = this.effectiveInputLimit();
        const originalTokens = estimateModelRequestTokens(
            options.messages,
            options.availableTools,
        );
        if (originalTokens <= limit) {
            return this.result(options.messages, options.availableTools, [], [
                section("pinned", options.messages, options.messages.length),
                {
                    kind: "tools",
                    estimatedTokens: estimateTextTokens(canonicalJson(options.availableTools)),
                    sourceCount: options.availableTools.length,
                },
            ]);
        }

        const prefixCount = options.requiredPrefixMessages ?? options.messages.length;
        const pinned = options.messages.slice(0, prefixCount);
        const pinnedTokens = estimateModelRequestTokens(pinned, options.availableTools);
        const pinnedSections: ContextSectionUsage[] = [
            section("pinned", pinned, pinned.length),
            {
                kind: "tools",
                estimatedTokens: estimateTextTokens(canonicalJson(options.availableTools)),
                sourceCount: options.availableTools.length,
            },
        ];
        if (pinnedTokens > limit || options.mode !== "agent") {
            throw new ContextBudgetExceededError({
                estimatedRequiredTokens: pinnedTokens,
                effectiveInputLimit: limit,
                sections: pinnedSections,
            });
        }

        const starts = toolExchangeStarts(options.messages, prefixCount);
        let keepCount = Math.min(this.config.recentToolExchanges, starts.length);
        while (keepCount >= 0) {
            const keepStart =
                keepCount === 0
                    ? options.messages.length
                    : (starts.at(-keepCount) as number);
            const dropped = options.messages.slice(prefixCount, keepStart);
            const recentResult = compactRecentMessages(
                options.messages.slice(keepStart),
                this.config.maxToolResultTokens,
            );
            const checkpoint = checkpointMessage(
                dropped,
                this.config.maxSummaryTokens,
            );
            const candidate = [
                ...pinned,
                ...(checkpoint === undefined ? [] : [checkpoint]),
                ...recentResult.messages,
            ];
            const estimated = estimateModelRequestTokens(candidate, options.availableTools);
            if (estimated <= limit) {
                const operations: ContextOperation[] = [];
                if (dropped.length > 0) {
                    operations.push({ kind: "checkpoint", count: dropped.length });
                }
                if (recentResult.compacted > 0) {
                    operations.push({
                        kind: "tool_result_compacted",
                        count: recentResult.compacted,
                    });
                }
                if (keepCount < starts.length) {
                    operations.push({
                        kind: "history_omitted",
                        count: starts.length - keepCount,
                    });
                }
                return this.result(candidate, options.availableTools, operations, [
                    ...pinnedSections,
                    section("checkpoint", checkpoint === undefined ? [] : [checkpoint], dropped.length),
                    section("recent", recentResult.messages, keepCount),
                ]);
            }
            keepCount -= 1;
        }

        throw new ContextBudgetExceededError({
            estimatedRequiredTokens: pinnedTokens,
            effectiveInputLimit: limit,
            sections: pinnedSections,
        });
    }

    private result(
        messages: readonly ModelMessage[],
        availableTools: readonly ToolDefinition[],
        operations: readonly ContextOperation[],
        sections: readonly ContextSectionUsage[],
    ): CompiledContext {
        const payload = canonicalJson({ messages, availableTools });
        return {
            messages,
            estimatedInputTokens: estimateTextTokens(payload),
            effectiveInputLimit: this.effectiveInputLimit(),
            sections,
            operations,
            digest: createHash("sha256").update(payload).digest("hex"),
        };
    }
}
