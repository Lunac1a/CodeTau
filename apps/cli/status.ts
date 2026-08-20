import type { TaskState } from "../../src/events.ts";
import type { EventStore } from "../../src/persistence/event-store.ts";
import type { CliCommand } from "./args.ts";

type StatusCommand = Extract<CliCommand, { readonly kind: "status" }>;

export type CliCommandResult = Readonly<{
    exitCode: 0 | 1;
    stdout: string;
    stderr: string;
}>;

function formatTaskState(state: TaskState): string {
    const lines = [
        `Session: ${state.sessionId}`,
        `Status: ${state.status}`,
        `Spec: ${state.specId}`,
        `Revision: ${state.revision}`,
        `Last sequence: ${state.lastSequence}`,
    ];

    if (state.pendingApproval !== undefined) {
        lines.push(
            `Pending approval: ${state.pendingApproval.toolName} (${state.pendingApproval.toolCallId})`,
        );
    }

    if (state.final !== undefined) {
        lines.push(`Result: ${state.final.status} - ${state.final.message}`);
    }

    return `${lines.join("\n")}\n`;
}

export async function runStatusCommand(
    command: StatusCommand,
    eventStore: EventStore,
): Promise<CliCommandResult> {
    const state = await eventStore.loadTaskState(command.sessionId);

    if (state === undefined) {
        return {
            exitCode: 1,
            stdout: "",
            stderr: `Session not found: ${command.sessionId}\n`,
        };
    }

    return {
        exitCode: 0,
        stdout: formatTaskState(state),
        stderr: "",
    };
}
