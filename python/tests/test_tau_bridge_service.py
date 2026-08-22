import io
import json
import unittest
from typing import Any

from tau_bridge.bridge import (
    AgentInit,
    AgentTurn,
    RunConfig,
    RunOutcome,
    serve,
)


def message(message_id: str, message_type: str, payload: object) -> str:
    return json.dumps(
        {"version": 1, "id": message_id, "type": message_type, "payload": payload}
    )


def handshake(message_id: str = "hello") -> str:
    return message(
        message_id,
        "handshake",
        {"client": {"name": "codetau", "version": "0.1.0"}, "protocolVersion": 1},
    )


def run_start(message_id: str = "run-1") -> str:
    return message(
        message_id,
        "run_start",
        {"domain": "mock", "taskSplit": "base", "taskId": "task-1", "trial": 1, "seed": 7},
    )


def assistant(message_id: str, content: str) -> str:
    return message(
        message_id,
        "agent_turn_result",
        {"message": {"role": "assistant", "content": content, "toolCalls": []}},
    )


def assistant_tool_call(message_id: str) -> str:
    return message(
        message_id,
        "agent_turn_result",
        {
            "message": {
                "role": "assistant",
                "content": None,
                "toolCalls": [
                    {
                        "id": "call-1",
                        "name": "lookup_order",
                        "arguments": {"orderId": "100"},
                    }
                ],
            }
        },
    )


class FakeTauDriver:
    def __init__(self) -> None:
        self.config: RunConfig | None = None
        self.messages: list[dict[str, Any]] = []
        self.closed = False

    def start_run(self, config: RunConfig) -> AgentInit:
        print("fake upstream initialization log")
        self.config = config
        return AgentInit(
            domain_policy="Follow the mock policy.",
            tools=[
                {
                    "name": "lookup_order",
                    "description": "Look up an order.",
                    "parameters": {
                        "type": "object",
                        "properties": {"orderId": {"type": "string"}},
                        "required": ["orderId"],
                        "additionalProperties": False,
                    },
                }
            ],
            message_history=[],
        )

    def after_agent_init(self) -> AgentTurn:
        return AgentTurn({"kind": "user", "content": "Find order 100."})

    def after_agent_turn(self, value: dict[str, Any]) -> AgentTurn | RunOutcome:
        self.messages.append(value)
        if len(self.messages) == 1:
            return AgentTurn(
                {
                    "kind": "tool",
                    "toolCallId": "call-1",
                    "name": "lookup_order",
                    "result": {"status": "found"},
                }
            )
        return RunOutcome(reward=1.0, status="completed")

    def shutdown(self) -> None:
        self.closed = True


class FailingTauDriver(FakeTauDriver):
    def start_run(self, config: RunConfig) -> AgentInit:
        raise RuntimeError("upstream exploded")


