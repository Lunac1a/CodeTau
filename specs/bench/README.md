# Bench task specs

Each CodeTau-Bench Mini task owns one directory named after its manifest ID:

```text
specs/bench/<task-id>/task.md
fixtures/bench/<task-id>/src/
fixtures/bench/<task-id>/test/
```

`task.md` must state the expected behavior without requiring a reader to infer
the requirement from tests. Its writable `allowedPaths` should normally include
only implementation files. Acceptance tests remain present in the fixture for
the validation command but are not writable Agent inputs.

