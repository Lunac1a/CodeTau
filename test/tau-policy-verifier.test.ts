import assert from "node:assert/strict";
import test from "node:test";

import { ModelTauPolicyVerifier } from "../packages/bench/tau/policy-verifier.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";

const policy = [
    "Refunds require a cancelled flight.",
    "Certificates may be issued only after a confirmed cancellation.",
].join("\n");

const request = {
    domainPolicy: policy,
    conversation: [
        { role: "user", content: "Please send a certificate." },
        {
            role: "tool",
            toolCallId: "read-1",
            content: '{"flightStatus":"cancelled"}',
        },
    ],
    proposedCalls: [
        {
            id: "write-1",
            name: "issue_certificate",
            arguments: { amount: 100 },
        },
    ],
} as const;

test("allows a structured verdict with an exact official policy quote", async () => {
    const model = new FakeModelProvider([{
        kind: "tool_calls",
        calls: [{
            id: "verdict-1",
            name: "submit_policy_verdict",
            input: {
                decision: "allow",
                reason: "The observed flight is cancelled.",
                policyQuote: "Certificates may be issued only after a confirmed cancellation.",
            },
        }],
        usage: { inputTokens: 20, outputTokens: 5 },
    }]);

    const result = await new ModelTauPolicyVerifier(model).verify(request);

    assert.equal(result.verdict.decision, "allow");
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 5 });
    assert.equal(model.requests[0]?.availableTools[0]?.name, "submit_policy_verdict");
    assert.match(
        model.requests[0]?.messages[0]?.content ?? "",
        /rule that defines valid values or conditions can support a compliant action/u,
    );
});

test("fails closed when an allow verdict paraphrases the policy", async () => {
    const model = new FakeModelProvider([{
        kind: "tool_calls",
        calls: [{
            id: "verdict-1",
            name: "submit_policy_verdict",
            input: {
                decision: "allow",
                reason: "It seems eligible.",
                policyQuote: "Certificates are allowed for cancelled flights.",
            },
        }],
        usage: { inputTokens: 20, outputTokens: 5 },
    }]);

    const result = await new ModelTauPolicyVerifier(model).verify(request);

    assert.equal(result.verdict.decision, "deny");
    assert.match(result.verdict.reason, /exact official policy quote/u);
    assert.equal(
        result.verdict.policyQuote,
        "Certificates are allowed for cancelled flights.",
    );
});

test("resolves a quote that omits only an official Markdown list prefix", async () => {
    const model = new FakeModelProvider([{
        kind: "tool_calls",
        calls: [{
            id: "verdict-1",
            name: "submit_policy_verdict",
            input: {
                decision: "allow",
                reason: "Completed is a valid status.",
                policyQuote: 'Task status can only be "pending" or "completed".',
            },
        }],
        usage: { inputTokens: 12, outputTokens: 4 },
    }]);
    const verifier = new ModelTauPolicyVerifier(model);

    const result = await verifier.verify({
        domainPolicy: '1. Each task needs a title\n2. Task status can only be "pending" or "completed"',
        conversation: request.conversation,
        proposedCalls: [{
            id: "write-1",
            name: "update_task_status",
            arguments: { task_id: "task_1", status: "completed" },
        }],
    });

    assert.equal(result.verdict.decision, "allow");
    assert.equal(
        result.verdict.policyQuote,
        '2. Task status can only be "pending" or "completed"',
    );
});

test("fails closed when the verifier does not use the verdict tool", async () => {
    const model = new FakeModelProvider([{
        kind: "text",
        text: "allow",
        usage: { inputTokens: 10, outputTokens: 1 },
    }]);

    const result = await new ModelTauPolicyVerifier(model).verify(request);

    assert.equal(result.verdict.decision, "deny");
    assert.match(result.verdict.reason, /structured policy verdict/u);
});
