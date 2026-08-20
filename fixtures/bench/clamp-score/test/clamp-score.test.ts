import assert from "node:assert/strict";
import test from "node:test";

import { clampScore } from "../src/clamp-score.ts";

test("clamps scores to the inclusive 0 through 100 range", () => {
    assert.equal(clampScore(-5), 0);
    assert.equal(clampScore(0), 0);
    assert.equal(clampScore(42), 42);
    assert.equal(clampScore(100), 100);
    assert.equal(clampScore(140), 100);
});

