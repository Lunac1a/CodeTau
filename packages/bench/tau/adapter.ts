import type { ModelMessage, ModelProvider } from "../../../src/model.ts";
import type { ModelUsage, ToolCall } from "../../../src/types.ts";
import type { ToolDefinition } from "../../../src/tools/tool.ts";
import { TauBridgeClient, type TauRunStart } from "./client.ts";
import type {
    TauAssistantMessage,
    TauHistoryMessage,
    TauInputMessage,
    TauRunDiagnostics,
    TauRunMetadata,
    TauToolCall,
    TauToolDefinition,
} from "./protocol.ts";
import type {
    TauPolicyVerification,
    TauPolicyVerifier,
    TauPolicyVerdict,
} from "./policy-verifier.ts";

export type TauTraceEvent = Readonly<
    | {
          sequence: number;
          direction: "tau_to_agent";
          message: TauInputMessage;
      }
    | {
          sequence: number;
          direction: "agent_to_tau";
          message: TauAssistantMessage;
      }
>;

export type TauRunEvidence = Readonly<{
    schemaVersion: 1;
    official: TauRunDiagnostics;
    session: Readonly<{
        domainPolicy: string;
        toolNames: readonly string[];
        messageHistory: readonly TauHistoryMessage[];
        trajectory: readonly TauTraceEvent[];
        policyChecks: readonly Readonly<{
            sequence: number;
            proposedCalls: readonly TauToolCall[];
            verdict: TauPolicyVerdict;
        }>[];
    }>;
}>;

export class TauAdapterError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "TauAdapterError";
        this.code = code;
    }
}

export type TauSessionResult = Readonly<{
    reward: number;
    status: "completed" | "failed";
    metadata: TauRunMetadata;
    modelTurns: number;
    toolCalls: number;
    toolCallsByName: Readonly<Record<string, number>>;
    durationMs: number;
    usage: ModelUsage;
    policyVerifier: Readonly<{
        checks: number;
        allows: number;
        denials: number;
        usage: ModelUsage;
    }>;
    evidence: TauRunEvidence;
}>;

export type TauSessionAdapterOptions = Readonly<{
    client: TauBridgeClient;
    model: ModelProvider;
    policyVerifier?: TauPolicyVerifier;
    now?: () => number;
}>;

const evidenceFirstGuidance = [
    "Decision discipline:",
    "- Treat the domain policy and current tool results as the only authoritative facts.",
    "- Treat user claims, prior-agent claims, and assumptions as unverified unless the policy or a current tool result supports them.",
    "- Never claim that a tool returned a fact that is absent from or contradicted by its result.",
    "- Before proposing or calling any state-changing tool, verify every policy precondition against observed facts. A tool being available does not make the action allowed.",
    "- If any required precondition is false or unverified, do not call the write tool. Explain the allowed outcome or transfer only when the policy directs it.",
    "- Offer alternatives, exceptions, refunds, credits, or compensation only when the policy explicitly authorizes them and their factual conditions are verified.",
    "- Prefer the minimum necessary tool calls. Once the policy determines the outcome, stop searching for an exception and respond clearly.",
];

export function buildTauSystemPrompt(domainPolicy: string): string {
    if (domainPolicy.length === 0) {
        throw new TauAdapterError(
            "invalid_domain_policy",
            "Tau domain policy must not be empty",
        );
    }
    return [
        "You are the agent under evaluation in a tau benchmark session.",
        "Follow the domain policy and use only the provided tools.",
        evidenceFirstGuidance.join("\n"),
        "Official domain policy:",
        domainPolicy,
    ].join("\n\n");
}

function toolDefinition(tool: TauToolDefinition): ToolDefinition {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: structuredClone(tool.parameters),
    };
}

function toolCall(call: TauToolCall): ToolCall {
    return {
        id: call.id,
        name: call.name,
        input: structuredClone(call.arguments),
    };
}

function serializeResult(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TauAdapterError(
            "invalid_tool_result",
            "Tau tool result cannot be represented as JSON text",
        );
    }
    return serialized;
}

