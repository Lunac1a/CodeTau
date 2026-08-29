import type { ModelMessage } from "../model.ts";

export type ContextManagementConfig = Readonly<{
    maxContextTokens: number;
    reservedOutputTokens: number;
    safetyMarginPercent: number;
    recentConversationTurns: number;
    recentToolExchanges: number;
    maxSummaryTokens: number;
    maxToolResultTokens: number;
}>;

export type ContextSectionUsage = Readonly<{
    kind: "pinned" | "checkpoint" | "recent" | "tools";
    estimatedTokens: number;
    sourceCount: number;
}>;

export type ContextOperation = Readonly<{
    kind: "checkpoint" | "tool_result_compacted" | "history_omitted";
    count: number;
}>;

export type CompiledContext = Readonly<{
    messages: readonly ModelMessage[];
    estimatedInputTokens: number;
    effectiveInputLimit: number;
    sections: readonly ContextSectionUsage[];
    operations: readonly ContextOperation[];
    digest: string;
}>;

export class ContextBudgetExceededError extends Error {
    readonly code = "context_budget_exceeded";
    readonly estimatedRequiredTokens: number;
    readonly effectiveInputLimit: number;
    readonly exceededByTokens: number;
    readonly sections: readonly ContextSectionUsage[];

    constructor(options: {
        estimatedRequiredTokens: number;
        effectiveInputLimit: number;
        sections: readonly ContextSectionUsage[];
    }) {
        const exceededByTokens = Math.max(
            0,
            options.estimatedRequiredTokens - options.effectiveInputLimit,
        );
        super(
            `Required context exceeds the effective input limit by ${exceededByTokens} estimated tokens ` +
                `(${options.estimatedRequiredTokens}/${options.effectiveInputLimit}).`,
        );
        this.name = "ContextBudgetExceededError";
        this.estimatedRequiredTokens = options.estimatedRequiredTokens;
        this.effectiveInputLimit = options.effectiveInputLimit;
        this.exceededByTokens = exceededByTokens;
        this.sections = options.sections;
    }
}
