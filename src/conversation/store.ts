import type { ValidationCommand } from "../natural-language/command-line.ts";

export type Conversation = Readonly<{
    id: string;
    validationCommands: readonly ValidationCommand[];
    createdAt: string;
    updatedAt: string;
}>;

export type ConversationTurn = Readonly<{
    id: string;
    conversationId: string;
    sequence: number;
    sessionId: string;
    userMessage: string;
    assistantMessage?: string;
    status: "running" | "completed" | "failed" | "blocked";
    createdAt: string;
    completedAt?: string;
}>;

export type ConversationSummaryContent = Readonly<{
    goals: readonly string[];
    constraints: readonly string[];
    decisions: readonly string[];
    verifiedOutcomes: readonly string[];
    openItems: readonly string[];
}>;

export type ConversationSummary = Readonly<{
    id: string;
    conversationId: string;
    throughSequence: number;
    sourceTurnIds: readonly string[];
    sourceDigest: string;
    content: ConversationSummaryContent;
    createdAt: string;
}>;

export interface ConversationStore {
    createConversation(options: {
        id: string;
        validationCommands: readonly ValidationCommand[];
        now: string;
    }): Promise<Conversation>;
    loadConversation(id: string): Promise<Conversation | undefined>;
    loadTurns(conversationId: string): Promise<readonly ConversationTurn[]>;
    beginTurn(options: {
        id: string;
        conversationId: string;
        sessionId: string;
        userMessage: string;
        now: string;
    }): Promise<ConversationTurn>;
    completeTurn(options: {
        id: string;
        status: "completed" | "failed" | "blocked";
        assistantMessage: string;
        now: string;
    }): Promise<void>;
    failOpenTurns(conversationId: string, now: string): Promise<void>;
    loadLatestSummary(conversationId: string): Promise<ConversationSummary | undefined>;
    appendSummary(summary: ConversationSummary): Promise<void>;
    close(): Promise<void>;
}
