# CLI application

Terminal UI and commands live here. It should depend on public packages rather
than containing agent-loop behavior.

## Commands

Start an interactive natural-language task. Enter `:run` on its own line after
the task description, or `:cancel` to exit:

```powershell
pnpm cli
```

Pass a task directly when scripting. `--validate` may be repeated and `--yes`
accepts the displayed preflight defaults without a prompt:

```powershell
pnpm cli -- ask "Fix the registration bug" --validate "pnpm run test" --yes
```

Interactive tasks show the workspace boundary and validation commands before
execution, handle tool approvals in the same terminal, and finish with changed
files, current validation evidence, usage, and the persisted Session ID. A
non-interactive task pauses with exit code 2 if approval is required.

Start a Session from a Spec. Omit `--session` to generate an ID:

```powershell
pnpm cli -- run specs/bench/fix-greeting/task.md --session example-run
```

If a write or validation command requires approval, continue the same Session:

```powershell
pnpm cli -- resume example-run --approval allow-once
```

Inspect a persisted Session:

```powershell
pnpm cli -- status example-run
```

The CLI loads `codetau.config.json` from the current directory. `run` assembles
the configured Model Provider, SQLite EventStore, workspace sandbox, tools,
permission policy, and Agent Loop through the Session Runner. `resume` reloads
the original Spec path recorded by the Session. Natural-language Sessions keep
their generated, validated Spec snapshot in the event stream so they can resume
without writing a task file into the workspace.
