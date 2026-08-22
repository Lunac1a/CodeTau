# CodeTau-Bench Mini

CodeTau-Bench Mini repeatedly runs real Agent Sessions against fresh copies of
small fixture workspaces. It never modifies the source fixture: every run gets
its own workspace under `.codetau/bench/`.

## Before running

1. Start LM Studio's local API server.
2. Make sure `qwen2.5-7b-instruct` is available.
3. Run commands from the repository root.

## Commands

One quick run of every task:

```powershell
pnpm bench -- --runs 1
```

Three repeated runs, which produces pass@1 through pass@3:

```powershell
pnpm bench -- --runs 3
```

Run only one task:

```powershell
pnpm bench -- --runs 3 --task fix-greeting
```

The default manifest currently contains `fix-greeting`, `clamp-score`, and
`normalize-email`. Therefore `--runs 3` without `--task` executes nine isolated
Sessions in total.

The default manifest is `packages/bench/manifest.json`. A different manifest or
configuration can be selected with `--manifest <path>` and `--config <path>`.

## What happens during a run

- The task's fixture workspace is copied into an isolated run directory.
- A normal Session Runner executes the Spec with the configured local model.
- Write and command approvals are automatically granted with `allow-session`,
  but only inside that isolated copy.
- A run passes only when the Agent reaches `completed`, which still requires
  current passing evidence for every Spec acceptance command.
- The Agent Loop completes immediately when all current validation evidence is
  present, so a solved run cannot spend another model turn editing the passing
  workspace or fail while trying to emit a separate completion call.

## Results

Each invocation prints the exact report path. Artifacts are stored at:

```text
.codetau/bench/<benchmark-id>/report.json
.codetau/bench/<benchmark-id>/bench.db
.codetau/bench/<benchmark-id>/runs/<task>/<run>/workspace/
```

The JSON report contains per-run status, duration, tool-call count, approval
count, validation-call count, success rate, and observed pass@k. Each run records
the materialized Spec digest; reports with different digests represent different
benchmark definitions and must not be compared as the same task. Runs also record
a `failureCategory` and diagnostics for tool errors, failed patches, and
failed validations. Repeated blocked tool calls are counted separately, while
`failureCategory` reflects the terminal cause such as a budget exhaustion. Task
and overall summaries aggregate these values so a low
pass@1 can be separated into model-turn exhaustion, repeated tool calls,
validation failures, provider errors, or blocked tasks. `pass@k` is the estimated
chance that at least one result passes when selecting `k` attempts from the
recorded runs.

Repeated runs use different Session IDs and isolated workspaces, but the initial
messages sent to the model are identical. This keeps the reliability comparison
focused on inference and Agent behavior rather than run-number prompt changes.

## Official tau adapter

The external tau integration is separate from CodeTau-Bench Mini. Its
TypeScript boundaries under `packages/bench/tau/` are:

- `protocol.ts` validates Python-to-TypeScript JSONL messages.
- `client.ts` owns the Python child process, line framing, correlation,
  timeouts, diagnostics, and exit handling.
- `adapter.ts` maps tau policies, messages, and dynamic tool definitions onto
  CodeTau's existing model-provider request/response types.
- `report.ts` records reproducibility metadata and unified run/task/overall
  metrics.
- `runner.ts` repeats selected tasks with stable seeds and isolated Python
  processes.
- `cli.ts` validates terminal-facing evaluation options.

Tau sessions deliberately disable the coding-only `finish_task` function. The
official tau environment owns task termination and reward; CodeTau returns only
assistant text or tau tool calls. The checked-in `--fake` Python driver provides
deterministic cross-process acceptance coverage. The pinned real driver executes
the official environment, tools, orchestrator, and ENV evaluator.

Run the bounded deterministic acceptance set twice per task:

```powershell
pnpm tau:run -- --task create_task_1 --task update_task_1 --runs 2 --seed 42
```

Run a selected `mock/base` task with the existing OpenAI-compatible LM Studio
provider:

```powershell
pnpm tau:run -- --model-mode lmstudio --task create_task_1 --runs 3
```

`CODETAU_MODEL`, `CODETAU_MODEL_BASE_URL`, and `CODETAU_MODEL_API_KEY` are
supported; `--model` and `--base-url` override the first two. Reports are stored
under `.codetau/tau/<benchmark-id>/report.json`. Each task summary includes
success rate and observed `pass@k`.

The deterministic acceptance mode is deliberately limited to pinned `mock/base`
and uses a scripted user. Those results validate CodeTau's provider integration
and official environment reward path, but are not official leaderboard
submissions and must not be compared with full user-simulator benchmark runs.

### Airline official-user slice

The first full-conversation slice permits one pinned `airline/base` task at a
time and requires the official user simulator plus `ALL` evaluation:

```powershell
pnpm tau:run -- --domain airline --model-mode lmstudio `
  --model qwen2.5-7b-instruct --user-mode official `
  --user-model openai/qwen2.5-7b-instruct `
  --user-base-url http://localhost:1234/v1 `
  --evaluation all --task 0 --runs 1 --seed 42
```

The Agent model is called through CodeTau's OpenAI-compatible provider. The
official Python `UserSimulator` is called through upstream LiteLLM. Both may use
the same LM Studio endpoint for local integration testing. Reports explicitly
record both model roles and endpoints. This proves the complete conversation and
official scoring path, but using the same local model for both roles is not an
official leaderboard configuration.
