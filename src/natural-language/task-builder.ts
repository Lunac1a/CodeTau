import type { CodeTauConfig } from "../config/loader.ts";
import { computeSpecDigest, createSpecSnapshot } from "../spec/digest.ts";
import type { LoadedSpec, TaskSpecContract } from "../spec/types.ts";
import { validateSpecContract } from "../spec/validator.ts";
import type { ValidationCommand } from "./command-line.ts";

export const BUILT_IN_PROTECTED_PATHS = [
    ".git/**",
    ".codetau/**",
    "node_modules/**",
    ".venv/**",
    "venv/**",
    "dist/**",
    "build/**",
    "coverage/**",
] as const;

export type BuildNaturalLanguageTaskOptions = Readonly<{
    task: string;
    sessionId: string;
    validationCommands: readonly ValidationCommand[];
    config: CodeTauConfig;
}>;

function safeId(value: string): string {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    return `interactive.${normalized || "session"}`;
}

export async function buildNaturalLanguageTask(
    options: BuildNaturalLanguageTaskOptions,
): Promise<LoadedSpec> {
    const task = options.task.trim();
    if (task === "") {
        throw new Error("Natural-language task must not be empty");
    }
    if (options.validationCommands.length === 0) {
        throw new Error("At least one validation command is required");
    }
    const settings = options.config.naturalLanguage;
    const protectedPaths = [
        ...BUILT_IN_PROTECTED_PATHS,
        ...settings.additionalProtectedPaths,
    ];
    const contract: TaskSpecContract = {
        version: 1,
        id: safeId(options.sessionId),
        goal: task,
        workspace: {
            root: ".",
            allowedPaths: ["**"],
            deniedPaths: [...new Set(protectedPaths)],
        },
        policy: {
            forbiddenActions: [
                "network-access",
                "workspace-outside-write",
                "protected-path-write",
            ],
        },
        acceptance: {
            commands: options.validationCommands.map((command) => ({
                executable: command.executable,
                args: [...command.args],
            })),
            assertions: [
                "The requested task is implemented.",
                "Unrelated behavior is preserved.",
                "Every selected validation command passes.",
            ],
        },
        phases: [
            { id: "inspect", description: "Inspect the relevant project files." },
            { id: "implement", description: "Implement the requested change." },
            { id: "validate", description: "Run every selected validation command." },
        ],
        budget: {
            maxModelTurns: settings.maxModelTurns,
            maxToolCalls: settings.maxToolCalls,
            maxRetries: settings.maxRetries,
        },
        userInteraction: {
            allowQuestions: false,
            approvalResponses: ["allow-once", "allow-session", "deny"],
        },
    };
    const validated = await validateSpecContract(
        contract,
        `codetau://generated/${options.sessionId}`,
    );
    const context = task;
    return {
        sourcePath: `codetau://generated/${options.sessionId}`,
        origin: "generated",
        contract: validated,
        context,
        digest: computeSpecDigest(createSpecSnapshot(validated, context)),
    };
}
