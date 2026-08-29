import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runNaturalLanguageCommand } from "../apps/cli/natural-language.ts";
import type { NaturalLanguageUI } from "../apps/cli/terminal-ui.ts";
import type { CodeTauConfig } from "../src/config/loader.ts";
import type { TaskState } from "../src/events.ts";
import type { EventStore } from "../src/persistence/event-store.ts";
import type { SessionReport } from "../src/session/report.ts";
import type { SessionRunnerLike } from "../src/session/runner.ts";
import type { ApprovalResponse } from "../src/spec/types.ts";
import type { AgentEvent, ToolCall } from "../src/types.ts";

function config(rootDirectory: string): CodeTauConfig {
    return {
        databasePath: ":memory:",
        model: "test-model",
        baseUrl: "http://localhost:1234/v1",
        commandAllowlist: ["node"],
        commandTimeoutMs: 1000,
        maxOutputBytes: 1000,
        contextManagement: {
            maxContextTokens: 16_384,
            reservedOutputTokens: 2_048,
            safetyMarginPercent: 10,
            recentConversationTurns: 4,
            recentToolExchanges: 6,
            maxSummaryTokens: 1_200,
            maxToolResultTokens: 2_048,
        },
        sourcePath: join(rootDirectory, "codetau.config.json"),
        rootDirectory,
        naturalLanguage: {
            maxModelTurns: 20,
            maxToolCalls: 60,
            maxRetries: 3,
            additionalProtectedPaths: [],
        },
    };
}

function state(
    status: TaskState["status"],
    final = false,
): TaskState {
    return {
        sessionId: "natural-cli",
        specId: "interactive.natural-cli",
        specPath: "codetau://generated/natural-cli",
        specDigest: "0".repeat(64),
        status,
        revision: 1,
        lastSequence: 2,
        lastEventId: "event-2",
        ...(status === "awaiting_approval"
            ? {
                  pendingApproval: {
                      toolCallId: "create-1",
                      toolName: "create_file",
                  },
              }
            : {}),
        ...(final
            ? { final: { status: "completed" as const, message: "Done" } }
            : {}),
    };
}

class FakeUI implements NaturalLanguageUI {
    readonly interactive: boolean;
    approval?: ToolCall;
    report?: SessionReport;
    error?: string;
    constructor(interactive = true) { this.interactive = interactive; }
    async readTask() { return "Create a file"; }
    async selectValidationCommands() { return []; }
    async confirmPreflight() { return true; }
    async requestApproval(call: ToolCall): Promise<ApprovalResponse> {
        this.approval = call;
        return "allow-once";
    }
    renderEvent() {}
    renderReport(report: SessionReport) { this.report = report; }
    writeError(message: string) { this.error = message; }
    close() {}
}

test("runs a generated task and resolves approval in the same CLI flow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-natural-cli-"));
    try {
        const call: ToolCall = {
            id: "create-1",
            name: "create_file",
            input: { path: "src/new.ts", content: "" },
        };
        const events: AgentEvent[] = [
            {
                id: "event-1",
                sessionId: "natural-cli",
                sequence: 1,
                timestamp: "2026-08-25T00:00:00.000Z",
                type: "model_tool_call",
                toolCall: call,
            },
        ];
        const eventStore: EventStore = {
            async append() {},
            async appendMany() {},
            async loadSession() { return events; },
            async loadTaskState() { return undefined; },
            async close() {},
        };
        let resumedWith: ApprovalResponse | undefined;
        const runner: SessionRunnerLike = {
            async run() { throw new Error("file Spec path was not expected"); },
            async runLoadedSpec(options) {
                assert.equal(options.spec.origin, "generated");
                return state("awaiting_approval");
            },
            async resume(options) {
                resumedWith = options.approvalResponse;
                return state("completed", true);
            },
        };
        const ui = new FakeUI();
        const exitCode = await runNaturalLanguageCommand({
            command: {
                kind: "ask",
                task: "Create a file",
                sessionId: "natural-cli",
                yes: false,
                validationCommands: ["node --test"],
            },
            config: config(directory),
            eventStore,
            runner,
            ui,
        });
        assert.equal(exitCode, 0);
        assert.equal(resumedWith, "allow-once");
        assert.equal(ui.approval?.name, "create_file");
        assert.equal(ui.report?.status, "completed");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("non-interactive tasks persist approval and return exit code 2", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-natural-batch-"));
    try {
        const call: ToolCall = {
            id: "create-1",
            name: "create_file",
            input: { path: "src/new.ts", content: "" },
        };
        const eventStore: EventStore = {
            async append() {},
            async appendMany() {},
            async loadSession() {
                return [{
                    id: "event-1",
                    sessionId: "natural-cli",
                    sequence: 1,
                    timestamp: "2026-08-25T00:00:00.000Z",
                    type: "model_tool_call" as const,
                    toolCall: call,
                }];
            },
            async loadTaskState() { return undefined; },
            async close() {},
        };
        const runner: SessionRunnerLike = {
            async run() { throw new Error("not expected"); },
            async runLoadedSpec() { return state("awaiting_approval"); },
            async resume() { throw new Error("batch mode must not auto-approve"); },
        };
        const ui = new FakeUI(false);
        const exitCode = await runNaturalLanguageCommand({
            command: {
                kind: "ask",
                task: "Create a file",
                sessionId: "natural-cli",
                yes: true,
                validationCommands: ["node --test"],
            },
            config: config(directory),
            eventStore,
            runner,
            ui,
        });
        assert.equal(exitCode, 2);
        assert.match(ui.error ?? "", /codetau resume natural-cli/u);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
