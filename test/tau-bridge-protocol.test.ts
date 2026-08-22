import assert from "node:assert/strict";
import test from "node:test";

import {
    parseBridgeLine,
    TauProtocolError,
} from "../packages/bench/tau/protocol.ts";

test("parses a strict tau agent turn", () => {
    const message = parseBridgeLine(
        JSON.stringify({
            version: 1,
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

test("rejects unknown tau bridge fields and message types", () => {
    assert.throws(
        () =>
            parseBridgeLine(
                JSON.stringify({
                    version: 1,
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
                    version: 1,
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
