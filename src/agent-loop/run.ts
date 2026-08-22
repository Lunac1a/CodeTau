import { randomUUID } from "node:crypto";

import { rebuildTaskState, type TaskState, type TerminalStatus } from "../events.ts";
import type { ModelMessage, ModelProvider } from "../model.ts";
import { PermissionPolicy } from "../permissions/policy.ts";
import type { EventStore } from "../persistence/event-store.ts";
import type { ApprovalResponse, LoadedSpec } from "../spec/types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type {
    AgentEvent,
    EventBase,
    ModelResponse,
    ToolCall,
    ToolResult,
    TaskStatus,
} from "../types.ts";
import { AgentLoopError } from "./errors.ts";
import { ValidationTracker } from "./validation.ts";

export type AgentLoopRuntime = {
    nextEventId(): string;
    now(): string;
};

export type RunAgentLoopOptions = {
    sessionId: string;
    spec: LoadedSpec;
    model: ModelProvider;
    eventStore: EventStore;
    toolRegistry?: ToolRegistry;
    permissionPolicy?: PermissionPolicy;
    approvalResponse?: ApprovalResponse;
    runtime?: AgentLoopRuntime;
};

type EventWriter = {
    append(event: AgentEvent): Promise<AgentEvent>;
    nextBase(): EventBase;
    changeState(
        to: TaskStatus,
        reason: string,
        sourceEventId: string,
    ): Promise<AgentEvent>;
    finalize(
        status: TerminalStatus,
        message: string,
        sourceEventId: string,
        reason: string,
    ): Promise<TaskState>;
    appendFinal(status: TerminalStatus, message: string): Promise<TaskState>;
    rebuild(): Promise<TaskState>;
};

const defaultRuntime: AgentLoopRuntime = {
    nextEventId: randomUUID,
    now: () => new Date().toISOString(),
};

function buildInitialMessages(
    spec: LoadedSpec,
    availableToolNames: readonly string[],
): ModelMessage[] {
    const toolDescription =
        availableToolNames.length === 0
            ? "No tools are available in this minimal loop."
            : `Available tools: ${availableToolNames.join(", ")}`;
    return [
        {
            role: "system",
            content: [
                "You are executing a bounded coding task inside a sandboxed workspace.",
                `Goal: ${spec.contract.goal}`,
                "Current state: analyzing",
                toolDescription,
                `Allowed workspace paths: ${spec.contract.workspace.allowedPaths.join(", ")}`,
                `Forbidden actions: ${spec.contract.policy.forbiddenActions.join(", ") || "none"}`,
                "Required phases:",
                ...spec.contract.phases.map(
                    (phase, index) =>
                        `${index + 1}. ${phase.id}: ${phase.description}`,
                ),
                "Acceptance commands:",
                ...(spec.contract.acceptance.commands.length === 0
                    ? ["- none"]
                    : spec.contract.acceptance.commands.map(
                          (command, index) =>
                              `- commandIndex ${index}: ${JSON.stringify([command.executable, ...command.args])}`,
                      )),
                "Acceptance assertions:",
                ...(spec.contract.acceptance.assertions.length === 0
                    ? ["- none"]
                    : spec.contract.acceptance.assertions.map(
                          (assertion) => `- ${assertion}`,
                      )),
                "Execution rules:",
                "- Inspect the relevant implementation and tests before editing.",
                "- Fix the implementation. Do not weaken or rewrite acceptance tests unless the task explicitly requires a test change.",
                "- For apply_patch, copy oldText exactly from the latest read_file result, including the original quote or backtick delimiters.",
                "- newText must contain source code only. Never copy test output, stack traces, or validation logs into a patch.",
                "- Never repeat an identical tool call after it fails. Read the returned error and choose a corrective action.",
                "- After a failed validation, call read_file before the next patch and make one targeted source-code correction.",
                "- When the implementation change is ready, run every acceptance command using its commandIndex.",
                "Request at most one approval-requiring tool at a time.",
                "Stop editing when validation passes; the Agent runtime completes automatically.",
            ].join("\n"),
        },
        {
            role: "user",
            content: spec.context,
        },
    ];
}

