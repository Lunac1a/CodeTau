import { Buffer } from "node:buffer";

export const TAU_PROTOCOL_VERSION = 1;
export const TAU_MAX_LINE_BYTES = 1_048_576;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class TauProtocolError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "TauProtocolError";
        this.code = code;
    }
}

export type TauToolDefinition = Readonly<{
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
}>;

export type TauToolCall = Readonly<{
    id: string;
    name: string;
    arguments: Readonly<Record<string, unknown>>;
}>;

export type TauAssistantMessage = Readonly<{
    role: "assistant";
    content: string | null;
    toolCalls: readonly TauToolCall[];
}>;

export type TauHistoryMessage =
    | Readonly<{ role: "system" | "user"; content: string }>
    | TauAssistantMessage
    | Readonly<{
          role: "tool";
          toolCallId: string;
          name: string;
          result: unknown;
      }>;

export type TauInputMessage =
    | Readonly<{ kind: "user"; content: string }>
    | Readonly<{
          kind: "tool";
          toolCallId: string;
          name: string;
          result: unknown;
      }>
    | Readonly<{
          kind: "multi_tool";
          results: readonly Readonly<{
              toolCallId: string;
              name: string;
              result: unknown;
          }>[];
      }>;

export type TauRunMetadata = Readonly<{
    upstreamCommit: string;
    protocolVersion: number;
    domain: string;
    taskSplit: string;
    taskId: string | null;
    trial: number;
    seed: number | null;
}>;

type Envelope<Type extends string, Payload> = Readonly<{
    version: 1;
    id: string;
    type: Type;
    payload: Payload;
}>;

export type BridgeMessage =
    | Envelope<
          "handshake_result",
          Readonly<{
              server: Readonly<{ name: string; version: string }>;
              protocolVersion: number;
              upstream: Readonly<{
                  displayName: string;
                  distribution: string;
                  release: string;
                  commit: string;
              }>;
          }>
      >
    | Envelope<
          "agent_init",
          Readonly<{
              domainPolicy: string;
              tools: readonly TauToolDefinition[];
              messageHistory: readonly TauHistoryMessage[];
          }>
      >
    | Envelope<"agent_turn", Readonly<{ message: TauInputMessage }>>
    | Envelope<
          "run_result",
          Readonly<{
              reward: number;
              status: "completed" | "failed";
              metadata: TauRunMetadata;
          }>
      >
    | Envelope<
          "error",
          Readonly<{
              code: string;
              message: string;
              fatal: boolean;
              details: Readonly<Record<string, unknown>> | null;
          }>
      >
    | Envelope<"shutdown_result", Readonly<Record<string, never>>>;

export type HostMessage =
    | Envelope<
          "handshake",
          Readonly<{
              client: Readonly<{ name: string; version: string }>;
              protocolVersion: 1;
          }>
      >
    | Envelope<
          "run_start",
          Readonly<{
              domain: string;
              taskSplit: string;
              taskId: string | null;
              trial: number;
              seed: number | null;
          }>
      >
    | Envelope<"agent_init_result", Readonly<Record<string, never>>>
    | Envelope<"agent_turn_result", Readonly<{ message: TauAssistantMessage }>>
    | Envelope<"shutdown", Readonly<Record<string, never>>>;

function record(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TauProtocolError("invalid_payload", `${name} must be an object`);
    }
    return value as Record<string, unknown>;
}

function exact(
    value: unknown,
    name: string,
    expectedKeys: readonly string[],
): Record<string, unknown> {
    const result = record(value, name);
    const keys = Object.keys(result).sort();
    const expected = [...expectedKeys].sort();
    if (
        keys.length !== expected.length ||
        keys.some((key, index) => key !== expected[index])
    ) {
        throw new TauProtocolError(
            "invalid_payload",
            `${name} must contain exactly: ${expected.join(", ") || "no fields"}`,
        );
    }
    return result;
}

function text(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TauProtocolError(
            "invalid_payload",
            `${name} must be a non-empty string`,
        );
    }
    return value;
}

function nullableText(value: unknown, name: string): string | null {
    return value === null ? null : text(value, name);
}

function integer(value: unknown, name: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TauProtocolError(
            "invalid_payload",
            `${name} must be an integer >= ${minimum}`,
        );
    }
    return value as number;
}

function nullableInteger(value: unknown, name: string): number | null {
    return value === null ? null : integer(value, name);
}

function objectValue(
    value: unknown,
    name: string,
): Readonly<Record<string, unknown>> {
    return structuredClone(record(value, name));
}

function toolCall(value: unknown, name: string): TauToolCall {
    const item = exact(value, name, ["id", "name", "arguments"]);
    return {
        id: text(item.id, `${name}.id`),
        name: text(item.name, `${name}.name`),
        arguments: objectValue(item.arguments, `${name}.arguments`),
    };
}

