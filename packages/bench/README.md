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

Run only the included greeting task:

```powershell
pnpm bench -- --runs 3 --task fix-greeting
```

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
count, validation-call count, success rate, and observed pass@k. Each run also
records a `failureCategory` and diagnostics for tool errors, failed patches, and
failed validations. Task and overall summaries aggregate these values so a low
pass@1 can be separated into model-turn exhaustion, repeated tool calls,
validation failures, provider errors, or blocked tasks. `pass@k` is the estimated
chance that at least one result passes when selecting `k` attempts from the
recorded runs.

Repeated runs use different Session IDs and isolated workspaces, but the initial
messages sent to the model are identical. This keeps the reliability comparison
focused on inference and Agent behavior rather than run-number prompt changes.