function rebuildMessages(
    spec: LoadedSpec,
    events: readonly AgentEvent[],
    availableToolNames: readonly string[],
): ModelMessage[] {
    const messages = buildInitialMessages(spec, availableToolNames);

    let pendingToolCalls: ToolCall[] = [];

    function flushToolCalls(): void {
        if (pendingToolCalls.length === 0) {
            return;
        }
        messages.push({
            role: "assistant",
            content: null,
            toolCalls: pendingToolCalls,
        });
        pendingToolCalls = [];
    }

    for (const event of events) {
        if (event.type === "model_tool_call") {
            pendingToolCalls.push(event.toolCall);
            continue;
        }

        flushToolCalls();
        if (event.type === "model_text") {
            messages.push({ role: "assistant", content: event.text });
        } else if (event.type === "tool_result") {
            messages.push({
                role: "tool",
                toolCallId: event.toolCallId,
                content: serializeToolResult(event.result),
            });
        }
    }

    flushToolCalls();

    return messages;
}

function countModelTurns(events: readonly AgentEvent[]): number {
    return events.filter(
        (event) =>
            event.type === "model_text" ||
            event.type === "model_tool_call" ||
            event.type === "model_finish" ||
            event.type === "model_error",
    ).length;
}

function countToolCalls(events: readonly AgentEvent[]): number {
    return events.filter((event) => event.type === "model_tool_call").length;
}

function validationOutput(result: ToolResult): Record<string, unknown> | undefined {
    if (!result.ok || typeof result.output !== "object" || result.output === null) {
        return undefined;
    }
    return Reflect.get(result.output, "passed") === false
        ? (result.output as Record<string, unknown>)
        : undefined;
}

function assertionComparison(
    output: Record<string, unknown>,
): { actual: string; expected: string } | undefined {
    const text = [output.stdout, output.stderr]
        .filter((value): value is string => typeof value === "string")
        .join("\n");
    const actual = text
        .match(/^\s*actual:\s*(.+)\s*$/mu)?.[1]
        ?.replace(/,\s*$/u, "");
    const expected = text
        .match(/^\s*expected:\s*(.+)\s*$/mu)?.[1]
        ?.replace(/,\s*$/u, "");
    return actual === undefined || expected === undefined
        ? undefined
        : { actual, expected };
}

function unquoteDiagnosticValue(value: string): string {
    const trimmed = value.trim();
    const first = trimmed[0];
    const last = trimmed.at(-1);
    return trimmed.length >= 2 && (first === "'" || first === '"') && last === first
        ? trimmed.slice(1, -1)
        : trimmed;
}

function outputDifferenceHint(actualValue: string, expectedValue: string): string {
    const actual = unquoteDiagnosticValue(actualValue);
    const expected = unquoteDiagnosticValue(expectedValue);
    let prefixLength = 0;
    while (
        prefixLength < actual.length &&
        prefixLength < expected.length &&
        actual[prefixLength] === expected[prefixLength]
    ) {
        prefixLength += 1;
    }
    let suffixLength = 0;
    while (
        suffixLength < actual.length - prefixLength &&
        suffixLength < expected.length - prefixLength &&
        actual[actual.length - 1 - suffixLength] ===
            expected[expected.length - 1 - suffixLength]
    ) {
        suffixLength += 1;
    }
    const actualEnd = actual.length - suffixLength;
    const expectedEnd = expected.length - suffixLength;
    const actualFragment = actual.slice(prefixLength, actualEnd);
    const expectedFragment = expected.slice(prefixLength, expectedEnd);
    return `Minimal output difference: replace ${JSON.stringify(actualFragment)} with ${JSON.stringify(expectedFragment)}. Apply that semantic change to the implementation while preserving valid source syntax.`;
}

function compactDiagnostic(output: Record<string, unknown>): string {
    const text = [output.stdout, output.stderr]
        .filter((value): value is string => typeof value === "string" && value !== "")
        .join("\n")
        .trim();
    if (text === "") {
        return "Validation exited without a passing result.";
    }
    const lines = text.split(/\r?\n/u);
    const relevant = lines.filter((line) =>
        /actual|expected|error|fail|timed out/iu.test(line),
    );
    return (relevant.length > 0 ? relevant : lines).slice(0, 12).join("\n").slice(0, 1_500);
}