function assistantMessage(value: unknown, name: string): TauAssistantMessage {
    const item = exact(value, name, ["role", "content", "toolCalls"]);
    if (item.role !== "assistant") {
        throw new TauProtocolError(
            "invalid_payload",
            `${name}.role must be assistant`,
        );
    }
    if (!Array.isArray(item.toolCalls)) {
        throw new TauProtocolError(
            "invalid_payload",
            `${name}.toolCalls must be an array`,
        );
    }
    const calls = item.toolCalls.map((call, index) =>
        toolCall(call, `${name}.toolCalls[${index}]`),
    );
    const content = nullableText(item.content, `${name}.content`);
    if (content === null && calls.length === 0) {
        throw new TauProtocolError(
            "invalid_payload",
            `${name} must contain text or tool calls`,
        );
    }
    return { role: "assistant", content, toolCalls: calls };
}

function toolResult(value: unknown, name: string): {
    toolCallId: string;
    name: string;
    result: unknown;
} {
    const item = exact(value, name, ["toolCallId", "name", "result"]);
    return {
        toolCallId: text(item.toolCallId, `${name}.toolCallId`),
        name: text(item.name, `${name}.name`),
        result: structuredClone(item.result),
    };
}

function historyMessage(value: unknown, name: string): TauHistoryMessage {
    const item = record(value, name);
    if (item.role === "system" || item.role === "user") {
        const message = exact(value, name, ["role", "content"]);
        return { role: item.role, content: text(message.content, `${name}.content`) };
    }
    if (item.role === "assistant") {
        return assistantMessage(value, name);
    }
    if (item.role === "tool") {
        const message = exact(value, name, [
            "role",
            "toolCallId",
            "name",
            "result",
        ]);
        return {
            role: "tool",
            ...toolResult(
                {
                    toolCallId: message.toolCallId,
                    name: message.name,
                    result: message.result,
                },
                name,
            ),
        };
    }
    throw new TauProtocolError("invalid_payload", `${name}.role is invalid`);
}

function inputMessage(value: unknown, name: string): TauInputMessage {
    const item = record(value, name);
    if (item.kind === "user") {
        const message = exact(value, name, ["kind", "content"]);
        return { kind: "user", content: text(message.content, `${name}.content`) };
    }
    if (item.kind === "tool") {
        const message = exact(value, name, [
            "kind",
            "toolCallId",
            "name",
            "result",
        ]);
        return {
            kind: "tool",
            ...toolResult(
                {
                    toolCallId: message.toolCallId,
                    name: message.name,
                    result: message.result,
                },
                name,
            ),
        };
    }
    if (item.kind === "multi_tool") {
        const message = exact(value, name, ["kind", "results"]);
        if (!Array.isArray(message.results) || message.results.length === 0) {
            throw new TauProtocolError(
                "invalid_payload",
                `${name}.results must be a non-empty array`,
            );
        }
        return {
            kind: "multi_tool",
            results: message.results.map((result, index) =>
                toolResult(result, `${name}.results[${index}]`),
            ),
        };
    }
    throw new TauProtocolError("invalid_payload", `${name}.kind is invalid`);
}

function toolDefinition(value: unknown, name: string): TauToolDefinition {
    const item = exact(value, name, ["name", "description", "parameters"]);
    return {
        name: text(item.name, `${name}.name`),
        description: text(item.description, `${name}.description`),
        parameters: objectValue(item.parameters, `${name}.parameters`),
    };
}

