import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
    buildTauSystemPrompt,
    TauAdapterError,
    TauSessionAdapter,
} from "../packages/bench/tau/adapter.ts";
import {
    ProcessTauBridgeTransport,
    TauBridgeClient,
    type TauBridgeTransport,
} from "../packages/bench/tau/client.ts";
import type {
    BridgeMessage,
    HostMessage,
} from "../packages/bench/tau/protocol.ts";
import type { TauPolicyVerifier } from "../packages/bench/tau/policy-verifier.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";

class PolicyTestTransport implements TauBridgeTransport {
    readonly sent: HostMessage[] = [];
    readonly #responses: BridgeMessage[] = [];

    async send(message: HostMessage): Promise<void> {
        this.sent.push(structuredClone(message));
        if (message.type === "handshake") {
            this.#responses.push({
                version: 3,
                id: message.id,
                type: "handshake_result",
                payload: {
                    server: { name: "policy-test", version: "1" },
                    protocolVersion: 3,
                    upstream: {
                        displayName: "tau3",
                        distribution: "tau2-bench",
                        release: "1.0.1",
                        commit: "fc0055",
                    },
                },
            });
        } else if (message.type === "run_start") {
            this.#responses.push({
                version: 3,
                id: `${message.id}:init`,
                type: "agent_init",
                payload: {
                    domainPolicy: "Never update an order without manager approval.",
                    tools: [
                        {
                            name: "update_order",
                            description: "Update an order",
                            parameters: { type: "object" },
                            toolType: "write",
                            mutatesState: true,
                        },
                    ],
                    messageHistory: [],
                },
            });
        } else if (message.type === "agent_init_result") {
            this.#responses.push({
                version: 3,
                id: "run-1:turn:1",
                type: "agent_turn",
                payload: { message: { kind: "user", content: "Update order 100." } },
            });
        } else if (message.type === "agent_turn_result") {
            this.#responses.push({
                version: 3,
                id: "run-1",
                type: "run_result",
                payload: {
                    reward: 1,
                    status: "completed",
                    metadata: {
                        upstreamCommit: "fc0055",
                        protocolVersion: 3,
                        domain: "mock",
                        taskSplit: "base",
                        taskId: "task-1",
                        trial: 1,
                        seed: 7,
                    },
                    diagnostics: {
                        terminationReason: "user_stop",
                        rewardInfo: { reward_breakdown: { DB: 1 } },
                    },
                },
            });
        } else if (message.type === "shutdown") {
            this.#responses.push({
                version: 3,
                id: message.id,
                type: "shutdown_result",
                payload: {},
            });
        }
    }

    async receive(): Promise<BridgeMessage> {
        const response = this.#responses.shift();
        if (response === undefined) {
            throw new Error("No scripted policy-test bridge response remains");
        }
        return response;
    }

    async waitForExit(): Promise<number> {
        return 0;
    }

    async terminate(): Promise<number> {
        return 0;
    }

    diagnostics(): string {
        return "";
    }
}

test("builds a domain-neutral evidence-first tau system prompt", () => {
    const prompt = buildTauSystemPrompt("Follow the mock order tool policy.");

    assert.match(prompt, /only authoritative facts/u);
    assert.match(prompt, /A tool being available does not make the action allowed/u);
    assert.match(prompt, /state-changing tool/u);
    assert.match(prompt, /minimum necessary tool calls/u);
    assert.match(prompt, /Follow the mock order tool policy/u);
    assert.doesNotMatch(prompt, /EHGLP3|send_certificate/u);
    assert.throws(
        () => buildTauSystemPrompt(""),
        (error: unknown) => {
            assert.ok(error instanceof TauAdapterError);
            assert.equal(error.code, "invalid_domain_policy");
            return true;
        },
    );
});

