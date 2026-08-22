# Official Tau bridge

This directory is the compatibility boundary between CodeTau and the official
Sierra Research tau benchmark. Phase 5.1 fixes the upstream selection and the
transport contract. Phase 5.2 implements and tests that transport without
installing or executing the benchmark.

## Pinned upstream

- Benchmark: tau3-bench 1.0.1 (the repository and Python distribution retain
  the `tau2` name)
- Repository: <https://github.com/sierra-research/tau2-bench>
- Tag: `v1.0.1`
- Commit: `fc0055dc4e0a316c3f83133267fbd6faaa770992`
- License: MIT
- Python: `>=3.12,<3.14`
- Install shape: a dedicated upstream checkout synchronized with `uv --frozen`

The full machine-readable selection is in `upstream-lock.json`. The commit is
authoritative; the tag is retained for humans. The benchmark uses an isolated
Python 3.12 environment even when CodeTau's root interpreter is compatible, so
the upstream dependency graph cannot pollute the core project environment. No
dependency is added to the root `pyproject.toml`.

## Initial evaluation scope

The first end-to-end slice is intentionally limited to text, half-duplex
evaluation, the official `base` task split, and the `mock` domain. Voice,
`banking_knowledge`, Gym/RL, leaderboard submission, and broad domain runs are
out of scope until the minimal integration is proven.

## JSONL protocol v1 boundary

The TypeScript adapter owns CodeTau sessions, model calls, event persistence,
and report collection. The Python process owns the pinned tau runtime, domain,
task, user simulator, orchestrator, and official reward calculation.

The TypeScript adapter starts the Python bridge and communicates over UTF-8
JSON Lines on stdin/stdout:

- Every line is one JSON object with exactly `version`, `id`, `type`, and
  `payload` fields. `version` is `1`; `id` correlates a request and response.
- Stdout is protocol-only. Human diagnostics and upstream logs go to stderr.
- TypeScript sends `handshake`, `run_start`, `agent_init_result`,
  `agent_turn_result`, and `shutdown` messages.
- Python sends `handshake_result`, `agent_init`, `agent_turn`, `run_result`,
  `error`, and `shutdown_result` messages.
- `agent_init` carries the official domain policy, tool descriptions/schemas,
  and initial message history.
- `agent_turn` carries one official half-duplex input (`UserMessage`,
  `ToolMessage`, or `MultiToolMessage`). Its matching `agent_turn_result`
  carries CodeTau's assistant text and/or tool calls in an upstream-neutral
  representation.
- `run_result` carries the official reward/result plus reproducibility metadata.
- `error` is structured and includes a stable CodeTau-owned error code; a fatal
  error terminates the current run, while process exit remains the final
  transport-level failure signal.

The complete field-level contract and state transitions are documented in
[`PROTOCOL.md`](PROTOCOL.md). Phase 5.3 will add the TypeScript adapter; the
real pinned tau driver remains reserved for the later end-to-end slice.

## Reproducibility rules

Comparable reports must record the upstream commit, Python version, uv lock
digest, domain, task split, task id, trial/seed settings, CodeTau version,
provider/model settings, and protocol version. A tag-only or `main` checkout is
not accepted as reproducible input.

## Official sources reviewed for 5.1

- [v1.0.1 release](https://github.com/sierra-research/tau2-bench/releases/tag/v1.0.1)
- [Pinned Python metadata](https://github.com/sierra-research/tau2-bench/blob/v1.0.1/pyproject.toml)
- [MIT license](https://github.com/sierra-research/tau2-bench/blob/v1.0.1/LICENSE)
- [Official agent developer guide](https://github.com/sierra-research/tau2-bench/blob/v1.0.1/src/tau2/agent/README.md)

