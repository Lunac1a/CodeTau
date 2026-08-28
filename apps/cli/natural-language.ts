import { randomUUID } from "node:crypto";

import type { CodeTauConfig } from "../../src/config/loader.ts";
import {
    parseValidationCommand,
    type ValidationCommand,
} from "../../src/natural-language/command-line.ts";
import {
    inspectProject,
    normalizeValidationCommandForPlatform,
} from "../../src/natural-language/project-inspector.ts";
import { buildNaturalLanguageTask } from "../../src/natural-language/task-builder.ts";
import type { EventStore } from "../../src/persistence/event-store.ts";
import { buildSessionReport } from "../../src/session/report.ts";
import type { SessionRunnerLike } from "../../src/session/runner.ts";
import type { ToolCall } from "../../src/types.ts";
import type { CliCommand } from "./args.ts";
import type { NaturalLanguageUI } from "./terminal-ui.ts";

type AskCommand = Extract<CliCommand, { kind: "ask" }>;

function commandKey(value: string): string {
    return process.platform === "win32" ? value.toLowerCase() : value;
}

export function assertValidationCommandsAllowed(
    commands: readonly ValidationCommand[],
    config: CodeTauConfig,
): void {
    const allowed = new Set(config.commandAllowlist.map(commandKey));
    const rejected = commands.find(
        (command) => !allowed.has(commandKey(command.executable)),
    );
    if (rejected !== undefined) {
        throw new Error(
            `Validation executable is not in commandAllowlist: ${rejected.executable}`,
        );
    }
}

function findPendingCall(
    events: Awaited<ReturnType<EventStore["loadSession"]>>,
    toolCallId: string,
): ToolCall | undefined {
    for (const event of events) {
        if (event.type === "model_tool_call" && event.toolCall.id === toolCallId) {
            return event.toolCall;
        }
    }
    return undefined;
}

export async function runNaturalLanguageCommand(options: {
    command: AskCommand;
    config: CodeTauConfig;
    eventStore: EventStore;
    runner: SessionRunnerLike;
    ui: NaturalLanguageUI;
    preparedCommands?: readonly ValidationCommand[];
    skipPreflight?: boolean;
    conversationContext?: string;
    renderReport?: boolean;
}): Promise<number> {
    const { command, config, eventStore, runner, ui } = options;
    if (!ui.interactive && !command.yes) {
        throw new Error("Non-interactive ask requires --yes");
    }

    const task = command.task ?? (await ui.readTask());
    if (task === undefined) {
        return 1;
    }
    const inspection =
        options.preparedCommands === undefined
            ? await inspectProject(config.rootDirectory)
            : { validationCommands: [] };
    const explicitCommands =
        options.preparedCommands ??
        command.validationCommands.map(parseValidationCommand);
    let commands: readonly ValidationCommand[];
    if (explicitCommands.length > 0) {
        commands = explicitCommands;
    } else if (command.yes || !ui.interactive) {
        commands = inspection.validationCommands;
    } else {
        commands = await ui.selectValidationCommands(
            inspection.validationCommands,
        );
    }
    if (commands.length === 0) {
        throw new Error(
            "No validation command was found. Provide one with --validate.",
        );
    }
    commands = await Promise.all(
        commands.map(normalizeValidationCommandForPlatform),
    );
    assertValidationCommandsAllowed(commands, config);

    const confirmed =
        options.skipPreflight === true
            ? true
            : await ui.confirmPreflight({
                  config,
                  commands,
                  assumeYes: command.yes,
              });
    if (!confirmed) {
        return 1;
    }

    const sessionId = command.sessionId ?? randomUUID();
    const spec = await buildNaturalLanguageTask({
        task,
        context: options.conversationContext,
        sessionId,
        validationCommands: commands,
        config,
    });
    let state = await runner.runLoadedSpec({ spec, sessionId });

    while (state.status === "awaiting_approval") {
        if (!ui.interactive) {
            ui.writeError(
                `Approval required. Resume with: codetau resume ${state.sessionId} --approval allow-once`,
            );
            return 2;
        }
        const events = await eventStore.loadSession(state.sessionId);
        const pending = state.pendingApproval;
        const call =
            pending === undefined
                ? undefined
                : findPendingCall(events, pending.toolCallId);
        if (call === undefined) {
            throw new Error("Pending approval has no matching tool call");
        }
        const response = await ui.requestApproval(call);
        state = await runner.resume({
            sessionId: state.sessionId,
            approvalResponse: response,
        });
    }

    const events = await eventStore.loadSession(state.sessionId);
    if (options.renderReport !== false) {
        ui.renderReport(buildSessionReport(state, events));
    }
    return state.status === "completed" ? 0 : 1;
}