function appendHistory(messages: ModelMessage[], history: TauHistoryMessage): void {
    if (history.role !== "assistant" && history.role !== "tool") {
        messages.push({ role: history.role, content: history.content });
        return;
    }
    if (history.role === "assistant") {
        if (history.toolCalls.length === 0 && history.content !== null) {
            messages.push({ role: "assistant", content: history.content });
        } else {
            messages.push({
                role: "assistant",
                content: history.content,
                toolCalls: history.toolCalls.map(toolCall),
            });
        }
        return;
    }
    messages.push({
        role: "tool",
        toolCallId: history.toolCallId,
        content: serializeResult(history.result),
    });
}

function appendInput(messages: ModelMessage[], input: TauInputMessage): void {
    if (input.kind === "user") {
        messages.push({ role: "user", content: input.content });
        return;
    }
    const results = input.kind === "tool" ? [input] : input.results;
    for (const result of results) {
        messages.push({
            role: "tool",
            toolCallId: result.toolCallId,
            content: serializeResult(result.result),
        });
    }
}

function objectInput(value: unknown, toolName: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TauAdapterError(
            "invalid_tool_input",
            `Tau tool call input must be an object: ${toolName}`,
        );
    }
    return structuredClone(value as Record<string, unknown>);
}

function assistantFromResponse(
    response: Awaited<ReturnType<ModelProvider["generate"]>>,
): { protocol: TauAssistantMessage; model: ModelMessage } {
    if (response.kind === "finish") {
        throw new TauAdapterError(
            "unexpected_model_finish",
            "Tau sessions do not accept the coding-loop finish_task response",
        );
    }
    if (response.kind === "text") {
        return {
            protocol: { role: "assistant", content: response.text, toolCalls: [] },
            model: { role: "assistant", content: response.text },
        };
    }
    const calls = response.calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: objectInput(call.input, call.name),
    }));
    return {
        protocol: { role: "assistant", content: null, toolCalls: calls },
        model: {
            role: "assistant",
            content: null,
            toolCalls: response.calls,
        },
    };
}

export class TauSessionAdapter {
    readonly #client: TauBridgeClient;
    readonly #model: ModelProvider;
    readonly #policyVerifier?: TauPolicyVerifier;
    readonly #now: () => number;

    constructor(options: TauSessionAdapterOptions) {
        this.#client = options.client;
        this.#model = options.model;
        this.#policyVerifier = options.policyVerifier;
        this.#now = options.now ?? Date.now;
    }