class BridgeServiceTest(unittest.TestCase):
    def run_service(self, driver: FakeTauDriver, lines: list[str]) -> tuple[int, list[dict[str, Any]], str]:
        output = io.StringIO()
        diagnostics = io.StringIO()
        code = serve(
            driver,
            io.StringIO("\n".join(lines) + "\n"),
            output,
            diagnostics,
        )
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        return code, messages, diagnostics.getvalue()

    def test_runs_a_complete_fake_half_duplex_session(self) -> None:
        driver = FakeTauDriver()
        lines = [
            handshake(),
            run_start(),
            message("run-1:init", "agent_init_result", {}),
            assistant_tool_call("run-1:turn:1"),
            assistant("run-1:turn:2", "The order was found."),
            message("stop", "shutdown", {}),
        ]

        code, output, diagnostics = self.run_service(driver, lines)

        self.assertEqual(code, 0)
        self.assertEqual(
            [item["type"] for item in output],
            [
                "handshake_result",
                "agent_init",
                "agent_turn",
                "agent_turn",
                "run_result",
                "shutdown_result",
            ],
        )
        self.assertEqual(output[4]["payload"]["reward"], 1.0)
        self.assertEqual(
            output[4]["payload"]["metadata"]["upstreamCommit"],
            "fc0055dc4e0a316c3f83133267fbd6faaa770992",
        )
        self.assertEqual(driver.config, RunConfig("mock", "base", "task-1", 1, 7))
        self.assertEqual(len(driver.messages), 2)
        self.assertEqual(
            driver.messages[0]["toolCalls"][0]["name"], "lookup_order"
        )
        self.assertTrue(driver.closed)
        self.assertIn("fake upstream initialization log", diagnostics)
        self.assertNotIn("fake upstream initialization log", json.dumps(output))

    def test_reports_a_correlation_error_and_accepts_the_expected_response(self) -> None:
        driver = FakeTauDriver()
        lines = [
            handshake(),
            run_start(),
            message("wrong:init", "agent_init_result", {}),
            message("run-1:init", "agent_init_result", {}),
            assistant_tool_call("run-1:turn:1"),
            assistant("run-1:turn:2", "Second response."),
            message("stop", "shutdown", {}),
        ]

        code, output, _ = self.run_service(driver, lines)

        self.assertEqual(code, 0)
        error = next(item for item in output if item["type"] == "error")
        self.assertEqual(error["payload"]["code"], "correlation_mismatch")
        self.assertFalse(error["payload"]["fatal"])
        self.assertIn("run_result", [item["type"] for item in output])

    def test_recovers_after_malformed_json(self) -> None:
        driver = FakeTauDriver()
        lines = ["not-json", handshake(), message("stop", "shutdown", {})]

        code, output, diagnostics = self.run_service(driver, lines)

        self.assertEqual(code, 0)
        self.assertEqual(output[0]["type"], "error")
        self.assertEqual(output[0]["payload"]["code"], "invalid_json")
        self.assertEqual(output[-1]["type"], "shutdown_result")
        self.assertIn("invalid_json", diagnostics)

    def test_rejects_a_second_run_while_waiting_for_agent_init(self) -> None:
        driver = FakeTauDriver()
        lines = [
            handshake(),
            run_start(),
            run_start("run-2"),
            message("run-1:init", "agent_init_result", {}),
            assistant_tool_call("run-1:turn:1"),
            assistant("run-1:turn:2", "Second response."),
            message("stop", "shutdown", {}),
        ]

        code, output, _ = self.run_service(driver, lines)

        self.assertEqual(code, 0)
        error = next(item for item in output if item["type"] == "error")
        self.assertEqual(error["payload"]["code"], "unexpected_state")

    def test_rejects_a_domain_outside_the_locked_smoke_scope(self) -> None:
        driver = FakeTauDriver()
        retail_run = message(
            "retail-run",
            "run_start",
            {
                "domain": "retail",
                "taskSplit": "base",
                "taskId": None,
                "trial": 1,
                "seed": None,
            },
        )

        code, output, _ = self.run_service(
            driver, [handshake(), retail_run, message("stop", "shutdown", {})]
        )

        self.assertEqual(code, 0)
        self.assertEqual(output[1]["payload"]["code"], "unsupported_scope")
        self.assertIsNone(driver.config)

    def test_rejects_an_incompatible_handshake_version(self) -> None:
        incompatible = message(
            "hello",
            "handshake",
            {
                "client": {"name": "codetau", "version": "0.1.0"},
                "protocolVersion": 2,
            },
        )

        code, output, _ = self.run_service(FakeTauDriver(), [incompatible])

        self.assertEqual(code, 1)
        self.assertEqual(output[-1]["payload"]["code"], "unsupported_version")
        self.assertTrue(output[-1]["payload"]["fatal"])

    def test_returns_a_fatal_structured_driver_error(self) -> None:
        code, output, diagnostics = self.run_service(
            FailingTauDriver(), [handshake(), run_start()]
        )

        self.assertEqual(code, 1)
        self.assertEqual(output[-1]["type"], "error")
        self.assertEqual(output[-1]["payload"]["code"], "driver_failure")
        self.assertTrue(output[-1]["payload"]["fatal"])
        self.assertIn("upstream exploded", diagnostics)

    def test_eof_without_shutdown_is_a_transport_failure(self) -> None:
        code, output, _ = self.run_service(FakeTauDriver(), [handshake()])

        self.assertEqual(code, 2)
        self.assertEqual(output[-1]["payload"]["code"], "unexpected_eof")
        self.assertTrue(output[-1]["payload"]["fatal"])


if __name__ == "__main__":
    unittest.main()
