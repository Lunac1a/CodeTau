# CLI application

Terminal UI and commands live here. It should depend on public packages rather
than containing agent-loop behavior.

## Current command

Inspect a persisted session in `.codetau/codetau.db`:

```powershell
pnpm cli -- status <session-id>
```

The command prints the task status and returns exit code `1` when the session
does not exist or the command arguments are invalid.
