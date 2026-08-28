import { randomUUID } from "node:crypto";

import type { CodeTauConfig } from "../../src/config/loader.ts";
import {
    conversationHistoryContext,
    fallbackConversationReply,
    generateConversationReply,
} from "../../src/conversation/reply.ts";
import type { ConversationStore } from "../../src/conversation/store.ts";
import {
    inspectProject,
    normalizeValidationCommandForPlatform,
} from "../../src/natural-language/project-inspector.ts";
import type { EventStore } from "../../src/persistence/event-store.ts";
import { OpenAICompatibleModelProvider } from "../../src/providers/openai-compatible.ts";
import { buildSessionReport, type SessionReport } from "../../src/session/report.ts";
import type { SessionRunnerLike } from "../../src/session/runner.ts";
import type { AgentEvent } from "../../src/types.ts";
import type { CliCommand } from "./args.ts";
import {
    assertValidationCommandsAllowed,
    runNaturalLanguageCommand,
} from "./natural-language.ts";
import type { ConversationUI } from "./terminal-ui.ts";

type ChatCommand = Extract<CliCommand, { kind: "chat" }>;

type RunTask = typeof runNaturalLanguageCommand;
type CreateReply = (options: {
    userMessage: string;
    turns: Awaited<ReturnType<ConversationStore["loadTurns"]>>;
    report: SessionReport;
    events: readonly AgentEvent[];
}) => Promise<string>;

function turnStatus(
    report: SessionReport,
): "completed" | "failed" | "blocked" {
    if (report.status === "completed") return "completed";
    if (report.status === "blocked" || report.status === "awaiting_approval") {
        return "blocked";
    }
    return "failed";
}

export async function runConversationCommand(options: {
    command: ChatCommand;
    config: CodeTauConfig;
    eventStore: EventStore;
    conversationStore: ConversationStore;
    runner: SessionRunnerLike;
    ui: ConversationUI;
    runTask?: RunTask;
    createReply?: CreateReply;
    now?: () => string;
}): Promise<number> {
    const { config, conversationStore, eventStore, runner, ui } = options;
    if (!ui.interactive) {
        throw new Error("Conversation mode requires an interactive terminal");
    }

    const now = options.now ?? (() => new Date().toISOString());
    const conversationId = options.command.conversationId ?? randomUUID();
    let conversation = await conversationStore.loadConversation(conversationId);
    const resumed = conversation !== undefined;

    if (options.command.conversationId !== undefined && conversation === undefined) {
        throw new Error(`Conversation not found: ${conversationId}`);
    }

    if (conversation === undefined) {
        const inspection = await inspectProject(config.rootDirectory);
        let commands = await ui.selectValidationCommands(
            inspection.validationCommands,
        );
        if (commands.length === 0) {
            throw new Error("A conversation requires at least one validation command");
        }
        commands = await Promise.all(
            commands.map(normalizeValidationCommandForPlatform),
        );
        assertValidationCommandsAllowed(commands, config);
        const confirmed = await ui.confirmPreflight({
            config,
            commands,
            assumeYes: false,
        });
        if (!confirmed) return 1;
        conversation = await conversationStore.createConversation({
            id: conversationId,
            validationCommands: commands,
            now: now(),
        });
    } else {
        await conversationStore.failOpenTurns(conversationId, now());
        assertValidationCommandsAllowed(conversation.validationCommands, config);
    }

    const initialTurns = await conversationStore.loadTurns(conversationId);
    ui.renderConversationHeader({
        conversationId,
        resumed,
        completedTurns: initialTurns.filter((turn) => turn.status !== "running")
            .length,
    });

    const runTask = options.runTask ?? runNaturalLanguageCommand;
    const defaultModel = new OpenAICompatibleModelProvider({
        baseUrl: config.baseUrl,
        model: config.model,
    });
    const createReply: CreateReply =
        options.createReply ??
        ((replyOptions) =>
            generateConversationReply({
                model: defaultModel,
                ...replyOptions,
            }));

    while (true) {
        const userMessage = await ui.readConversationMessage();
        if (userMessage === undefined) return 0;

        const previousTurns = await conversationStore.loadTurns(conversationId);
        const turnId = randomUUID();
        const sessionId = randomUUID();
        await conversationStore.beginTurn({
            id: turnId,
            conversationId,
            sessionId,
            userMessage,
            now: now(),
        });

        try {
            await runTask({
                command: {
                    kind: "ask",
                    task: userMessage,
                    sessionId,
                    yes: true,
                    validationCommands: [],
                },
                config,
                eventStore,
                runner,
                ui,
                preparedCommands: conversation.validationCommands,
                skipPreflight: true,
                conversationContext: conversationHistoryContext(
                    previousTurns,
                    userMessage,
                ),
                renderReport: false,
            });
            const state = await eventStore.loadTaskState(sessionId);
            if (state === undefined) {
                throw new Error("Conversation turn did not create a session");
            }
            const events = await eventStore.loadSession(sessionId);
            const report = buildSessionReport(state, events);
            let assistantMessage: string;
            try {
                assistantMessage = await createReply({
                    userMessage,
                    turns: previousTurns,
                    report,
                    events,
                });
            } catch {
                assistantMessage = fallbackConversationReply(report);
            }
            await conversationStore.completeTurn({
                id: turnId,
                status: turnStatus(report),
                assistantMessage,
                now: now(),
            });
            ui.renderAssistantReply(assistantMessage);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Conversation turn failed";
            await conversationStore.completeTurn({
                id: turnId,
                status: "failed",
                assistantMessage: message,
                now: now(),
            });
            ui.writeError(message);
            ui.renderAssistantReply(`I could not complete that turn: ${message}`);
        }
    }
}
