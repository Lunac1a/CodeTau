import type { ApprovalResponse } from "../../src/spec/types.ts";

export type CliCommand =
    | {
          readonly kind: "status";
          readonly sessionId: string;
      }
    | {
          readonly kind: "run";
          readonly specPath: string;
          readonly sessionId?: string;
      }
    | {
          readonly kind: "resume";
          readonly sessionId: string;
          readonly approvalResponse?: ApprovalResponse;
      };

export const usage = [
    "Usage:",
    "  codetau run <spec-path> [--session <session-id>]",
    "  codetau resume <session-id> [--approval <allow-once|allow-session|deny>]",
    "  codetau status <session-id>",
].join("\n");

function requiredValue(value: string | undefined): value is string {
    return value !== undefined && value.trim() !== "";
}

function isApprovalResponse(value: string): value is ApprovalResponse {
    return value === "allow-once" || value === "allow-session" || value === "deny";
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
    const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
    const [command, firstArgument, ...remaining] = normalizedArgv;

    if (
        command === "status" &&
        requiredValue(firstArgument) &&
        remaining.length === 0
    ) {
        return { kind: "status", sessionId: firstArgument };
    }

    if (command === "run" && requiredValue(firstArgument)) {
        if (remaining.length === 0) {
            return { kind: "run", specPath: firstArgument };
        }
        if (
            remaining.length === 2 &&
            remaining[0] === "--session" &&
            requiredValue(remaining[1])
        ) {
            return {
                kind: "run",
                specPath: firstArgument,
                sessionId: remaining[1],
            };
        }
    }

    if (command === "resume" && requiredValue(firstArgument)) {
        if (remaining.length === 0) {
            return { kind: "resume", sessionId: firstArgument };
        }
        if (
            remaining.length === 2 &&
            remaining[0] === "--approval" &&
            isApprovalResponse(remaining[1])
        ) {
            return {
                kind: "resume",
                sessionId: firstArgument,
                approvalResponse: remaining[1],
            };
        }
    }

    throw new Error(usage);
}
