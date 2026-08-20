---
version: 1
id: example.fix-greeting
goal: Make named-user greetings end with an exclamation mark without changing the public API.
workspace:
  root: fixtures/greeting
  allowedPaths:
    - src/**
policy:
  forbiddenActions:
    - network-access
    - workspace-outside-write
acceptance:
  commands:
    - executable: node
      args: [--experimental-strip-types, --test, test/greet.test.ts]
  assertions:
    - greet("Ada") returns "Hello, Ada!".
    - greet("") still returns "Hello!".
    - Only src/greet.ts may change.
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
  allowQuestions: false
  approvalResponses: [allow-once, allow-session, deny]
---

# Context

For every non-empty name, `greet` must return `Hello, <name>!`. Change the current
trailing period to an exclamation mark. Preserve the existing function signature
and the `Hello!` result for empty or whitespace-only input. Do not modify tests.
