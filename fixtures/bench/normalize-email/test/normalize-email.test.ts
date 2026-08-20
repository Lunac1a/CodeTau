import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEmail } from "../src/normalize-email.ts";

test("trims and lowercases email input", () => {
    assert.equal(normalizeEmail("  Ada@Example.COM  "), "ada@example.com");
    assert.equal(normalizeEmail("already@example.com"), "already@example.com");
});

