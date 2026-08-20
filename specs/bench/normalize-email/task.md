---
version: 1
id: bench.normalize-email
goal: Normalize email input by trimming surrounding whitespace and converting it to lowercase.
workspace:
  root: fixtures/bench/normalize-email
  allowedPaths:
    - src/**
policy:
  forbiddenActions:
    - network-access
    - workspace-outside-write
acceptance:
  commands:
    - executable: node
      args: [--experimental-strip-types, --test, test/normalize-email.test.ts]
  assertions:
    - Surrounding whitespace is removed.
    - Uppercase letters are converted to lowercase.
    - Already-normalized input is unchanged.
    - Only src/normalize-email.ts may change.
phases:
  - id: diagnose
    description: Compare the current transformation with the required normalization steps.
  - id: fix
    description: Add the missing normalization step and validate it.
budget:
  maxModelTurns: 12
  maxToolCalls: 40
  maxRetries: 3
userInteraction:
  allowQuestions: false
  approvalResponses: [allow-once, allow-session, deny]
---

# Context

`normalizeEmail` must first remove surrounding whitespace and then lowercase the
remaining address. Preserve the exported function signature and do not modify
tests.

