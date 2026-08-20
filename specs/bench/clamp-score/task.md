---
version: 1
id: bench.clamp-score
goal: Clamp scores to the inclusive range from 0 through 100.
workspace:
  root: fixtures/bench/clamp-score
  allowedPaths:
    - src/**
policy:
  forbiddenActions:
    - network-access
    - workspace-outside-write
acceptance:
  commands:
    - executable: node
      args: [--experimental-strip-types, --test, test/clamp-score.test.ts]
  assertions:
    - Scores below 0 return 0.
    - Scores from 0 through 100 are unchanged.
    - Scores above 100 return 100.
    - Only src/clamp-score.ts may change.
phases:
  - id: diagnose
    description: Inspect the numeric bounds in the implementation.
  - id: fix
    description: Correct the upper bound with the smallest source change and validate it.
budget:
  maxModelTurns: 12
  maxToolCalls: 40
  maxRetries: 3
userInteraction:
  allowQuestions: false
  approvalResponses: [allow-once, allow-session, deny]
---

# Context

`clampScore` must preserve any value in the inclusive range `0..100`, return `0`
for lower values, and return `100` for higher values. Its current upper bound is
incorrect. Preserve the function name and parameter and do not modify tests.

