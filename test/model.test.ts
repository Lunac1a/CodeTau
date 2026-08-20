import assert from "node:assert/strict";
import test from "node:test";

import { FakeModelProvider } from "./fakes/fake-model.ts";

test("fake model returns deterministic scripted responses", async () => {
    const model = new FakeModelProvider([
        {
            kind: "text",
            text: "I will inspect the repository.",
            usage: { inputTokens: 8, outputTokens: 7 },
        },
        {
            kind: "finish",
            outcome: "completed",
            message: "Done",
            usage: { inputTokens: 12, outputTokens: 2 },
        },
    ]);

    const request = {
        messages: [{ role: "user" as const, content: "Fix the task" }],
        availableTools: [
            {
                name: "read_file",
                description: "Read a file.",
                inputSchema: { type: "object" },
            },
        ],
    };

    assert.equal((await model.generate(request)).kind, "text");
    assert.equal((await model.generate(request)).kind, "finish");
    assert.equal(model.requests.length, 2);
    assert.equal(model.remainingResponses, 0);
});

test("fake model fails loudly when a test forgets a response", async () => {
    const model = new FakeModelProvider([]);

    await assert.rejects(
        model.generate({ messages: [], availableTools: [] }),
        /no response left/,
    );
});
