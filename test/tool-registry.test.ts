import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistryError } from "../src/tools/errors.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { AgentTool } from "../src/tools/tool.ts";

function echoTool(name = "echo"): AgentTool {
    return {
        name,
        async execute(input) {
            return { ok: true, output: input };
        },
    };
}

test("registers tools and lists their names in stable order", () => {
    const registry = new ToolRegistry([echoTool("write_file"), echoTool("read_file")]);

    assert.equal(registry.has("read_file"), true);
    assert.equal(registry.has("run_command"), false);
    assert.deepEqual(registry.names(), ["read_file", "write_file"]);
});

test("rejects an empty or duplicate tool name", () => {
    assert.throws(
        () => new ToolRegistry([echoTool("   ")]),
        (error: unknown) => {
            assert.ok(error instanceof ToolRegistryError);
            assert.equal(error.code, "tool_name_invalid");
            return true;
        },
    );

    const registry = new ToolRegistry([echoTool()]);
    assert.throws(
        () => registry.register(echoTool()),
        (error: unknown) => {
            assert.ok(error instanceof ToolRegistryError);
            assert.equal(error.code, "tool_already_registered");
            assert.equal(error.toolName, "echo");
            return true;
        },
    );
});

test("dispatches a call to its registered tool", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const input = { message: "hello" };

    assert.deepEqual(
        await registry.execute({ id: "call-1", name: "echo", input }),
        { ok: true, output: input },
    );
});

test("returns a structured failure for an unknown tool", async () => {
    const registry = new ToolRegistry();

    assert.deepEqual(
        await registry.execute({ id: "call-2", name: "missing", input: {} }),
        {
            ok: false,
            error: {
                code: "tool_not_found",
                message: "Tool is not registered: missing",
            },
        },
    );
});

test("converts a thrown tool error into a structured failure", async () => {
    const registry = new ToolRegistry([
        {
            name: "broken",
            async execute() {
                throw new Error("The tool broke");
            },
        },
    ]);

    assert.deepEqual(
        await registry.execute({ id: "call-3", name: "broken", input: null }),
        {
            ok: false,
            error: {
                code: "tool_execution_failed",
                message: "The tool broke",
            },
        },
    );
});