test("runs CodeTau model turns through the fake Python tau bridge", async () => {
    const ids = ["hello", "run-1", "stop"];
    const transport = new ProcessTauBridgeTransport({
        command: "python",
        args: ["-m", "tau_bridge", "--fake"],
        cwd: resolve("python"),
        timeoutMs: 5_000,
    });
    const client = new TauBridgeClient(transport, () => {
        const id = ids.shift();
        if (id === undefined) {
            throw new Error("No deterministic tau message id remains");
        }
        return id;
    });
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [
                {
                    id: "call-1",
                    name: "lookup_order",
                    input: { orderId: "100" },
                },
            ],
            usage: { inputTokens: 20, outputTokens: 5 },
        },
        {
            kind: "text",
            text: "Order 100 was found.",
            usage: { inputTokens: 30, outputTokens: 6 },
        },
    ]);
    const times = [1_000, 1_250];
    const adapter = new TauSessionAdapter({
        client,
        model,
        now: () => times.shift() as number,
    });

    const result = await adapter.run({
        domain: "mock",
        taskSplit: "base",
        taskId: "task-1",
        trial: 1,
        seed: 7,
    });

    assert.equal(result.reward, 1);
    assert.equal(result.status, "completed");
    assert.equal(result.modelTurns, 2);
    assert.equal(result.toolCalls, 1);
    assert.deepEqual(result.toolCallsByName, { lookup_order: 1 });
    assert.equal(result.durationMs, 250);
    assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 11 });
    assert.equal(result.evidence.official.terminationReason, "user_stop");
    assert.deepEqual(result.evidence.official.rewardInfo.reward_breakdown, {
        DB: 1,
    });
    assert.equal(result.evidence.session.trajectory.length, 4);
    assert.deepEqual(
        result.evidence.session.trajectory.map((event) => event.direction),
        ["tau_to_agent", "agent_to_tau", "tau_to_agent", "agent_to_tau"],
    );
    assert.equal(model.requests.length, 2);
    assert.equal(model.requests[0]?.includeFinishTool, false);
    assert.deepEqual(
        model.requests[0]?.availableTools.map((tool) => tool.name),
        ["lookup_order"],
    );
    assert.match(model.requests[0]?.messages[0]?.content ?? "", /mock order tool/u);
    assert.match(
        model.requests[0]?.messages[0]?.content ?? "",
        /only authoritative facts/u,
    );
    assert.deepEqual(model.requests[1]?.messages.at(-1), {
        role: "tool",
        toolCallId: "call-1",
        content: '{"orderId":"100","status":"found"}',
    });
    assert.equal(ids.length, 0);
    assert.equal(times.length, 0);
    assert.equal(client.diagnostics(), "");
});

test("withholds a verifier-denied mutating call from the tau environment", async () => {
    const transport = new PolicyTestTransport();
    const ids = ["hello", "run-1", "stop"];
    const client = new TauBridgeClient(transport, () => ids.shift() as string);
    const model = new FakeModelProvider([
        {
            kind: "tool_calls",
            calls: [
                {
                    id: "write-1",
                    name: "update_order",
                    input: { orderId: "100", status: "cancelled" },
                },
            ],
            usage: { inputTokens: 10, outputTokens: 4 },
        },
        {
            kind: "text",
            text: "I cannot update the order without verified approval.",
            usage: { inputTokens: 14, outputTokens: 7 },
        },
    ]);
    const verifier: TauPolicyVerifier = {
        async verify() {
            return {
                verdict: {
                    decision: "deny",
                    reason: "Manager approval is not established.",
                    policyQuote: "Never update an order without manager approval.",
                },
                usage: { inputTokens: 8, outputTokens: 3 },
            };
        },
    };
    const adapter = new TauSessionAdapter({ client, model, policyVerifier: verifier });

    const result = await adapter.run({
        domain: "mock",
        taskSplit: "base",
        taskId: "task-1",
        trial: 1,
        seed: 7,
    });

    assert.equal(result.toolCalls, 0);
    assert.deepEqual(result.policyVerifier, {
        checks: 1,
        allows: 0,
        denials: 1,
        usage: { inputTokens: 8, outputTokens: 3 },
    });
    assert.equal(result.evidence.session.policyChecks[0]?.proposedCalls[0]?.name, "update_order");
    const turnResult = transport.sent.find(
        (message): message is Extract<HostMessage, { type: "agent_turn_result" }> =>
            message.type === "agent_turn_result",
    );
    assert.deepEqual(turnResult?.payload.message, {
        role: "assistant",
        content: "I cannot update the order without verified approval.",
        toolCalls: [],
    });
    assert.equal(
        transport.sent.some(
            (message) =>
                message.type === "agent_turn_result" &&
                message.payload.message.toolCalls.some(
                    (call) => call.name === "update_order",
                ),
        ),
        false,
    );
});
