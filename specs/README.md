# Specs

Machine-readable Markdown task specs, JSON Schemas, architecture decisions, and
acceptance criteria belong here.

- `schema.json` is the versioned execution contract for YAML frontmatter.
- `bench/<task-id>/task.md` stores one self-contained Mini Bench task per
  directory; see `bench/README.md` for its mirrored fixture convention.

The Markdown body can help the model understand a task, but only validated
frontmatter may control scope, policy, budgets, and acceptance commands.
