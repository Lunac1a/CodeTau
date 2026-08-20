import assert from "node:assert/strict";
import test from "node:test";

import { greet } from "../src/greet.ts";

test("greets a named user with an exclamation mark", () => {
    assert.equal(greet("Ada"), "Hello, Ada!");
});

test("preserves the empty-name greeting", () => {
    assert.equal(greet(""), "Hello!");
    assert.equal(greet("   "), "Hello!");
});

