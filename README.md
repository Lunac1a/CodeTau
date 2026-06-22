# CodeTau Agent

A learning-oriented terminal-first coding agent project. Its purpose is to make
the agent loop observable and testable: tool calls, permissions, human approval,
session recovery, structured task state, event logs, patch editing, validation
feedback, and repeated-run reliability.

## Development environment

The supported baseline is Node.js 22+, pnpm 11+, Python 3.11+, and Git. In the
Codex desktop workspace, bundled runtimes are available without a global install.
Open PowerShell in this directory and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
. .\scripts\dev.ps1
pnpm install
python -m venv .venv
```

The execution-policy change applies only to the current PowerShell process and
does not modify the machine or user policy.

The activation script prefers normal system installations and falls back to the
Codex desktop runtime. `.nvmrc`, `.python-version`, `packageManager`, and
`pyproject.toml` document the portable version requirements for other machines.

## Project layout

```text
apps/cli/              terminal UI and command routing
packages/core/         provider/tool contracts, loop, task state
packages/workspace/    sandbox, tools, patches, state digest
packages/persistence/  SQLite event store and replay
packages/bench/        CodeTau-Bench Mini runner and metrics
python/tau_bridge/     official tau-bench integration boundary
specs/                 SDD specs, schemas, and decisions
src/                   initial executable core skeleton
test/                  TypeScript unit and integration tests
```

## Build order

1. Freeze the event model and task-state transitions in `packages/core`.
2. Add persistence and replay before connecting a real model.
3. Add sandboxed tools, permission checks, and structured patches.
4. Add the CLI, then CodeTau-Bench Mini.
5. Pin and integrate an official Tau benchmark version through the Python bridge.

No API key is needed for the current skeleton.
