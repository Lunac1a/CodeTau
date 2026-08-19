import assert from "node:assert/strict";
import test from "node:test";

import { computeSpecDigest, createSpecSnapshot } from "../src/spec/digest.ts";
import { createTestSpec } from "./fixtures/spec.ts";

test("Spec digest is stable when object key insertion order changes", () => {
    const spec = createTestSpec();
    const reorderedContract = {
        userInteraction: spec.contract.userInteraction,
        budget: spec.contract.budget,
        phases: spec.contract.phases,
        acceptance: spec.contract.acceptance,
        policy: spec.contract.policy,
        workspace: spec.contract.workspace,
        goal: spec.contract.goal,
        id: spec.contract.id,
        version: spec.contract.version,
    };

    assert.equal(
        computeSpecDigest(createSpecSnapshot(spec.contract, spec.context)),
        computeSpecDigest(createSpecSnapshot(reorderedContract, spec.context)),
    );
});

test("Spec digest changes when executable content changes", () => {
    const spec = createTestSpec();

    assert.notEqual(
        spec.digest,
        computeSpecDigest(
            createSpecSnapshot(spec.contract, `${spec.context}\nAdditional instruction.`),
        ),
    );
    assert.match(spec.digest, /^[a-f0-9]{64}$/);
});
