# CodeTau Tau Bridge Protocol v1

Protocol v1 is a bidirectional request/response protocol over UTF-8 JSON Lines.
Each line is exactly one object:

```json
{"version":1,"id":"run-1:turn:1","type":"agent_turn_result","payload":{}}
```

The envelope accepts exactly four fields. IDs are 1-128 characters and use
letters, digits, `.`, `_`, `:`, or `-`. Duplicate JSON fields, `NaN`, infinity,
unknown fields, wrong-direction messages, and messages larger than 1 MiB are
rejected. Stdout is reserved for protocol lines; diagnostics use stderr.

## Direction and correlation

| Host to bridge | Bridge to host | Correlation rule |
| --- | --- | --- |
| `handshake` | `handshake_result` | Same ID |
| `run_start` | `agent_init` | Bridge request ID is `<run-id>:init` |
| `agent_init_result` | `agent_turn` or `run_result` | Ack must reuse the `agent_init` ID |
| `agent_turn_result` | `agent_turn` or `run_result` | Response must reuse the pending turn ID |
| `shutdown` | `shutdown_result` | Same ID |

Errors use the triggering message ID when it was readable, otherwise the
reserved ID `protocol`. Recoverable errors leave the state unchanged so the
host can resend the expected message. Fatal errors terminate the process.

## State machine

```text
new --handshake--> ready
ready --run_start--> waiting_for_init
waiting_for_init --agent_init_result--> waiting_for_turn | ready
waiting_for_turn --agent_turn_result--> waiting_for_turn | ready
ready --shutdown--> closed
```

Only one run may be active. Protocol v1 currently accepts the locked `mock`
domain and `base` split. EOF before `shutdown_result` is a transport failure.

## Payloads

### `handshake`

```json
{"client":{"name":"codetau","version":"0.1.0"},"protocolVersion":1}
```

`handshake_result` returns the bridge identity and the locked upstream display
name, distribution, release, and full commit.

### `run_start`

```json
{"domain":"mock","taskSplit":"base","taskId":"task-1","trial":1,"seed":7}
```

`taskId` and `seed` may be null. `trial` starts at 1; a non-null seed is a
non-negative integer.

### `agent_init`

Contains `domainPolicy`, `tools`, and `messageHistory`. Every tool has `name`,
`description`, and JSON Schema-compatible `parameters`. The host acknowledges
initialization with an empty `agent_init_result` payload.

### `agent_turn`

Contains exactly one neutral input message:

- `{"kind":"user","content":"..."}`
- `{"kind":"tool","toolCallId":"...","name":"...","result":...}`
- `{"kind":"multi_tool","results":[...]}`

The matching `agent_turn_result` contains an assistant message with nullable
`content` and a `toolCalls` array. It must provide text, at least one tool call,
or both. Each tool call has `id`, `name`, and object-valued `arguments`.

### `run_result`

Contains a reward from 0 to 1, `completed` or `failed` status, and metadata:
locked upstream commit, protocol version, domain, task split, task ID, trial,
and seed. The bridge constructs this metadata rather than trusting the driver.

### `error`

Contains stable `code`, safe `message`, boolean `fatal`, and nullable object
`details`. Transport-level process exit remains authoritative for bridge death.