function parseBridgePayload(type: string, value: unknown): BridgeMessage["payload"] {
    if (type === "handshake_result") {
        const item = exact(value, "handshake_result payload", [
            "server",
            "protocolVersion",
            "upstream",
        ]);
        const server = exact(item.server, "handshake_result server", [
            "name",
            "version",
        ]);
        const upstream = exact(item.upstream, "handshake_result upstream", [
            "displayName",
            "distribution",
            "release",
            "commit",
        ]);
        return {
            server: {
                name: text(server.name, "server.name"),
                version: text(server.version, "server.version"),
            },
            protocolVersion: integer(item.protocolVersion, "protocolVersion", 1),
            upstream: {
                displayName: text(upstream.displayName, "upstream.displayName"),
                distribution: text(upstream.distribution, "upstream.distribution"),
                release: text(upstream.release, "upstream.release"),
                commit: text(upstream.commit, "upstream.commit"),
            },
        };
    }
    if (type === "agent_init") {
        const item = exact(value, "agent_init payload", [
            "domainPolicy",
            "tools",
            "messageHistory",
        ]);
        if (!Array.isArray(item.tools) || !Array.isArray(item.messageHistory)) {
            throw new TauProtocolError(
                "invalid_payload",
                "agent_init tools and messageHistory must be arrays",
            );
        }
        return {
            domainPolicy: text(item.domainPolicy, "agent_init domainPolicy"),
            tools: item.tools.map((tool, index) =>
                toolDefinition(tool, `agent_init tools[${index}]`),
            ),
            messageHistory: item.messageHistory.map((message, index) =>
                historyMessage(message, `agent_init messageHistory[${index}]`),
            ),
        };
    }
    if (type === "agent_turn") {
        const item = exact(value, "agent_turn payload", ["message"]);
        return { message: inputMessage(item.message, "agent_turn message") };
    }
    if (type === "run_result") {
        const item = exact(value, "run_result payload", [
            "reward",
            "status",
            "metadata",
        ]);
        if (
            typeof item.reward !== "number" ||
            !Number.isFinite(item.reward) ||
            item.reward < 0 ||
            item.reward > 1
        ) {
            throw new TauProtocolError("invalid_payload", "reward must be from 0 to 1");
        }
        if (item.status !== "completed" && item.status !== "failed") {
            throw new TauProtocolError("invalid_payload", "run status is invalid");
        }
        const metadata = exact(item.metadata, "run_result metadata", [
            "upstreamCommit",
            "protocolVersion",
            "domain",
            "taskSplit",
            "taskId",
            "trial",
            "seed",
        ]);
        return {
            reward: item.reward,
            status: item.status,
            metadata: {
                upstreamCommit: text(metadata.upstreamCommit, "metadata.upstreamCommit"),
                protocolVersion: integer(metadata.protocolVersion, "metadata.protocolVersion", 1),
                domain: text(metadata.domain, "metadata.domain"),
                taskSplit: text(metadata.taskSplit, "metadata.taskSplit"),
                taskId: nullableText(metadata.taskId, "metadata.taskId"),
                trial: integer(metadata.trial, "metadata.trial", 1),
                seed: nullableInteger(metadata.seed, "metadata.seed"),
            },
        };
    }
    if (type === "error") {
        const item = exact(value, "error payload", [
            "code",
            "message",
            "fatal",
            "details",
        ]);
        if (typeof item.fatal !== "boolean") {
            throw new TauProtocolError("invalid_payload", "error.fatal must be boolean");
        }
        return {
            code: text(item.code, "error.code"),
            message: text(item.message, "error.message"),
            fatal: item.fatal,
            details:
                item.details === null
                    ? null
                    : objectValue(item.details, "error.details"),
        };
    }
    if (type === "shutdown_result") {
        return exact(value, "shutdown_result payload", []) as Record<string, never>;
    }
    throw new TauProtocolError(
        "unexpected_message_type",
        `unsupported bridge message type: ${type}`,
    );
}

const bridgeTypes = new Set([
    "handshake_result",
    "agent_init",
    "agent_turn",
    "run_result",
    "error",
    "shutdown_result",
]);

export function parseBridgeLine(line: string): BridgeMessage {
    if (Buffer.byteLength(line, "utf8") > TAU_MAX_LINE_BYTES) {
        throw new TauProtocolError("message_too_large", "bridge line exceeds 1 MiB");
    }
    let value: unknown;
    try {
        value = JSON.parse(line) as unknown;
    } catch (error) {
        throw new TauProtocolError("invalid_json", "bridge emitted invalid JSON", {
            cause: error,
        });
    }
    const envelope = exact(value, "bridge envelope", [
        "version",
        "id",
        "type",
        "payload",
    ]);
    if (envelope.version !== TAU_PROTOCOL_VERSION) {
        throw new TauProtocolError(
            "unsupported_version",
            "bridge envelope version must be 1",
        );
    }
    const id = text(envelope.id, "bridge envelope.id");
    if (!idPattern.test(id)) {
        throw new TauProtocolError("invalid_envelope", "bridge envelope.id is invalid");
    }
    const type = text(envelope.type, "bridge envelope.type");
    if (!bridgeTypes.has(type)) {
        throw new TauProtocolError(
            "unexpected_message_type",
            `unsupported bridge message type: ${type}`,
        );
    }
    return {
        version: 1,
        id,
        type,
        payload: parseBridgePayload(type, envelope.payload),
    } as BridgeMessage;
}

export function encodeHostMessage(message: HostMessage): string {
    if (!idPattern.test(message.id)) {
        throw new TauProtocolError("invalid_envelope", "host message id is invalid");
    }
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, "utf8") > TAU_MAX_LINE_BYTES) {
        throw new TauProtocolError("message_too_large", "host line exceeds 1 MiB");
    }
    return line;
}
