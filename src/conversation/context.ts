import { createHash, randomUUID } from "node:crypto";

import {
    ContextManager,
    canonicalJson,
    estimateTextTokens,
} from "../context/manager.ts";
import type { ModelProvider } from "../model.ts";
import type { EventStore } from "../persistence/event-store.ts";
import { buildSessionReport } from "../session/report.ts";
import type {
    ConversationStore,
    ConversationSummary,
    ConversationSummaryContent,
    ConversationTurn,
} from "./store.ts";

const SUMMARY_KEYS = [
    "goals",
    "constraints",
    "decisions",
    "verifiedOutcomes",
    "openItems",
] as const;

export type ConversationContextResult = Readonly<{
    text: string;
    summarized: boolean;
    omittedTurns: number;
}>;

function bounded(value: string, characters = 3_000): string {
    return value.length <= characters
        ? value
        : `${value.slice(0, Math.floor(characters * 0.65))}\n[older turn content omitted]\n${value.slice(-Math.floor(characters * 0.25))}`;
}

function sourceDigest(turns: readonly ConversationTurn[]): string {
    return createHash("sha256")
        .update(
            canonicalJson(
                turns.map((turn) => ({
                    id: turn.id,
                    sequence: turn.sequence,
                    sessionId: turn.sessionId,
                    userMessage: turn.userMessage,
                    assistantMessage: turn.assistantMessage,
                    status: turn.status,
                })),
            ),
        )
        .digest("hex");
}

function renderTurn(turn: ConversationTurn): string {
    return turn.status === "completed" && turn.assistantMessage !== undefined
        ? `Turn ${turn.sequence}\nUser: ${turn.userMessage}\nAssistant: ${turn.assistantMessage}`
        : `Turn ${turn.sequence}\nUser: ${turn.userMessage}\nAssistant: [${turn.status} turn; unverified response omitted]`;
}

function renderSummary(content: ConversationSummaryContent): string {
    return SUMMARY_KEYS.map((key) => {
        const values = content[key];
        return `${key}:\n${values.length === 0 ? "- none" : values.map((value) => `- ${value}`).join("\n")}`;
    }).join("\n");
}

function contextText(options: {
    summary?: ConversationSummary;
    turns: readonly ConversationTurn[];
    currentMessage: string;
}): string {
    const earlier = [
        ...(options.summary === undefined
            ? []
            : [
                  `Earlier conversation summary (through turn ${options.summary.throughSequence}):\n${renderSummary(options.summary.content)}`,
              ]),
        ...options.turns.map(renderTurn),
    ];
    return [
        "This coding task is one turn in a persistent terminal conversation.",
        earlier.length === 0
            ? "No earlier completed turns."
            : `Earlier turns:\n${earlier.join("\n\n")}`,
        `Current user request:\n${options.currentMessage}`,
        "Treat the current request as an addition or correction to earlier turns. Inspect current files instead of assuming earlier edits remain unchanged.",
    ].join("\n\n");
}

function summaryContent(value: unknown): ConversationSummaryContent | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).length !== SUMMARY_KEYS.length ||
        Object.keys(record).some(
            (key) => !(SUMMARY_KEYS as readonly string[]).includes(key),
        )
    ) {
        return undefined;
    }
    for (const key of SUMMARY_KEYS) {
        const field = record[key];
        if (
            !Array.isArray(field) ||
            field.some((item) => typeof item !== "string" || item.trim() === "")
        ) {
            return undefined;
        }
    }
    return record as ConversationSummaryContent;
}

async function verifiedEvidence(
    turns: readonly ConversationTurn[],
    eventStore: EventStore,
): Promise<string[]> {
    const evidence: string[] = [];
    for (const turn of turns) {
        if (turn.status !== "completed") continue;
        const [state, events] = await Promise.all([
            eventStore.loadTaskState(turn.sessionId),
            eventStore.loadSession(turn.sessionId),
        ]);
        if (state === undefined) continue;
        const report = buildSessionReport(state, events);
        evidence.push(
            `Turn ${turn.sequence}: status=${report.status}; changedFiles=${report.changedFiles.join(", ") || "none"}; validation=${report.passedValidationIndexes.length}/${report.validationCount}; runtime=${report.message ?? "none"}`,
        );
    }
    return evidence;
}

