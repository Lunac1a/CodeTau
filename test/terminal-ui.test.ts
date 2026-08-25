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