function modelFacingResult(result: ToolResult): unknown {
    const output = validationOutput(result);
    if (output === undefined) {
        return result;
    }
    const comparison = assertionComparison(output);
    return {
        ok: true,
        output: {
            commandIndex: output.commandIndex,
            passed: false,
            exitCode: output.exitCode,
            timedOut: output.timedOut,
            outputLimitExceeded: output.outputLimitExceeded,
            ...(comparison === undefined
                ? { diagnostic: compactDiagnostic(output) }
                : comparison),
        },
    };
}

function recoveryGuidance(result: ToolResult): string | undefined {
    if (!result.ok && result.error.code === "patch_context_missing") {
        return "The patch did not match the current file. Call read_file for that path and copy exact raw source into oldText. Do not add Markdown quotes or backticks unless those characters are present in the file. Then make the smallest required replacement and do not repeat the same patch.";
    }
    if (!result.ok && result.error.code === "patch_context_ambiguous") {
        return "oldText matched more than one location. Inspect error.details.candidateLines, choose the relevant complete source line, and copy it verbatim into oldText; newText should be the complete corrected line. If no candidate is provided, call read_file. Do not add Markdown quotes or backticks unless they exist in the file.";
    }
    if (!result.ok && result.error.code === "repeated_failed_tool_call") {
        return "This exact tool call has already failed. Do not submit it again. Inspect the latest file or error output and choose a different corrective action.";
    }
    const output = validationOutput(result);
    if (output !== undefined) {
        const comparison = assertionComparison(output);
        if (comparison !== undefined) {
            return `Validation failed. Actual value: ${comparison.actual}. Expected value: ${comparison.expected}. ${outputDifferenceHint(comparison.actual, comparison.expected)} The expected value is authoritative. Call read_file first, preserve source delimiters, and never copy diagnostic text into a patch.`;
        }
        return "Validation failed. The output is diagnostic only: never copy it into oldText or newText. Call read_file, take oldText only from the current file, preserve its quote or backtick delimiters, and make one targeted implementation change before validating again.";
    }
    return undefined;
}

function serializeToolResult(result: ToolResult): string {
    const guidance = recoveryGuidance(result);
    const modelResult = modelFacingResult(result);
    return JSON.stringify(
        guidance === undefined
            ? modelResult
            : { ...(modelResult as object), recoveryGuidance: guidance },
    );
}

function canonicalJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalJsonValue);
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, canonicalJsonValue(child)]),
        );
    }
    return value;
}

function toolCallSignature(call: ToolCall): string {
    return `${call.name}:${JSON.stringify(canonicalJsonValue(call.input))}`;
}

function failedToolCallCounts(messages: readonly ModelMessage[]): Map<string, number> {
    const signatures = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const message of messages) {
        if (message.role === "assistant" && "toolCalls" in message) {
            for (const call of message.toolCalls) {
                signatures.set(call.id, toolCallSignature(call));
            }
            continue;
        }
        if (message.role !== "tool") {
            continue;
        }
        const signature = signatures.get(message.toolCallId);
        if (signature === undefined) {
            continue;
        }
        try {
            const parsed = JSON.parse(message.content) as { ok?: unknown };
            if (parsed.ok === false) {
                counts.set(signature, (counts.get(signature) ?? 0) + 1);
            }
        } catch {
            // Historical non-JSON tool messages cannot contribute to loop detection.
        }
    }
    return counts;
}

function safeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown model provider error";
}

function createEventWriter(options: {
    sessionId: string;
    eventStore: EventStore;
    runtime: AgentLoopRuntime;
    initialSequence: number;
    initialStatus: TaskStatus;
}): EventWriter {
    const { sessionId, eventStore, runtime } = options;
    let sequence = options.initialSequence;
    let status = options.initialStatus;

    function nextBase(): EventBase {
        sequence += 1;
        return {
            id: runtime.nextEventId(),
            sessionId,
            sequence,
            timestamp: runtime.now(),
        };
    }

    async function append(event: AgentEvent): Promise<AgentEvent> {
        await eventStore.append(event);
        return event;
    }

    async function changeState(
        to: TaskStatus,
        reason: string,
        sourceEventId: string,
    ): Promise<AgentEvent> {
        const event: AgentEvent = {
            ...nextBase(),
            type: "state_changed",
            from: status,
            to,
            reason,
            sourceEventId,
        };
        await append(event);
        status = to;
        return event;
    }

    async function appendFinal(
        terminalStatus: TerminalStatus,
        message: string,
    ): Promise<TaskState> {
        await append({
            ...nextBase(),
            type: "final",
            status: terminalStatus,
            message,
        });
        return rebuildTaskState(await eventStore.loadSession(sessionId));
    }

    async function rebuild(): Promise<TaskState> {
        return rebuildTaskState(await eventStore.loadSession(sessionId));
    }

    async function finalize(
        terminalStatus: TerminalStatus,
        message: string,
        sourceEventId: string,
        reason: string,
    ): Promise<TaskState> {
        await changeState(terminalStatus, reason, sourceEventId);
        return appendFinal(terminalStatus, message);
    }

    return { append, nextBase, changeState, finalize, appendFinal, rebuild };
}

async function finalizeModelResponse(
    response: Extract<ModelResponse, { kind: "finish" }>,
    finishEventId: string,
    writer: EventWriter,
    validationTracker: ValidationTracker,
): Promise<TaskState> {
    if (response.outcome === "completed") {
        if (validationTracker.isComplete()) {
            const validatingEvent = await writer.changeState(
                "validating",
                "All Spec acceptance commands have current passing evidence.",
                finishEventId,
            );
            const message =
                response.message.trim() === ""
                    ? "The task completed with passing validation evidence."
                    : response.message;
            return writer.finalize(
                "completed",
                message,
                validatingEvent.id,
                "All required validation commands passed after the latest workspace change.",
            );
        }
        return writer.finalize(
            "failed",
            "Model completion was rejected because no validation evidence exists.",
            finishEventId,
            "A completed outcome cannot be accepted before validation.",
        );
    }

    const terminalMessage =
        response.message.trim() === ""
            ? `Model declared the task ${response.outcome}.`
            : response.message;
    return writer.finalize(
        response.outcome,
        terminalMessage,
        finishEventId,
        `The model declared the task ${response.outcome}.`,
    );
}

async function completeValidatedTask(
    writer: EventWriter,
    sourceEventId: string,
    message = "The task completed automatically after all acceptance commands passed.",
): Promise<TaskState> {
    const validatingEvent = await writer.changeState(
        "validating",
        "All Spec acceptance commands have current passing evidence.",
        sourceEventId,
    );
    return writer.finalize(
        "completed",
        message,
        validatingEvent.id,
        "All required validation commands passed after the latest workspace change.",
    );
}

async function completeIfValidated(
    writer: EventWriter,
    validationTracker: ValidationTracker,
    sourceEventId: string,
): Promise<TaskState | undefined> {
    return validationTracker.isComplete()
        ? completeValidatedTask(writer, sourceEventId)
        : undefined;
}