async function requestSummary(options: {
    model: ModelProvider;
    contextManager: ContextManager;
    previous?: ConversationSummary;
    turns: readonly ConversationTurn[];
    evidence: readonly string[];
}): Promise<ConversationSummaryContent | undefined> {
    const system = [
        "You compact an existing CodeTau conversation into strict JSON.",
        `Return exactly these keys: ${SUMMARY_KEYS.join(", ")}.`,
        "Every value must be an array of concise strings. Do not add facts.",
        "Failed or blocked assistant prose is unavailable and must not be inferred.",
        "verifiedOutcomes may only contain complete lines copied verbatim from Authoritative execution evidence.",
    ].join("\n");
    const source = [
        options.previous === undefined
            ? "No previous summary."
            : `Previous summary:\n${JSON.stringify(options.previous.content)}`,
        `Turns:\n${options.turns.map((turn) => bounded(renderTurn(turn))).join("\n\n")}`,
        `Authoritative execution evidence:\n${options.evidence.join("\n") || "none"}`,
    ].join("\n\n");
    let repair: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const messages = [
            { role: "system" as const, content: system },
            {
                role: "user" as const,
                content:
                    repair === undefined
                        ? source
                        : `${source}\n\nThe previous output was invalid. Return strict JSON only. Invalid output:\n${bounded(repair, 2_000)}`,
            },
        ];
        let compiled;
        try {
            compiled = options.contextManager.compile({
                messages,
                availableTools: [],
                mode: "required",
            });
        } catch {
            return undefined;
        }
        const response = await options.model.generate({
            messages: compiled.messages,
            availableTools: [],
            includeFinishTool: false,
        });
        if (response.kind !== "text") {
            repair = JSON.stringify(response);
            continue;
        }
        repair = response.text;
        try {
            const content = summaryContent(JSON.parse(response.text) as unknown);
            if (
                content !== undefined &&
                content.verifiedOutcomes.every((outcome) =>
                    options.evidence.includes(outcome),
                ) &&
                estimateTextTokens(JSON.stringify(content)) <=
                    options.contextManager.config.maxSummaryTokens
            ) {
                return content;
            }
        } catch {
            // One repair attempt is allowed below.
        }
    }
    return undefined;
}

function validLatestSummary(
    summary: ConversationSummary | undefined,
    turns: readonly ConversationTurn[],
): ConversationSummary | undefined {
    if (summary === undefined) return undefined;
    const covered = turns.filter(
        (turn) => turn.sequence <= summary.throughSequence,
    );
    return covered.length === summary.sourceTurnIds.length &&
        covered.every((turn, index) => turn.id === summary.sourceTurnIds[index]) &&
        sourceDigest(covered) === summary.sourceDigest
        ? summary
        : undefined;
}

export async function buildConversationContext(options: {
    conversationId: string;
    turns: readonly ConversationTurn[];
    currentMessage: string;
    store: ConversationStore;
    eventStore: EventStore;
    model: ModelProvider;
    contextManager: ContextManager;
    now: () => string;
}): Promise<ConversationContextResult> {
    const historyLimit = Math.floor(options.contextManager.effectiveInputLimit() * 0.55);
    const raw = contextText({
        turns: options.turns,
        currentMessage: options.currentMessage,
    });
    if (estimateTextTokens(raw) <= historyLimit) {
        return { text: raw, summarized: false, omittedTurns: 0 };
    }

    let latest = validLatestSummary(
        await options.store.loadLatestSummary(options.conversationId),
        options.turns,
    );
    const targetSequence =
        options.turns.at(-options.contextManager.config.recentConversationTurns)
            ?.sequence ?? 0;
    const eligible = options.turns.filter(
        (turn) =>
            turn.status !== "running" &&
            turn.sequence < targetSequence &&
            turn.sequence > (latest?.throughSequence ?? 0),
    );

    for (let index = 0; index < eligible.length; index += 8) {
        const batch = eligible.slice(index, index + 8);
        const content = await requestSummary({
            model: options.model,
            contextManager: options.contextManager,
            previous: latest,
            turns: batch,
            evidence: await verifiedEvidence(batch, options.eventStore),
        }).catch(() => undefined);
        if (content === undefined) break;
        const throughSequence = batch.at(-1)?.sequence;
        if (throughSequence === undefined) break;
        const covered = options.turns.filter(
            (turn) => turn.sequence <= throughSequence,
        );
        const next: ConversationSummary = {
            id: randomUUID(),
            conversationId: options.conversationId,
            throughSequence,
            sourceTurnIds: covered.map((turn) => turn.id),
            sourceDigest: sourceDigest(covered),
            content,
            createdAt: options.now(),
        };
        await options.store.appendSummary(next).catch(() => undefined);
        latest = next;
    }

    let recent = options.turns.filter(
        (turn) => turn.sequence > (latest?.throughSequence ?? 0),
    );
    let rendered = contextText({
        summary: latest,
        turns: recent,
        currentMessage: options.currentMessage,
    });
    let omittedTurns = (latest?.throughSequence ?? 0);
    while (estimateTextTokens(rendered) > historyLimit && recent.length > 0) {
        recent = recent.slice(1);
        omittedTurns += 1;
        rendered = contextText({
            summary: latest,
            turns: recent,
            currentMessage: options.currentMessage,
        });
    }
    if (estimateTextTokens(rendered) > historyLimit && latest !== undefined) {
        rendered = contextText({
            turns: recent,
            currentMessage: options.currentMessage,
        });
    }
    return {
        text: rendered,
        summarized: latest !== undefined,
        omittedTurns,
    };
}
