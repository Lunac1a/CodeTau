import type { ApprovalResponse } from "../../src/spec/types.ts";

export type CliCommand =
    | {
          readonly kind: "chat";
          readonly conversationId?: string;
          readonly verbose?: boolean;
      }
    | {
          readonly kind: "ask";
          readonly task?: string;
          readonly sessionId?: string;
          readonly yes: boolean;
          readonly validationCommands: readonly string[];
          readonly verbose?: boolean;
      }
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
    "  codetau [--verbose]",
    "  codetau chat [--conversation <conversation-id>] [--verbose]",
    "  codetau ask <task> [--session <session-id>] [--yes] [--validate <command>]... [--verbose]",
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
    const rawArgv = argv[0] === "--" ? argv.slice(1) : argv;
    const verboseArguments = rawArgv.filter((argument) => argument === "--verbose");
    if (verboseArguments.length > 1) {
        throw new Error(usage);
    }
    const verbose = verboseArguments.length === 1;
    const normalizedArgv = rawArgv.filter((argument) => argument !== "--verbose");
    const [command, firstArgument, ...remaining] = normalizedArgv;

    if (command === undefined) {
        return verbose ? { kind: "chat", verbose: true } : { kind: "chat" };
    }

    if (command === "chat") {
        if (firstArgument === undefined && remaining.length === 0) {
            return verbose ? { kind: "chat", verbose: true } : { kind: "chat" };
        }
        if (
            firstArgument === "--conversation" &&
            remaining.length === 1 &&
            requiredValue(remaining[0])
        ) {
            return {
                kind: "chat",
                conversationId: remaining[0],
                ...(verbose ? { verbose: true } : {}),
            };
        }
    }

    if (command === "ask" && requiredValue(firstArgument)) {
        let sessionId: string | undefined;
        let yes = false;
        const validationCommands: string[] = [];
        for (let index = 0; index < remaining.length; index += 1) {
            const argument = remaining[index];
            if (argument === "--yes" && !yes) {
                yes = true;
                continue;
            }
            const value = remaining[index + 1];
            if (
                argument === "--session" &&
                sessionId === undefined &&
                requiredValue(value)
            ) {
                sessionId = value;
                index += 1;
                continue;
            }
            if (argument === "--validate" && requiredValue(value)) {
                validationCommands.push(value);
                index += 1;
                continue;
            }
            throw new Error(usage);
        }
        return {
            kind: "ask",
            task: firstArgument,
            sessionId,
            yes,
            validationCommands,
            ...(verbose ? { verbose: true } : {}),
        };
    }

    if (verbose) {
        throw new Error(usage);
    }

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
