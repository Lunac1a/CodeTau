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
src/                   your learning implementation starts here
test/                  TypeScript unit and integration tests
```

## Build order

1. Freeze the event model and task-state transitions in `packages/core`.
2. Add persistence and replay before connecting a real model.
3. Add sandboxed tools, permission checks, and structured patches.
4. Add the CLI, then CodeTau-Bench Mini.
5. Pin and integrate an official Tau benchmark version through the Python bridge.

## Current implementation status

Phases 1 through 3 are complete in `src/`: the Spec contract, task-state
machine, model-independent Agent loop, immutable events, SQLite recovery,
TaskState snapshots, JSONL audit/replay, sandboxed workspace reads, durable
approvals, structured patches, and the bounded validation feedback loop are
implemented and tested. A task can reach `completed` only after every Spec
acceptance command has current passing evidence. Phase 4 currently includes an
OpenAI-compatible Model Provider configured for local LM Studio, a Session
Runner that assembles the runtime dependencies, CLI `run`, `resume`, and
`status` commands, and CodeTau-Bench Mini with isolated repeated runs and
pass@k reporting. Phase 4.1 reliability hardening keeps repeated Bench prompts
identical, grounds the model with the complete acceptance contract, adds
tool-error recovery guidance, stops identical failed-call loops, and reports
structured failure categories.

## Local model

Start LM Studio's local API server and load `qwen2.5-7b-instruct`. The checked-in
configuration uses:

```text
Base URL: http://localhost:1234/v1
Model:    qwen2.5-7b-instruct
```

The provider sends registered Agent tools as OpenAI-compatible function tools
and adds a reserved `finish_task` function for terminal outcomes. No API key is
required for the default local server configuration.

Verify the real local-model connection, including one complete tool round trip:

```powershell
pnpm model:smoke
```

Start and inspect a persisted Agent Session:

```powershell
pnpm cli -- run specs/example.md --session example-run
pnpm cli -- status example-run
pnpm cli -- resume example-run --approval allow-once
```

Run the local mini benchmark when LM Studio is ready:

```powershell
pnpm bench -- --runs 3
```
