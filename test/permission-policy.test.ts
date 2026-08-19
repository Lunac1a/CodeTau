import assert from "node:assert/strict";
import test from "node:test";

import { PermissionPolicy } from "../src/permissions/policy.ts";
import type { TaskSpecContract } from "../src/spec/types.ts";

function createPolicy(options: {
    forbiddenActions?: string[];
    approvalResponses?: TaskSpecContract["userInteraction"]["approvalResponses"];
} = {}): PermissionPolicy {
    return new PermissionPolicy({
        policy: {
            forbiddenActions: options.forbiddenActions ?? [],
        },
        userInteraction: {
            allowQuestions: false,
            approvalResponses:
                options.approvalResponses ?? ["allow-once", "allow-session", "deny"],
        },
    });
}

const readPermission = { action: "workspace-read", risk: "read" } as const;
const writePermission = { action: "workspace-write", risk: "write" } as const;

test("allows a non-forbidden read without approval", () => {
    assert.deepEqual(createPolicy().evaluate(readPermission), {
        kind: "allow",
        reason: "safe_read",
    });
});

test("requires approval for write and execute risks", () => {
    const policy = createPolicy();

    assert.deepEqual(policy.evaluate(writePermission), {
        kind: "approval_required",
        allowedResponses: ["allow-once", "allow-session", "deny"],
    });
    assert.equal(
        policy.evaluate({ action: "command-execute", risk: "execute" }).kind,
        "approval_required",
    );
});

test("a forbidden action is denied regardless of its risk", () => {
    const policy = createPolicy({ forbiddenActions: ["network-access"] });

    assert.deepEqual(
        policy.evaluate({ action: "network-access", risk: "read" }),
        {
            kind: "deny",
            code: "action_forbidden",
            message: "Action is forbidden by the task Spec: network-access",
        },
    );
});

test("denies a risky action when no allowing response is available", () => {
    const policy = createPolicy({ approvalResponses: ["deny"] });

    assert.deepEqual(policy.evaluate(writePermission), {
        kind: "deny",
        code: "approval_unavailable",
        message: "Action requires approval, but approval is unavailable: workspace-write",
    });
});

test("allow-once authorizes only the current decision", () => {
    const policy = createPolicy();

    assert.deepEqual(policy.resolve(writePermission, "allow-once"), {
        kind: "allow",
        reason: "allow_once",
    });
    assert.equal(policy.evaluate(writePermission).kind, "approval_required");
});

test("allow-session authorizes later uses of the same action", () => {
    const policy = createPolicy();

    assert.deepEqual(policy.resolve(writePermission, "allow-session"), {
        kind: "allow",
        reason: "allow_session",
    });
    assert.deepEqual(policy.evaluate(writePermission), {
        kind: "allow",
        reason: "allow_session",
    });
});

test("records an explicit denial without granting the action", () => {
    const policy = createPolicy();

    assert.deepEqual(policy.resolve(writePermission, "deny"), {
        kind: "deny",
        code: "denied_by_user",
        message: "Action was denied by the user: workspace-write",
    });
    assert.equal(policy.evaluate(writePermission).kind, "approval_required");
});

test("rejects an approval response excluded by the task Spec", () => {
    const policy = createPolicy({ approvalResponses: ["allow-once", "deny"] });

    assert.deepEqual(policy.resolve(writePermission, "allow-session"), {
        kind: "deny",
        code: "approval_response_invalid",
        message: "Approval response is not permitted by the task Spec: allow-session",
    });
});