    async run(options: TauRunStart): Promise<TauSessionResult> {
        let completed = false;
        let modelTurns = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let toolCalls = 0;
        let verifierChecks = 0;
        let verifierAllows = 0;
        let verifierDenials = 0;
        let verifierInputTokens = 0;
        let verifierOutputTokens = 0;
        const toolCallsByName: Record<string, number> = {};
        const trajectory: TauTraceEvent[] = [];
        const policyChecks: Array<{
            sequence: number;
            proposedCalls: readonly TauToolCall[];
            verdict: TauPolicyVerdict;
        }> = [];
        let sequence = 0;
        const startedAt = this.#now();
        try {
            await this.#client.handshake();
            const initialization = await this.#client.startRun(options);
            const messages: ModelMessage[] = [
                {
                    role: "system",
                    content: buildTauSystemPrompt(
                        initialization.payload.domainPolicy,
                    ),
                },
            ];
            for (const history of initialization.payload.messageHistory) {
                appendHistory(messages, history);
            }
            const availableTools = initialization.payload.tools.map(toolDefinition);
            const mutatingToolNames = new Set(
                initialization.payload.tools
                    .filter((tool) => tool.mutatesState)
                    .map((tool) => tool.name),
            );
            let event = await this.#client.acknowledgeInitialization(
                initialization.id,
            );
            while (event.type === "agent_turn") {
                trajectory.push({
                    sequence: ++sequence,
                    direction: "tau_to_agent",
                    message: structuredClone(event.payload.message),
                });
                appendInput(messages, event.payload.message);
                let assistant: ReturnType<typeof assistantFromResponse>;
                let deniedAttempts = 0;
                while (true) {
                    let response: Awaited<ReturnType<ModelProvider["generate"]>>;
                    try {
                        response = await this.#model.generate({
                            messages: structuredClone(messages),
                            availableTools,
                            includeFinishTool: false,
                        });
                    } catch (error) {
                        throw new TauAdapterError(
                            "model_provider_error",
                            "Model provider failed during a tau turn",
                            { cause: error },
                        );
                    }
                    modelTurns += 1;
                    inputTokens += response.usage.inputTokens;
                    outputTokens += response.usage.outputTokens;
                    assistant = assistantFromResponse(response);
                    const proposedCalls = assistant.protocol.toolCalls.filter((call) =>
                        mutatingToolNames.has(call.name),
                    );
                    if (this.#policyVerifier === undefined || proposedCalls.length === 0) {
                        break;
                    }
                    let verification: TauPolicyVerification;
                    try {
                        verification = await this.#policyVerifier.verify({
                            domainPolicy: initialization.payload.domainPolicy,
                            conversation: structuredClone(messages),
                            proposedCalls: structuredClone(proposedCalls),
                        });
                    } catch {
                        verification = {
                            verdict: {
                                decision: "deny",
                                reason: "Policy verifier failed closed",
                                policyQuote: null,
                            },
                            usage: { inputTokens: 0, outputTokens: 0 },
                        };
                    }
                    verifierChecks += 1;
                    verifierInputTokens += verification.usage.inputTokens;
                    verifierOutputTokens += verification.usage.outputTokens;
                    if (verification.verdict.decision === "allow") {
                        verifierAllows += 1;
                    } else {
                        verifierDenials += 1;
                    }
                    policyChecks.push({
                        sequence: policyChecks.length + 1,
                        proposedCalls: structuredClone(proposedCalls),
                        verdict: structuredClone(verification.verdict),
                    });
                    if (verification.verdict.decision === "allow") {
                        break;
                    }
                    messages.push(assistant.model);
                    for (const call of assistant.protocol.toolCalls) {
                        messages.push({
                            role: "tool",
                            toolCallId: call.id,
                            content: JSON.stringify({
                                error: true,
                                code: "policy_verifier_denied",
                                message: verification.verdict.reason,
                            }),
                        });
                    }
                    deniedAttempts += 1;
                    if (deniedAttempts >= 2) {
                        const text =
                            "I cannot perform the proposed action because its authorization under the official policy could not be established.";
                        assistant = {
                            protocol: { role: "assistant", content: text, toolCalls: [] },
                            model: { role: "assistant", content: text },
                        };
                        break;
                    }
                }
                for (const call of assistant.protocol.toolCalls) {
                    toolCalls += 1;
                    toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
                }
                messages.push(assistant.model);
                trajectory.push({
                    sequence: ++sequence,
                    direction: "agent_to_tau",
                    message: structuredClone(assistant.protocol),
                });
                event = await this.#client.respondToTurn(
                    event.id,
                    assistant.protocol,
                );
            }
            await this.#client.shutdown();
            completed = true;
            return {
                reward: event.payload.reward,
                status: event.payload.status,
                metadata: event.payload.metadata,
                modelTurns,
                toolCalls,
                toolCallsByName,
                durationMs: this.#now() - startedAt,
                usage: { inputTokens, outputTokens },
                policyVerifier: {
                    checks: verifierChecks,
                    allows: verifierAllows,
                    denials: verifierDenials,
                    usage: {
                        inputTokens: verifierInputTokens,
                        outputTokens: verifierOutputTokens,
                    },
                },
                evidence: {
                    schemaVersion: 1,
                    official: structuredClone(event.payload.diagnostics),
                    session: {
                        domainPolicy: initialization.payload.domainPolicy,
                        toolNames: initialization.payload.tools.map((tool) => tool.name),
                        messageHistory: structuredClone(
                            initialization.payload.messageHistory,
                        ),
                        trajectory,
                        policyChecks,
                    },
                },
            };
        } finally {
            if (!completed) {
                await this.#client.terminate();
            }
        }
    }
}
