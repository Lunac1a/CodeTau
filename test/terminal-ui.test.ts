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
