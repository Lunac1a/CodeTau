import assert from "node:assert/strict";
import test from "node:test";

import {
    ContextManager,
    estimateModelRequestTokens,
    estimateTextTokens,
} from "../src/context/manager.ts";
import { ContextBudgetExceededError } from "../src/context/types.ts";
import type { ModelMessage } from "../src/model.ts";

function manager(overrides: Partial<ContextManager["config"]> = {}): ContextManager {
    return new ContextManager({
        maxContextTokens: 900,
        reservedOutputTokens: 100,
        safetyMarginPercent: 0,
        recentConversationTurns: 4,
        recentToolExchanges: 2,
        maxSummaryTokens: 100,
        maxToolResultTokens: 80,
        ...overrides,
    });
}

test("estimates multilingual request tokens deterministically", () => {
    assert.equal(estimateTextTokens("abcdef"), 2);
    assert.equal(estimateTextTokens("你好世界"), 4);
    const messages = [{ role: "user" as const, content: "const answer = 42;" }];
    assert.equal(
        estimateModelRequestTokens(messages, []),
        estimateModelRequestTokens(structuredClone(messages), []),
    );
});

test("preserves a request exactly when it fits", () => {
    const messages: ModelMessage[] = [
        { role: "system", content: "policy" },
        { role: "user", content: "task" },
    ];
    const compiled = manager().compile({
        messages,
        availableTools: [],
        mode: "agent",
        requiredPrefixMessages: 2,
    });
    assert.deepEqual(compiled.messages, messages);
    assert.deepEqual(compiled.operations, []);
    assert.match(compiled.digest, /^[a-f0-9]{64}$/u);
});

test("compacts old exchanges and bounds recent tool output", () => {
    const messages: ModelMessage[] = [
        { role: "system", content: "policy" },
        { role: "user", content: "task" },
    ];
    for (let index = 0; index < 7; index += 1) {
        messages.push({
            role: "assistant",
            content: null,
            toolCalls: [{
                id: `call-${index}`,
                name: "read_file",
                input: { path: `src/file-${index}.ts` },
            }],
        });
        messages.push({
            role: "tool",
            toolCallId: `call-${index}`,
            content: JSON.stringify({
                ok: true,
                output: {
                    path: `src/file-${index}.ts`,
                    bytes: 2_000,
                    content: "x".repeat(2_000),
                },
            }),
        });
    }
    const compiled = manager().compile({
        messages,
        availableTools: [],
        mode: "agent",
        requiredPrefixMessages: 2,
    });
    assert.ok(compiled.estimatedInputTokens <= compiled.effectiveInputLimit);
    assert.ok(compiled.operations.some((operation) => operation.kind === "checkpoint"));
    assert.ok(
        compiled.operations.some(
            (operation) => operation.kind === "tool_result_compacted",
        ),
    );
    const recentCalls = compiled.messages
        .filter((message) => message.role === "assistant" && "toolCalls" in message)
        .flatMap((message) =>
            message.role === "assistant" && "toolCalls" in message
                ? message.toolCalls.map((call) => call.id)
                : [],
        );
    const recentResults = compiled.messages
        .filter((message) => message.role === "tool")
        .map((message) => (message.role === "tool" ? message.toolCallId : ""));
    assert.deepEqual(recentResults, recentCalls);
});

test("fails before dropping required context", () => {
    assert.throws(
        () =>
            manager({ maxContextTokens: 200, reservedOutputTokens: 50 }).compile({
                messages: [
                    { role: "system", content: "policy".repeat(200) },
                    { role: "user", content: "task".repeat(200) },
                ],
                availableTools: [],
                mode: "required",
            }),
        (error: unknown) => {
            assert.ok(error instanceof ContextBudgetExceededError);
            assert.equal(error.code, "context_budget_exceeded");
            assert.ok(error.exceededByTokens > 0);
            return true;
        },
    );
});
