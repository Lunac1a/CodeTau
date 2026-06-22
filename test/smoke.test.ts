import test from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "../src/spec.ts";

test("the SDD spec skeleton parses", () => {
  const spec = parseSpec(`---
id: smoke
title: Smoke task
goal: Verify the project skeleton
allowedPaths: ["."]
---
No implementation yet.
`);
  assert.equal(spec.id, "smoke");
  assert.equal(spec.budget.maxTurns, 30);
});
