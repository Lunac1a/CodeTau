import { computeSpecDigest, createSpecSnapshot } from "../../src/spec/digest.ts";
import type { LoadedSpec, TaskSpecContract } from "../../src/spec/types.ts";
import type { AgentEvent } from "../../src/types.ts";

export function createTestSpec(options: {
    id?: string;
    sourcePath?: string;
    context?: string;
    maxModelTurns?: number;
    maxToolCalls?: number;
} = {}): LoadedSpec {
    const contract: TaskSpecContract = {
        version: 1,
        id: options.id ?? "test.spec",
        goal: "Exercise the CodeTau test fixture.",
        workspace: {
            root: "fixtures/example",
            allowedPaths: ["src/**"],
        },
        policy: {
            forbiddenActions: ["network-access"],
        },
        acceptance: {
            commands: [{ executable: "pnpm", args: ["test"] }],
            assertions: ["All tests pass."],
        },
        phases: [{ id: "analyze", description: "Analyze the task." }],
        budget: {
            maxModelTurns: options.maxModelTurns ?? 3,
            maxToolCalls: options.maxToolCalls ?? 10,
            maxRetries: 1,
        },
        userInteraction: {
            allowQuestions: false,
            approvalResponses: ["allow-once", "allow-session", "deny"],
        },
    };
    const context = options.context ?? "Analyze the task and report the outcome.";
    const snapshot = createSpecSnapshot(contract, context);

    return {
        sourcePath: options.sourcePath ?? "C:\\workspace\\specs\\test.md",
        contract,
        context,
        digest: computeSpecDigest(snapshot),
    };
}

export function createSessionStartedEvent(options: {
    eventId: string;
    sessionId: string;
    spec: LoadedSpec;
    timestamp: string;
    sequence?: number;
}): Extract<AgentEvent, { type: "session_started" }> {
    return {
        id: options.eventId,
        sessionId: options.sessionId,
        sequence: options.sequence ?? 1,
        timestamp: options.timestamp,
        type: "session_started",
        specId: options.spec.contract.id,
        specPath: options.spec.sourcePath,
        specDigest: options.spec.digest,
        specSnapshot: createSpecSnapshot(options.spec.contract, options.spec.context),
    };
}
