import assert from "node:assert/strict";
import test from "node:test";

import {
    parseBridgeLine,
    TAU_PROTOCOL_VERSION,
    TauProtocolError,
} from "../packages/bench/tau/protocol.ts";

test("parses a strict tau agent turn", () => {
    const message = parseBridgeLine(
        JSON.stringify({
            version: TAU_PROTOCOL_VERSION,
            id: "run-1:turn:1",
            type: "agent_turn",
            payload: {
                message: {
                    kind: "tool",
                    toolCallId: "call-1",
                    name: "lookup_order",
                    result: { status: "found" },
                },
            },
        }),
    );

    assert.equal(message.type, "agent_turn");
    if (message.type === "agent_turn") {
        assert.equal(message.payload.message.kind, "tool");
    }
});

test("preserves the upstream tool mutation classification", () => {
    const message = parseBridgeLine(
        JSON.stringify({
            version: TAU_PROTOCOL_VERSION,
            id: "run-1:init",
            type: "agent_init",
            payload: {
                domainPolicy: "Follow policy.",
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
        }),
    );

    assert.equal(message.type, "agent_init");
    if (message.type === "agent_init") {
        assert.deepEqual(message.payload.tools[0], {
            name: "update_order",
            description: "Update an order",
            parameters: { type: "object" },
            toolType: "write",
            mutatesState: true,
        });
    }
});

test("rejects unknown tau bridge fields and message types", () => {
    assert.throws(
        () =>
            parseBridgeLine(
                JSON.stringify({
                    version: TAU_PROTOCOL_VERSION,
                    id: "result-1",
                    type: "shutdown_result",
                    payload: {},
                    extra: true,
                }),
            ),
        (error: unknown) => {
            assert.ok(error instanceof TauProtocolError);
            assert.equal(error.code, "invalid_payload");
            return true;
        },
    );
    assert.throws(
        () =>
            parseBridgeLine(
                JSON.stringify({
                    version: TAU_PROTOCOL_VERSION,
                    id: "result-1",
                    type: "host_only_message",
                    payload: {},
                }),
            ),
        (error: unknown) => {
            assert.ok(error instanceof TauProtocolError);
            assert.equal(error.code, "unexpected_message_type");
            return true;
        },
    );
});

test("parses official diagnostics from a tau run result", () => {
    const message = parseBridgeLine(JSON.stringify({
        version: TAU_PROTOCOL_VERSION,
        id: "run-1",
        type: "run_result",
        payload: {
            reward: 0,
            status: "completed",
            metadata: {
                upstreamCommit: "abc",
                protocolVersion: TAU_PROTOCOL_VERSION,
                domain: "airline",
                taskSplit: "base",
                taskId: "0",
                trial: 1,
                seed: 42,
            },
            diagnostics: {
                terminationReason: "user_stop",
                rewardInfo: {
                    reward: 0,
                    reward_basis: ["DB", "COMMUNICATE"],
                    reward_breakdown: { DB: 0, COMMUNICATE: 1 },
                },
            },
        },
    }));

    assert.equal(message.type, "run_result");
    if (message.type === "run_result") {
        assert.equal(message.payload.diagnostics.terminationReason, "user_stop");
        assert.deepEqual(message.payload.diagnostics.rewardInfo.reward_breakdown, {
            DB: 0,
            COMMUNICATE: 1,
        });
    }
});