async function continueModelLoop(options: {
    spec: LoadedSpec;
    model: ModelProvider;
    writer: EventWriter;
    messages: ModelMessage[];
    toolRegistry: ToolRegistry;
    permissionPolicy: PermissionPolicy;
    validationTracker: ValidationTracker;
    initialModelTurns: number;
    initialToolCalls: number;
}): Promise<TaskState> {
    const {
        spec,
        model,
        writer,
        messages,
        toolRegistry,
        permissionPolicy,
        validationTracker,
    } = options;
    let modelTurns = options.initialModelTurns;
    let toolCalls = options.initialToolCalls;
    const failedCalls = failedToolCallCounts(messages);

    while (true) {
        if (modelTurns >= spec.contract.budget.maxModelTurns) {
            const budgetEvent = await writer.append({
                ...writer.nextBase(),
                type: "budget_exhausted",
                budget: "model_turns",
                limit: spec.contract.budget.maxModelTurns,
            });
            return writer.finalize(
                "failed",
                "Model turn budget exhausted.",
                budgetEvent.id,
                "The model turn budget was exhausted before a valid terminal outcome.",
            );
        }

        modelTurns += 1;
        let response: ModelResponse;
        try {
            response = await model.generate({
                messages: [...messages],
                availableTools: toolRegistry.definitions(),
            });
        } catch (error) {
            const errorEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_error",
                error: {
                    code: "model_provider_error",
                    message: safeErrorMessage(error),
                },
            });
            return writer.finalize(
                "failed",
                "The model provider failed.",
                errorEvent.id,
                "The model provider returned an error.",
            );
        }

        if (response.kind === "text") {
            await writer.append({
                ...writer.nextBase(),
                type: "model_text",
                text: response.text,
                usage: response.usage,
            });
            messages.push({ role: "assistant", content: response.text });
            continue;
        }

        if (response.kind === "finish") {
            const finishEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_finish",
                outcome: response.outcome,
                message: response.message,
                usage: response.usage,
            });
            return finalizeModelResponse(
                response,
                finishEvent.id,
                writer,
                validationTracker,
            );
        }

        if (response.calls.length === 0) {
            const errorEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_error",
                error: {
                    code: "empty_tool_calls",
                    message: "The model returned an empty tool call list.",
                },
            });
            return writer.finalize(
                "failed",
                "The model returned an empty tool call list.",
                errorEvent.id,
                "An empty tool call response cannot advance the task.",
            );
        }

        messages.push({
            role: "assistant",
            content: null,
            toolCalls: [...response.calls],
        });

        const approvalCalls = response.calls.filter((call) => {
            const tool = toolRegistry.get(call.name);
            return (
                tool !== undefined &&
                permissionPolicy.evaluate(tool.permission).kind ===
                    "approval_required"
            );
        });
        if (response.calls.length > 1 && approvalCalls.length > 0) {
            const errorEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_error",
                error: {
                    code: "approval_batch_unsupported",
                    message:
                        "Approval-requiring tools must be requested one at a time",
                },
            });
            return writer.finalize(
                "failed",
                "Approval-requiring tools must be requested one at a time.",
                errorEvent.id,
                "A batched approval request cannot be resumed safely.",
            );
        }

        for (const toolCall of response.calls) {
            if (toolCalls >= spec.contract.budget.maxToolCalls) {
                const budgetEvent = await writer.append({
                    ...writer.nextBase(),
                    type: "budget_exhausted",
                    budget: "tool_calls",
                    limit: spec.contract.budget.maxToolCalls,
                });
                return writer.finalize(
                    "failed",
                    "Tool call budget exhausted.",
                    budgetEvent.id,
                    "The tool call budget was exhausted before validation.",
                );
            }

            const toolEvent = await writer.append({
                ...writer.nextBase(),
                type: "model_tool_call",
                toolCall,
            });
            toolCalls += 1;
            const signature = toolCallSignature(toolCall);
            const previousFailures = failedCalls.get(signature) ?? 0;
            const outcome =
                previousFailures >= 2
                    ? {
                          kind: "result" as const,
                          result: {
                              ok: false as const,
                              error: {
                                  code: "repeated_failed_tool_call",
                                  message:
                                      "The identical tool call has already failed twice and was not executed again.",
                                  details: { previousFailures },
                              },
                          },
                      }
                    : await executeToolCall(
                          toolCall,
                          toolRegistry,
                          permissionPolicy,
                      );
            if (outcome.kind === "approval_required") {
                await writer.changeState(
                    "awaiting_approval",
                    `Tool requires approval before execution: ${toolCall.name}`,
                    toolEvent.id,
                );
                return writer.rebuild();
            }
            const { result } = outcome;
            const resultEvent = await writer.append({
                ...writer.nextBase(),
                type: "tool_result",
                toolCallId: toolCall.id,
                result,
            });
            messages.push({
                role: "tool",
                toolCallId: toolCall.id,
                content: serializeToolResult(result),
            });
            if (!result.ok) {
                failedCalls.set(signature, previousFailures + 1);
            }
            validationTracker.record(toolCall, result);
            const completed = await completeIfValidated(
                writer,
                validationTracker,
                resultEvent.id,
            );
            if (completed !== undefined) {
                return completed;
            }
            if (!result.ok && previousFailures >= 3) {
                return writer.finalize(
                    "failed",
                    "Repeated failed tool call loop detected.",
                    resultEvent.id,
                    `The model repeated the same failed ${toolCall.name} call without a corrective action.`,
                );
            }
            const retryFailure = await failIfRetryBudgetExceeded(
                spec,
                writer,
                validationTracker,
                resultEvent.id,
            );
            if (retryFailure !== undefined) {
                return retryFailure;
            }
        }
    }
}

