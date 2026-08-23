"""Strict JSONL protocol primitives shared by the tau bridge and its host."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Callable, Literal

PROTOCOL_VERSION = 3
MAX_LINE_LENGTH = 1_048_576

Direction = Literal["host-to-bridge", "bridge-to-host"]
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class ProtocolViolation(ValueError):
    """A stable, user-safe protocol validation failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Envelope:
    version: int
    id: str
    type: str
    payload: dict[str, Any]


def _reject_constant(value: str) -> None:
    raise ProtocolViolation("invalid_json", f"non-finite JSON number: {value}")


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolViolation("invalid_json", f"duplicate JSON field: {key}")
        result[key] = value
    return result


def _object(value: Any, name: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        expected = ", ".join(sorted(keys)) or "no fields"
        raise ProtocolViolation(
            "invalid_payload", f"{name} must contain exactly: {expected}"
        )
    return value


def _text(value: Any, name: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value:
        suffix = " or null" if nullable else ""
        raise ProtocolViolation(
            "invalid_payload", f"{name} must be a non-empty string{suffix}"
        )
    return value


def _integer(value: Any, name: str, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ProtocolViolation(
            "invalid_payload", f"{name} must be an integer >= {minimum}"
        )
    return value


def _nullable_integer(value: Any, name: str) -> int | None:
    if value is None:
        return None
    return _integer(value, name)


def _boolean(value: Any, name: str) -> bool:
    if type(value) is not bool:
        raise ProtocolViolation("invalid_payload", f"{name} must be a boolean")
    return value


def _json_value(value: Any, name: str) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if type(value) is int:
        return value
    if type(value) is float and math.isfinite(value):
        return value
    if isinstance(value, list):
        return [_json_value(item, f"{name}[]") for item in value]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: _json_value(item, f"{name}.{key}") for key, item in value.items()}
    raise ProtocolViolation("invalid_payload", f"{name} must be JSON-compatible")


def _tool_call(value: Any, name: str) -> dict[str, Any]:
    item = _object(value, name, {"id", "name", "arguments"})
    return {
        "id": _text(item["id"], f"{name}.id"),
        "name": _text(item["name"], f"{name}.name"),
        "arguments": _object_or_json(item["arguments"], f"{name}.arguments"),
    }


def _object_or_json(value: Any, name: str) -> dict[str, Any]:
    checked = _json_value(value, name)
    if not isinstance(checked, dict):
        raise ProtocolViolation("invalid_payload", f"{name} must be an object")
    return checked


def _assistant_message(value: Any, name: str) -> dict[str, Any]:
    item = _object(value, name, {"role", "content", "toolCalls"})
    if item["role"] != "assistant":
        raise ProtocolViolation("invalid_payload", f"{name}.role must be assistant")
    content = _text(item["content"], f"{name}.content", nullable=True)
    calls = item["toolCalls"]
    if not isinstance(calls, list):
        raise ProtocolViolation("invalid_payload", f"{name}.toolCalls must be an array")
    tool_calls = [_tool_call(call, f"{name}.toolCalls[{index}]") for index, call in enumerate(calls)]
    if content is None and not tool_calls:
        raise ProtocolViolation(
            "invalid_payload", f"{name} must contain text or at least one tool call"
        )
    return {"role": "assistant", "content": content, "toolCalls": tool_calls}


def _tool_result(value: Any, name: str) -> dict[str, Any]:
    item = _object(value, name, {"toolCallId", "name", "result"})
    return {
        "toolCallId": _text(item["toolCallId"], f"{name}.toolCallId"),
        "name": _text(item["name"], f"{name}.name"),
        "result": _json_value(item["result"], f"{name}.result"),
    }


def _input_message(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolViolation("invalid_payload", f"{name} must be an object")
    kind = value.get("kind")
    if kind == "user":
        item = _object(value, name, {"kind", "content"})
        return {"kind": "user", "content": _text(item["content"], f"{name}.content")}
    if kind == "tool":
        item = _object(value, name, {"kind", "toolCallId", "name", "result"})
        result = _tool_result(
            {
                "toolCallId": item["toolCallId"],
                "name": item["name"],
                "result": item["result"],
            },
            name,
        )
        return {"kind": "tool", **result}
    if kind == "multi_tool":
        item = _object(value, name, {"kind", "results"})
        results = item["results"]
        if not isinstance(results, list) or not results:
            raise ProtocolViolation(
                "invalid_payload", f"{name}.results must be a non-empty array"
            )
        return {
            "kind": "multi_tool",
            "results": [
                _tool_result(result, f"{name}.results[{index}]")
                for index, result in enumerate(results)
            ],
        }
    raise ProtocolViolation(
        "invalid_payload", f"{name}.kind must be user, tool, or multi_tool"
    )


def _history_message(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolViolation("invalid_payload", f"{name} must be an object")
    role = value.get("role")
    if role in {"system", "user"}:
        item = _object(value, name, {"role", "content"})
        return {"role": role, "content": _text(item["content"], f"{name}.content")}
    if role == "assistant":
        return _assistant_message(value, name)
    if role == "tool":
        item = _object(value, name, {"role", "toolCallId", "name", "result"})
        result = _tool_result(
            {
                "toolCallId": item["toolCallId"],
                "name": item["name"],
                "result": item["result"],
            },
            name,
        )
        return {"role": "tool", **result}
    raise ProtocolViolation(
        "invalid_payload", f"{name}.role must be system, user, assistant, or tool"
    )


def _tool_definition(value: Any, name: str) -> dict[str, Any]:
    item = _object(
        value,
        name,
        {"name", "description", "parameters", "toolType", "mutatesState"},
    )
    if item["toolType"] not in {"read", "write", "think", "generic"}:
        raise ProtocolViolation(
            "invalid_payload", f"{name}.toolType must be a supported tau tool type"
        )
    return {
        "name": _text(item["name"], f"{name}.name"),
        "description": _text(item["description"], f"{name}.description"),
        "parameters": _object_or_json(item["parameters"], f"{name}.parameters"),
        "toolType": item["toolType"],
        "mutatesState": _boolean(item["mutatesState"], f"{name}.mutatesState"),
    }


def _handshake(value: Any) -> dict[str, Any]:
    item = _object(value, "handshake payload", {"client", "protocolVersion"})
    client = _object(item["client"], "handshake client", {"name", "version"})
    return {
        "client": {
            "name": _text(client["name"], "handshake client.name"),
            "version": _text(client["version"], "handshake client.version"),
        },
        "protocolVersion": _integer(
            item["protocolVersion"], "handshake protocolVersion", minimum=1
        ),
    }


def _handshake_result(value: Any) -> dict[str, Any]:
    item = _object(
        value, "handshake_result payload", {"server", "protocolVersion", "upstream"}
    )
    server = _object(item["server"], "handshake_result server", {"name", "version"})
    upstream = _object(
        item["upstream"],
        "handshake_result upstream",
        {"displayName", "distribution", "release", "commit"},
    )
    return {
        "server": {
            "name": _text(server["name"], "handshake_result server.name"),
            "version": _text(server["version"], "handshake_result server.version"),
        },
        "protocolVersion": _integer(
            item["protocolVersion"], "handshake_result protocolVersion", minimum=1
        ),
        "upstream": {
            key: _text(upstream[key], f"handshake_result upstream.{key}")
            for key in ("displayName", "distribution", "release", "commit")
        },
    }


def _run_start(value: Any) -> dict[str, Any]:
    item = _object(
        value, "run_start payload", {"domain", "taskSplit", "taskId", "trial", "seed"}
    )
    return {
        "domain": _text(item["domain"], "run_start domain"),
        "taskSplit": _text(item["taskSplit"], "run_start taskSplit"),
        "taskId": _text(item["taskId"], "run_start taskId", nullable=True),
        "trial": _integer(item["trial"], "run_start trial", minimum=1),
        "seed": _nullable_integer(item["seed"], "run_start seed"),
    }


def _agent_init(value: Any) -> dict[str, Any]:
    item = _object(
        value, "agent_init payload", {"domainPolicy", "tools", "messageHistory"}
    )
    tools = item["tools"]
    history = item["messageHistory"]
    if not isinstance(tools, list):
        raise ProtocolViolation("invalid_payload", "agent_init tools must be an array")
    if not isinstance(history, list):
        raise ProtocolViolation(
            "invalid_payload", "agent_init messageHistory must be an array"
        )
    return {
        "domainPolicy": _text(item["domainPolicy"], "agent_init domainPolicy"),
        "tools": [_tool_definition(tool, f"agent_init tools[{index}]") for index, tool in enumerate(tools)],
        "messageHistory": [
            _history_message(message, f"agent_init messageHistory[{index}]")
            for index, message in enumerate(history)
        ],
    }


def _empty(value: Any, name: str) -> dict[str, Any]:
    return _object(value, f"{name} payload", set())


def _agent_turn(value: Any) -> dict[str, Any]:
    item = _object(value, "agent_turn payload", {"message"})
    return {"message": _input_message(item["message"], "agent_turn message")}


def _agent_turn_result(value: Any) -> dict[str, Any]:
    item = _object(value, "agent_turn_result payload", {"message"})
    return {"message": _assistant_message(item["message"], "agent_turn_result message")}


def _metadata(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        "run_result metadata",
        {
            "upstreamCommit",
            "protocolVersion",
            "domain",
            "taskSplit",
            "taskId",
            "trial",
            "seed",
        },
    )
    return {
        "upstreamCommit": _text(item["upstreamCommit"], "metadata upstreamCommit"),
        "protocolVersion": _integer(
            item["protocolVersion"], "metadata protocolVersion", minimum=1
        ),
        "domain": _text(item["domain"], "metadata domain"),
        "taskSplit": _text(item["taskSplit"], "metadata taskSplit"),
        "taskId": _text(item["taskId"], "metadata taskId", nullable=True),
        "trial": _integer(item["trial"], "metadata trial", minimum=1),
        "seed": _nullable_integer(item["seed"], "metadata seed"),
    }


def _run_result(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        "run_result payload",
        {"reward", "status", "metadata", "diagnostics"},
    )
    reward = item["reward"]
    if type(reward) not in {int, float} or not math.isfinite(reward) or not 0 <= reward <= 1:
        raise ProtocolViolation(
            "invalid_payload", "run_result reward must be a finite number from 0 to 1"
        )
    if item["status"] not in {"completed", "failed"}:
        raise ProtocolViolation(
            "invalid_payload", "run_result status must be completed or failed"
        )
    diagnostics = _object(
        item["diagnostics"],
        "run_result diagnostics",
        {"terminationReason", "rewardInfo"},
    )
    return {
        "reward": reward,
        "status": item["status"],
        "metadata": _metadata(item["metadata"]),
        "diagnostics": {
            "terminationReason": _text(
                diagnostics["terminationReason"],
                "run_result diagnostics terminationReason",
            ),
            "rewardInfo": _object_or_json(
                diagnostics["rewardInfo"],
                "run_result diagnostics rewardInfo",
            ),
        },
    }


def _error(value: Any) -> dict[str, Any]:
    item = _object(value, "error payload", {"code", "message", "fatal", "details"})
    details = item["details"]
    if details is not None:
        details = _object_or_json(details, "error details")
    return {
        "code": _text(item["code"], "error code"),
        "message": _text(item["message"], "error message"),
        "fatal": _boolean(item["fatal"], "error fatal"),
        "details": details,
    }


PayloadParser = Callable[[Any], dict[str, Any]]
_PARSERS: dict[str, PayloadParser] = {
    "handshake": _handshake,
    "handshake_result": _handshake_result,
    "run_start": _run_start,
    "agent_init": _agent_init,
    "agent_init_result": lambda value: _empty(value, "agent_init_result"),
    "agent_turn": _agent_turn,
    "agent_turn_result": _agent_turn_result,
    "run_result": _run_result,
    "error": _error,
    "shutdown": lambda value: _empty(value, "shutdown"),
    "shutdown_result": lambda value: _empty(value, "shutdown_result"),
}

_ALLOWED: dict[Direction, set[str]] = {
    "host-to-bridge": {
        "handshake",
        "run_start",
        "agent_init_result",
        "agent_turn_result",
        "shutdown",
    },
    "bridge-to-host": {
        "handshake_result",
        "agent_init",
        "agent_turn",
        "run_result",
        "error",
        "shutdown_result",
    },
}


def parse_envelope(value: Any, direction: Direction) -> Envelope:
    item = _object(value, "envelope", {"version", "id", "type", "payload"})
    if type(item["version"]) is not int or item["version"] != PROTOCOL_VERSION:
        raise ProtocolViolation("unsupported_version", "envelope version must be 1")
    message_id = item["id"]
    if not isinstance(message_id, str) or not _ID.fullmatch(message_id):
        raise ProtocolViolation("invalid_envelope", "envelope id is invalid")
    message_type = item["type"]
    if not isinstance(message_type, str) or message_type not in _ALLOWED[direction]:
        raise ProtocolViolation(
            "unexpected_message_type",
            f"message type is not allowed for {direction}: {message_type}",
        )
    payload = _PARSERS[message_type](item["payload"])
    return Envelope(PROTOCOL_VERSION, message_id, message_type, payload)


def decode_line(line: str, direction: Direction) -> Envelope:
    if len(line.encode("utf-8")) > MAX_LINE_LENGTH:
        raise ProtocolViolation("message_too_large", "JSONL message exceeds 1 MiB")
    try:
        value = json.loads(
            line,
            object_pairs_hook=_pairs,
            parse_constant=_reject_constant,
        )
    except ProtocolViolation:
        raise
    except json.JSONDecodeError as error:
        raise ProtocolViolation(
            "invalid_json", f"invalid JSON at column {error.colno}"
        ) from error
    return parse_envelope(value, direction)


def encode_line(envelope: Envelope, direction: Direction) -> str:
    checked = parse_envelope(
        {
            "version": envelope.version,
            "id": envelope.id,
            "type": envelope.type,
            "payload": envelope.payload,
        },
        direction,
    )
    return json.dumps(
        {
            "version": checked.version,
            "id": checked.id,
            "type": checked.type,
            "payload": checked.payload,
        },
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )
