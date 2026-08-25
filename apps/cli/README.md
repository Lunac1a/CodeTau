# CLI application

Terminal UI and commands live here. It should depend on public packages rather
than containing agent-loop behavior.

## Commands

Start the persistent conversational terminal:

```powershell
pnpm cli
```

Enter a message to run it. Use `:multi`, then `:send`, for multiline input and
`:exit` to leave. The header prints the Conversation ID; reopen the same
conversation later with:

```powershell
pnpm cli -- chat --conversation <conversation-id>
```

The project boundary and validation commands are confirmed once per new
conversation. Each user message creates a separate Agent Session with its own
approvals, event history, file changes, and current validation evidence. Earlier
completed turns are supplied as context to later turns, while the workspace is
re-inspected on every turn.

Pass a task directly when scripting. `--validate` may be repeated and `--yes`
accepts the displayed preflight defaults without a prompt:

```powershell
pnpm cli -- ask "Fix the registration bug" --validate "pnpm run test" --yes
```

One-shot tasks show the workspace boundary and validation commands before
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
without writing a task file into the workspace. Conversations and their turn-to-
Session mapping are persisted in the same SQLite database without changing the
event stream format.
