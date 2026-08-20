import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SpecLoadError } from "../src/spec/errors.ts";
import { loadSpec, parseSpecText } from "../src/spec/loader.ts";

const validSpec = `---
version: 1
id: test.valid-spec
goal: Verify the loader.
workspace:
  root: fixtures/example
  allowedPaths: [src/**]
policy:
  forbiddenActions: [network-access]
acceptance:
  commands:
    - executable: pnpm
      args: [test]
  assertions: [All tests pass.]
phases:
  - id: validate
    description: Run the declared checks.
budget:
  maxModelTurns: 5
  maxToolCalls: 10
  maxRetries: 1
userInteraction:
  allowQuestions: false
  approvalResponses: [allow-once, allow-session, deny]
---

# Context

Keep this text intact.
`;

function expectSpecError(
    code: SpecLoadError["code"],
    check?: (error: SpecLoadError) => void,
): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.ok(error instanceof SpecLoadError);
        assert.equal(error.code, code);
        check?.(error);
        return true;
    };
}

test("loads the repository example as contract plus context", async () => {
    const specUrl = new URL("../specs/example.md", import.meta.url);
    const spec = await loadSpec(fileURLToPath(specUrl));

    assert.equal(spec.contract.id, "example.fix-greeting");
    assert.equal(spec.contract.budget.maxToolCalls, 40);
    assert.match(spec.digest, /^[a-f0-9]{64}$/);
    assert.match(spec.context, /^\r?\n?# Context/);
    assert.match(spec.context, /existing function signature/);
});

test("preserves Markdown context separately from the contract", async () => {
    const spec = await parseSpecText(validSpec);

    assert.equal(spec.contract.goal, "Verify the loader.");
    assert.equal(spec.context, "\n# Context\n\nKeep this text intact.\n");
});

test("rejects a document without frontmatter", async () => {
    await assert.rejects(
        parseSpecText("# Context\n\nNo contract."),
        expectSpecError("spec_frontmatter_missing"),
    );
});

test("rejects duplicate YAML keys", async () => {
    const duplicateKeySpec = validSpec.replace(
        "version: 1",
        "version: 1\nversion: 1",
    );

    await assert.rejects(
        parseSpecText(duplicateKeySpec),
        expectSpecError("spec_yaml_invalid"),
    );
});

test("reports the path of a schema type error", async () => {
    const invalidBudgetSpec = validSpec.replace(
        "maxModelTurns: 5",
        "maxModelTurns: many",
    );

    await assert.rejects(
        parseSpecText(invalidBudgetSpec),
        expectSpecError("spec_schema_invalid", (error) => {
            assert.ok(
                error.issues.some(
                    (issue) =>
                        issue.path === "/budget/maxModelTurns" &&
                        issue.keyword === "type",
                ),
            );
        }),
    );
});

test("reports the path of a missing required field", async () => {
    const missingGoalSpec = validSpec.replace("goal: Verify the loader.\n", "");

    await assert.rejects(
        parseSpecText(missingGoalSpec),
        expectSpecError("spec_schema_invalid", (error) => {
            assert.ok(
                error.issues.some(
                    (issue) =>
                        issue.path === "/goal" && issue.keyword === "required",
                ),
            );
        }),
    );
});

test("rejects unknown contract fields", async () => {
    const unknownFieldSpec = validSpec.replace(
        "goal: Verify the loader.",
        "goal: Verify the loader.\nsurprise: true",
    );

    await assert.rejects(
        parseSpecText(unknownFieldSpec),
        expectSpecError("spec_schema_invalid", (error) => {
            assert.ok(error.issues.some((issue) => issue.path === "/surprise"));
        }),
    );
});

test("wraps file-system failures in a stable error", async () => {
    await assert.rejects(
        loadSpec("specs/does-not-exist.md"),
        expectSpecError("spec_read_failed"),
    );
});
