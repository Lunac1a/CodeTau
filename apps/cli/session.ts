import type { TaskState } from "../../src/events.ts";
import type { SessionRunnerLike } from "../../src/session/runner.ts";
import type { CliCommand } from "./args.ts";
import { formatTaskState, type CliCommandResult } from "./status.ts";

type SessionCommand = Extract<CliCommand, { kind: "run" | "resume" }>;

function resultFrom(state: TaskState): CliCommandResult {
    let stdout = formatTaskState(state);
    if (state.status === "awaiting_approval") {
        stdout += [
            "Resume with approval:",
            `  codetau resume ${state.sessionId} --approval allow-once`,
            "",
        ].join("\n");
    }
    return {
        exitCode: state.status === "failed" ? 1 : 0,
        stdout,
        stderr: "",
    };
}

export async function runSessionCommand(
    command: SessionCommand,
    runner: SessionRunnerLike,
): Promise<CliCommandResult> {
    const state =
        command.kind === "run"
            ? await runner.run({
                  specPath: command.specPath,
                  sessionId: command.sessionId,
              })
            : await runner.resume({
                  sessionId: command.sessionId,
                  approvalResponse: command.approvalResponse,
              });
    return resultFrom(state);
}
