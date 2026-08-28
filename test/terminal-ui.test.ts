import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { TerminalUI } from "../apps/cli/terminal-ui.ts";

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

test("collects a multiline task and terminal control responses", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk: Buffer) => {
        rendered += chunk.toString("utf8");
    });
    const ui = new TerminalUI({
        input,
        output,
        error: output,
        interactive: true,
        color: false,
    });
    try {
        const taskPromise = ui.readTask();
        input.write("Fix registration\n");
        await nextTurn();
        input.write("Preserve behavior\n");
        await nextTurn();
        input.write(":run\n");
        assert.equal(
            await taskPromise,
            "Fix registration\nPreserve behavior",
        );

        const validationPromise = ui.selectValidationCommands([
            { executable: "node", args: ["--test"] },
        ]);
        input.write("\n");
        assert.deepEqual(await validationPromise, [
            { executable: "node", args: ["--test"] },
        ]);

        const approvalPromise = ui.requestApproval({
            id: "write-1",
            name: "apply_patch",
            input: { path: "src/user.ts" },
        });
        input.write("2\n");
        assert.equal(await approvalPromise, "allow-session");
        assert.match(rendered, /Describe the task/u);
        assert.match(rendered, /Modify src\/user\.ts/u);
        assert.doesNotMatch(rendered, /\u001B\[/u);
    } finally {
        ui.close();
        input.destroy();
        output.destroy();
    }
});

test("allows an interactive task to be cancelled", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ui = new TerminalUI({
        input,
        output,
        error: output,
        interactive: true,
        color: false,
    });
    try {
        const taskPromise = ui.readTask();
        input.write(":cancel\n");
        assert.equal(await taskPromise, undefined);
    } finally {
        ui.close();
        input.destroy();
        output.destroy();
    }
});

test("reads single-line and multiline conversation messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk: Buffer) => {
        rendered += chunk.toString("utf8");
    });
    const ui = new TerminalUI({
        input,
        output,
        error: output,
        interactive: true,
        color: false,
    });
    try {
        ui.renderConversationHeader({
            conversationId: "conversation-1",
            resumed: false,
            completedTurns: 0,
        });
        const first = ui.readConversationMessage();
        input.write("fix the greeting\n");
        assert.equal(await first, "fix the greeting");

        const second = ui.readConversationMessage();
        input.write(":multi\n");
        await nextTurn();
        input.write("create a file\n");
        await nextTurn();
        input.write("and test it\n");
        await nextTurn();
        input.write(":send\n");
        assert.equal(await second, "create a file\nand test it");

        ui.renderAssistantReply("Done and verified.");
        const exit = ui.readConversationMessage();
        input.write(":exit\n");
        assert.equal(await exit, undefined);
        assert.match(rendered, /New conversation: conversation-1/u);
        assert.match(rendered, /CodeTau> Done and verified/u);
    } finally {
        ui.close();
        input.destroy();
        output.destroy();
    }
});

test("queues exit entered while a conversation turn is still finishing", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ui = new TerminalUI({
        input,
        output,
        error: output,
        interactive: true,
        color: false,
    });
    try {
        const first = ui.readConversationMessage();
        input.write("fix the bug\n");
        assert.equal(await first, "fix the bug");

        // The user types this after Completed is printed but before the next
        // You> question exists. It must remain queued for that next question.
        input.write(":exit\n");
        await nextTurn();

        assert.equal(await ui.readConversationMessage(), undefined);
    } finally {
        ui.close();
        input.destroy();
        output.destroy();
    }
});

test("renders concise progress by default and hides model reasoning", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk: Buffer) => {
        rendered += chunk.toString("utf8");
    });
    const ui = new TerminalUI({
        input,
        output,
        error: output,
        interactive: false,
        color: false,
    });
    const base = {
        sessionId: "session-1",
        timestamp: "2026-08-28T00:00:00.000Z",
    };

    ui.renderEvent({
        ...base,
        id: "event-1",
        sequence: 1,
        type: "model_text",
        text: "Long internal reasoning",
        usage: { inputTokens: 10, outputTokens: 10 },
    });
    ui.renderEvent({
        ...base,
        id: "event-2",
        sequence: 2,
        type: "model_tool_call",
        toolCall: { id: "read-1", name: "read_file", input: { path: "src/a.ts" } },
    });
    ui.renderEvent({
        ...base,
        id: "event-3",
        sequence: 3,
        type: "tool_result",
        toolCallId: "read-1",
        result: { ok: true, output: { path: "src/a.ts" } },
    });
    ui.renderEvent({
        ...base,
        id: "event-4",
        sequence: 4,
        type: "model_tool_call",
        toolCall: { id: "validate-1", name: "run_validation", input: { commandIndex: 0 } },
    });
    ui.renderEvent({
        ...base,
        id: "event-5",
        sequence: 5,
        type: "tool_result",
        toolCallId: "validate-1",
        result: { ok: true, output: { passed: false } },
    });
    ui.renderReport({
        sessionId: "session-1",
        status: "failed",
        changedFiles: [],
        passedValidationIndexes: [],
        validationCount: 1,
        modelTurns: 2,
        toolCalls: 2,
        inputTokens: 20,
        outputTokens: 10,
    });

    assert.doesNotMatch(rendered, /Long internal reasoning/u);
    assert.doesNotMatch(rendered, /Reading src\/a\.ts/u);
    assert.match(rendered, /Run validation #0/u);
    assert.match(rendered, /✗ Validation failed/u);
    assert.doesNotMatch(rendered, /Usage:/u);
    ui.close();
    input.destroy();
    output.destroy();
});

test("verbose mode shows reasoning and detailed usage", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk: Buffer) => {
        rendered += chunk.toString("utf8");
    });
    const ui = new TerminalUI({
        input,
        output,
        error: output,
        interactive: false,
        color: false,
        verbose: true,
    });
    ui.renderEvent({
        id: "event-1",
        sessionId: "session-1",
        sequence: 1,
        timestamp: "2026-08-28T00:00:00.000Z",
        type: "model_text",
        text: "Detailed reasoning",
        usage: { inputTokens: 10, outputTokens: 5 },
    });
    ui.renderReport({
        sessionId: "session-1",
        status: "completed",
        changedFiles: [],
        passedValidationIndexes: [0],
        validationCount: 1,
        modelTurns: 1,
        toolCalls: 0,
        inputTokens: 10,
        outputTokens: 5,
    });

    assert.match(rendered, /Detailed reasoning/u);
    assert.match(rendered, /Usage: 1 model turns/u);
    ui.close();
    input.destroy();
    output.destroy();
});

test("renders safe terminal markdown in assistant replies", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk: Buffer) => {
        rendered += chunk.toString("utf8");
    });
    const ui = new TerminalUI({
        input,
        output,
        error: output,
        interactive: false,
        color: false,
    });

    ui.renderAssistantReply([
        "# Result",
        "",
        "- Changed **one file**",
        "- See [docs](https://example.com)",
        "",
        "```ts",
        "const answer = 42;",
        "```",
        "\u001B[31muntrusted",
    ].join("\n"));

    assert.match(rendered, /CodeTau> Result/u);
    assert.match(rendered, /• Changed one file/u);
    assert.match(rendered, /docs \(https:\/\/example\.com\)/u);
    assert.match(rendered, /  const answer = 42;/u);
    assert.doesNotMatch(rendered, /\*\*|```|\u001B\[/u);
    assert.match(rendered, /�\[31muntrusted/u);
    ui.close();
    input.destroy();
    output.destroy();
});
