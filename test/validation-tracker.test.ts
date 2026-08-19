import assert from "node:assert/strict";
import test from "node:test";

import { ValidationTracker } from "../src/agent-loop/validation.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { AgentTool } from "../src/tools/tool.ts";

function tool(
    name: string,
    risk: AgentTool["permission"]["risk"],
): AgentTool {
    return {
        name,
        permission: { action: name, risk },
        async execute() {
            return { ok: true, output: null };
        },
    };
}

function validationResult(commandIndex: number, passed: boolean) {
    return {
        ok: true as const,
        output: { commandIndex, passed },
    };
}

test("requires every validation command to pass", () => {
    const registry = new ToolRegistry([tool("run_validation", "execute")]);
    const tracker = new ValidationTracker(2, registry);

    tracker.record(
        { id: "validation-1", name: "run_validation", input: {} },
        validationResult(0, true),
    );
    assert.equal(tracker.isComplete(), false);
    tracker.record(
        { id: "validation-2", name: "run_validation", input: {} },
        validationResult(1, true),
    );
    assert.equal(tracker.isComplete(), true);
    assert.deepEqual(tracker.passedCommandIndexes(), [0, 1]);
});

test("failed validation counts retries and removes prior evidence", () => {
    const registry = new ToolRegistry([tool("run_validation", "execute")]);
    const tracker = new ValidationTracker(1, registry);
    const call = { id: "validation", name: "run_validation", input: {} };

    tracker.record(call, validationResult(0, true));
    tracker.record(call, validationResult(0, false));

    assert.equal(tracker.isComplete(), false);
    assert.equal(tracker.failedAttempts, 1);
});

test("a successful workspace write invalidates earlier validation", () => {
    const registry = new ToolRegistry([
        tool("run_validation", "execute"),
        tool("apply_patch", "write"),
    ]);
    const tracker = new ValidationTracker(1, registry);
    tracker.record(
        { id: "validation", name: "run_validation", input: {} },
        validationResult(0, true),
    );
    tracker.record(
        { id: "patch", name: "apply_patch", input: {} },
        { ok: true, output: { changed: true } },
    );

    assert.equal(tracker.isComplete(), false);
});
