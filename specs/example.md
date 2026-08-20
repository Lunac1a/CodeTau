---
version: 1
id: example.fix-greeting
goal: Fix the greeting without changing public APIs.
workspace:
  root: fixtures/greeting
  allowedPaths:
    - src/**
    - test/**
policy:
  forbiddenActions:
    - network-access
    - workspace-outside-write
acceptance:
  commands:
    - executable: node
      args: [--experimental-strip-types, --test, test/greet.test.ts]
  assertions:
    - All tests pass.
    - No files outside allowedPaths change.
phases:
  - id: diagnose
    description: Locate the failing behavior without modifying files.
  - id: fix
    description: Apply the smallest in-scope patch and validate it.
budget:
  maxModelTurns: 12
  maxToolCalls: 40
  maxRetries: 3
userInteraction:
  allowQuestions: true
  approvalResponses: [allow-once, allow-session, deny]
---

# Context

The `greet` function returns the wrong punctuation for named users. Preserve its
existing signature and behavior for empty input.
