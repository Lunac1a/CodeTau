import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { TauSessionAdapter } from "../packages/bench/tau/adapter.ts";
import {
    ProcessTauBridgeTransport,
    TauBridgeClient,
} from "../packages/bench/tau/client.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";

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
    const adapter = new TauSessionAdapter({ client, model });

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
    assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 11 });
    assert.equal(model.requests.length, 2);
    assert.equal(model.requests[0]?.includeFinishTool, false);
    assert.deepEqual(
        model.requests[0]?.availableTools.map((tool) => tool.name),
        ["lookup_order"],
    );
    assert.match(model.requests[0]?.messages[0]?.content ?? "", /mock order tool/u);
    assert.deepEqual(model.requests[1]?.messages.at(-1), {
        role: "tool",
        toolCallId: "call-1",
        content: '{"orderId":"100","status":"found"}',
    });
    assert.equal(ids.length, 0);
    assert.equal(client.diagnostics(), "");
});
