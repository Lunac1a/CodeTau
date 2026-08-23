"""Deterministic driver used by the TypeScript adapter acceptance tests."""

from __future__ import annotations

from typing import Any

from .bridge import AgentInit, AgentTurn, DriverEvent, RunConfig, RunOutcome


class FakeTauDriver:
    def __init__(self) -> None:
        self._turn = 0

    def start_run(self, config: RunConfig) -> AgentInit:
        self._turn = 0
        return AgentInit(
            domain_policy="Use the mock order tool to answer the user accurately.",
            tools=[
                {
                    "name": "lookup_order",
                    "description": "Look up an order by id.",
                    "parameters": {
                        "type": "object",
                        "properties": {"orderId": {"type": "string"}},
                        "required": ["orderId"],
                        "additionalProperties": False,
                    },
                    "toolType": "read",
                    "mutatesState": False,
                }
            ],
            message_history=[],
        )

    def after_agent_init(self) -> DriverEvent:
        return AgentTurn({"kind": "user", "content": "Find order 100."})

    def after_agent_turn(self, message: dict[str, Any]) -> DriverEvent:
        self._turn += 1
        if self._turn == 1:
            calls = message["toolCalls"]
            if len(calls) != 1 or calls[0]["name"] != "lookup_order":
                raise RuntimeError("fake driver expected one lookup_order call")
            return AgentTurn(
                {
                    "kind": "tool",
                    "toolCallId": calls[0]["id"],
                    "name": calls[0]["name"],
                    "result": {"orderId": "100", "status": "found"},
                }
            )
        if message["content"] is None:
            raise RuntimeError("fake driver expected a final text response")
        return RunOutcome(
            reward=1.0,
            status="completed",
            termination_reason="user_stop",
            reward_info={
                "reward": 1.0,
                "reward_basis": ["DB"],
                "reward_breakdown": {"DB": 1.0},
            },
        )

    def shutdown(self) -> None:
        return None