async function failIfRetryBudgetExceeded(
    spec: LoadedSpec,
    writer: EventWriter,
    validationTracker: ValidationTracker,
    sourceEventId: string,
): Promise<TaskState | undefined> {
    if (validationTracker.failedAttempts <= spec.contract.budget.maxRetries) {
        return undefined;
    }
    const budgetEvent = await writer.append({
        ...writer.nextBase(),
        type: "budget_exhausted",
        budget: "retries",
        limit: spec.contract.budget.maxRetries,
    });
    return writer.finalize(
        "failed",
        "Validation retry budget exhausted.",
        budgetEvent.id,
        `Validation continued to fail after tool result ${sourceEventId}.`,
    );
}

type ToolExecutionOutcome =
    | { readonly kind: "result"; readonly result: ToolResult }
    | {
          readonly kind: "approval_required";
          readonly allowedResponses: readonly ApprovalResponse[];
      };

async function executeToolCall(
    call: ToolCall,
    toolRegistry: ToolRegistry,
    permissionPolicy: PermissionPolicy,
): Promise<ToolExecutionOutcome> {
    const tool = toolRegistry.get(call.name);
    if (tool === undefined) {
        return { kind: "result", result: await toolRegistry.execute(call) };
    }

    const decision = permissionPolicy.evaluate(tool.permission);
    if (decision.kind === "deny") {
        return {
            kind: "result",
            result: {
                ok: false,
                error: {
                    code: decision.code,
                    message: decision.message,
                },
            },
        };
    }
    if (decision.kind === "approval_required") {
        return {
            kind: "approval_required",
            allowedResponses: decision.allowedResponses,
        };
    }

    return { kind: "result", result: await toolRegistry.execute(call) };
}

function findToolCall(
    events: readonly AgentEvent[],
    toolCallId: string,
): ToolCall | undefined {
    for (const event of events) {
        if (event.type === "model_tool_call" && event.toolCall.id === toolCallId) {
            return event.toolCall;
        }
    }
    return undefined;
}

function restoreSessionApprovals(
    events: readonly AgentEvent[],
    toolRegistry: ToolRegistry,
    permissionPolicy: PermissionPolicy,
): void {
    for (const event of events) {
        if (event.type !== "approval_resolved" || event.response !== "allow-session") {
            continue;
        }
        const call = findToolCall(events, event.toolCallId);
        const tool = call === undefined ? undefined : toolRegistry.get(call.name);
        if (tool !== undefined) {
            permissionPolicy.resolve(tool.permission, "allow-session");
        }
    }
}

