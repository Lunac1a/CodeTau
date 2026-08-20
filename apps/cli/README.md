# CLI application

Terminal UI and commands live here. It should depend on public packages rather
than containing agent-loop behavior.

## Commands

Start a Session from a Spec. Omit `--session` to generate an ID:

```powershell
pnpm cli -- run specs/example.md --session example-run
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
the original Spec path recorded by the Session.
