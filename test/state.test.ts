import assert from "node:assert/strict";
import test from "node:test";

import {
    assertTransition,
    canTransition,
    InvalidTaskTransitionError,
} from "../src/state.ts";

test("allows the normal edit and validation path", () => {
    assert.equal(canTransition("created", "analyzing"), true);
    assert.equal(canTransition("analyzing", "editing"), true);
    assert.equal(canTransition("editing", "validating"), true);
    assert.equal(canTransition("validating", "completed"), true);
});

test("rejects transitions out of a terminal state", () => {
    assert.equal(canTransition("completed", "editing"), false);

    assert.throws(
        () => assertTransition("completed", "editing"),
        (error: unknown) => {
            assert.ok(error instanceof InvalidTaskTransitionError);
            assert.equal(error.code, "invalid_task_transition");
            assert.equal(error.from, "completed");
            assert.equal(error.to, "editing");
            return true;
        },
    );
});