async function resolveApprovedToolCall(options: {
    call: ToolCall;
    response: ApprovalResponse;
    toolRegistry: ToolRegistry;
    permissionPolicy: PermissionPolicy;
}): Promise<ToolResult> {
    const { call, response, toolRegistry, permissionPolicy } = options;
    const tool = toolRegistry.get(call.name);
    if (tool === undefined) {
        return toolRegistry.execute(call);
    }

    const decision = permissionPolicy.resolve(tool.permission, response);
    if (decision.kind === "allow") {
        return toolRegistry.execute(call);
    }
    if (decision.kind === "deny") {
        return {
            ok: false,
            error: { code: decision.code, message: decision.message },
        };
    }
    return {
        ok: false,
        error: {
            code: "approval_required",
            message: `Tool still requires approval: ${call.name}`,
        },
    };
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<TaskState> {
    const runtime = options.runtime ?? defaultRuntime;
    const toolRegistry = options.toolRegistry ?? new ToolRegistry();
    const permissionPolicy =
        options.permissionPolicy ?? new PermissionPolicy(options.spec.contract);
    const validationTracker = new ValidationTracker(
        options.spec.contract.acceptance.commands.length,
        toolRegistry,
    );
    const existingEvents = await options.eventStore.loadSession(options.sessionId);

    if (existingEvents.length > 0) {
        throw new AgentLoopError({
            code: "session_already_exists",
            message: `Session already exists: ${options.sessionId}`,
            sessionId: options.sessionId,
        });
    }

    const writer = createEventWriter({
        sessionId: options.sessionId,
        eventStore: options.eventStore,
        runtime,
        initialSequence: 0,
        initialStatus: "created",
    });
    const startedEvent = await writer.append({
        ...writer.nextBase(),
        type: "session_started",
        specId: options.spec.contract.id,
        specPath: options.spec.sourcePath,
        specDigest: options.spec.digest,
        specSnapshot: {
            contract: options.spec.contract,
            context: options.spec.context,
        },
    });
    await writer.changeState(
        "analyzing",
        "The Spec was loaded and validated.",
        startedEvent.id,
    );

    return continueModelLoop({
        spec: options.spec,
        model: options.model,
        writer,
        messages: buildInitialMessages(options.spec, toolRegistry.names()),
        toolRegistry,
        permissionPolicy,
        validationTracker,
        initialModelTurns: 0,
        initialToolCalls: 0,
    });
}

export async function resumeAgentLoop(options: RunAgentLoopOptions): Promise<TaskState> {
    const runtime = options.runtime ?? defaultRuntime;
    const toolRegistry = options.toolRegistry ?? new ToolRegistry();
    const permissionPolicy =
        options.permissionPolicy ?? new PermissionPolicy(options.spec.contract);
    const events = await options.eventStore.loadSession(options.sessionId);

    if (events.length === 0) {
        throw new AgentLoopError({
            code: "session_not_found",
            message: `Session does not exist: ${options.sessionId}`,
            sessionId: options.sessionId,
        });
    }

    const state = rebuildTaskState(events);
    const validationTracker = ValidationTracker.fromEvents(
        events,
        options.spec.contract.acceptance.commands.length,
        toolRegistry,
    );
    if (
        state.specId !== options.spec.contract.id ||
        state.specDigest !== options.spec.digest
    ) {
        throw new AgentLoopError({
            code: "session_spec_mismatch",
            message: `Session ${options.sessionId} was created from a different Spec`,
            sessionId: options.sessionId,
        });
    }

    if (state.final !== undefined) {
        throw new AgentLoopError({
            code: "session_terminal",
            message: `Session is already final: ${options.sessionId}`,
            sessionId: options.sessionId,
        });
    }

    restoreSessionApprovals(events, toolRegistry, permissionPolicy);

    const writer = createEventWriter({
        sessionId: options.sessionId,
        eventStore: options.eventStore,
        runtime,
        initialSequence: state.lastSequence,
        initialStatus: state.status,
    });
    const lastEvent = events.at(-1) as AgentEvent;

    if (
        state.status === "completed" ||
        state.status === "failed" ||
        state.status === "blocked"
    ) {
        const transition = lastEvent.type === "state_changed" ? lastEvent : undefined;
        const message = transition
            ? `Recovered ${state.status} state: ${transition.reason}`
            : `Recovered terminal state: ${state.status}`;
        return writer.appendFinal(state.status, message);
    }

    if (state.status === "analyzing" && validationTracker.isComplete()) {
        return completeValidatedTask(writer, lastEvent.id);
    }

    if (state.status === "awaiting_approval") {
        if (options.approvalResponse === undefined) {
            return state;
        }
        const pendingApproval = state.pendingApproval;
        if (pendingApproval === undefined) {
            throw new AgentLoopError({
                code: "session_state_unsupported",
                message: "Approval state has no pending tool call",
                sessionId: options.sessionId,
            });
        }
        const pendingCall = findToolCall(events, pendingApproval.toolCallId);
        if (pendingCall === undefined) {
            throw new AgentLoopError({
                code: "session_state_unsupported",
                message: `Pending tool call is missing: ${pendingApproval.toolCallId}`,
                sessionId: options.sessionId,
            });
        }

        const approvalEvent = await writer.append({
            ...writer.nextBase(),
            type: "approval_resolved",
            toolCallId: pendingCall.id,
            response: options.approvalResponse,
        });
        const result = await resolveApprovedToolCall({
            call: pendingCall,
            response: options.approvalResponse,
            toolRegistry,
            permissionPolicy,
        });
        await writer.changeState(
            "analyzing",
            `Approval was resolved for tool: ${pendingCall.name}`,
            approvalEvent.id,
        );
        const resultEvent = await writer.append({
            ...writer.nextBase(),
            type: "tool_result",
            toolCallId: pendingCall.id,
            result,
        });
        const messages = rebuildMessages(options.spec, events, toolRegistry.names());
        messages.push({
            role: "tool",
            toolCallId: pendingCall.id,
            content: serializeToolResult(result),
        });
        validationTracker.record(pendingCall, result);
        const completed = await completeIfValidated(
            writer,
            validationTracker,
            resultEvent.id,
        );
        if (completed !== undefined) {
            return completed;
        }
        const retryFailure = await failIfRetryBudgetExceeded(
            options.spec,
            writer,
            validationTracker,
            resultEvent.id,
        );
        if (retryFailure !== undefined) {
            return retryFailure;
        }
        return continueModelLoop({
            spec: options.spec,
            model: options.model,
            writer,
            messages,
            toolRegistry,
            permissionPolicy,
            validationTracker,
            initialModelTurns: countModelTurns(events),
            initialToolCalls: countToolCalls(events),
        });
    }

    if (state.status === "created") {
        await writer.changeState(
            "analyzing",
            "The session resumed after its validated Spec was recorded.",
            lastEvent.id,
        );
    } else if (state.status !== "analyzing") {
        throw new AgentLoopError({
            code: "session_state_unsupported",
            message: `The minimal loop cannot resume state: ${state.status}`,
            sessionId: options.sessionId,
        });
    } else if (lastEvent.type === "model_finish") {
        return finalizeModelResponse(
            {
                kind: "finish",
                outcome: lastEvent.outcome,
                message: lastEvent.message,
                usage: lastEvent.usage,
            },
            lastEvent.id,
            writer,
            validationTracker,
        );
    } else if (lastEvent.type === "model_error") {
        return writer.finalize(
            "failed",
            "The model provider failed.",
            lastEvent.id,
            "The recovered model provider call had failed.",
        );
    } else if (lastEvent.type === "budget_exhausted") {
        return writer.finalize(
            "failed",
            "Model turn budget exhausted.",
            lastEvent.id,
            "The recovered session had exhausted its model turn budget.",
        );
    }

    const messages = rebuildMessages(options.spec, events, toolRegistry.names());
    if (lastEvent.type === "model_tool_call") {
        const outcome = await executeToolCall(
            lastEvent.toolCall,
            toolRegistry,
            permissionPolicy,
        );
        if (outcome.kind === "approval_required") {
            await writer.changeState(
                "awaiting_approval",
                `Tool requires approval before execution: ${lastEvent.toolCall.name}`,
                lastEvent.id,
            );
            return writer.rebuild();
        }
        const { result } = outcome;
        const resultEvent = await writer.append({
            ...writer.nextBase(),
            type: "tool_result",
            toolCallId: lastEvent.toolCall.id,
            result,
        });
        messages.push({
            role: "tool",
            toolCallId: lastEvent.toolCall.id,
            content: serializeToolResult(result),
        });
        validationTracker.record(lastEvent.toolCall, result);
        const completed = await completeIfValidated(
            writer,
            validationTracker,
            resultEvent.id,
        );
        if (completed !== undefined) {
            return completed;
        }
        const retryFailure = await failIfRetryBudgetExceeded(
            options.spec,
            writer,
            validationTracker,
            resultEvent.id,
        );
        if (retryFailure !== undefined) {
            return retryFailure;
        }
    }

    return continueModelLoop({
        spec: options.spec,
        model: options.model,
        writer,
        messages,
        toolRegistry,
        permissionPolicy,
        validationTracker,
        initialModelTurns: countModelTurns(events),
        initialToolCalls: countToolCalls(events),
    });
}
