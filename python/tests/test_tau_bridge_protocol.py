import json
import unittest

from tau_bridge.protocol import (
    MAX_LINE_LENGTH,
    PROTOCOL_VERSION,
    Envelope,
    ProtocolViolation,
    decode_line,
    encode_line,
)


def host_message(message_id: str, message_type: str, payload: object) -> str:
    return json.dumps(
        {
            "version": PROTOCOL_VERSION,
            "id": message_id,
            "type": message_type,
            "payload": payload,
        }
    )


class JsonlProtocolTest(unittest.TestCase):
    def test_round_trips_a_strict_agent_turn_result(self) -> None:
        line = host_message(
            "run-1:turn:1",
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

        decoded = decode_line(line, "host-to-bridge")

        self.assertEqual(decoded.id, "run-1:turn:1")
        self.assertEqual(decoded.payload["message"]["toolCalls"][0]["name"], "lookup_order")

    def test_rejects_duplicate_json_fields(self) -> None:
        line = (
            '{"version":1,"id":"one","id":"two",'
            '"type":"shutdown","payload":{}}'
        )

        with self.assertRaisesRegex(ProtocolViolation, "duplicate JSON field"):
            decode_line(line, "host-to-bridge")

    def test_rejects_unknown_envelope_and_payload_fields(self) -> None:
        envelope = json.loads(host_message("one", "shutdown", {}))
        envelope["extra"] = True
        with self.assertRaisesRegex(ProtocolViolation, "envelope must contain exactly"):
            decode_line(json.dumps(envelope), "host-to-bridge")

        with self.assertRaisesRegex(
            ProtocolViolation, "shutdown payload must contain exactly"
        ):
            decode_line(host_message("one", "shutdown", {"force": True}), "host-to-bridge")

    def test_rejects_non_finite_numbers_and_oversized_lines(self) -> None:
        with self.assertRaisesRegex(ProtocolViolation, "non-finite JSON number"):
            decode_line(
                '{"version":1,"id":"one","type":"run_start",'
                '"payload":{"domain":"mock","taskSplit":"base",'
                '"taskId":null,"trial":1,"seed":NaN}}',
                "host-to-bridge",
            )

        with self.assertRaisesRegex(ProtocolViolation, "exceeds 1 MiB"):
            decode_line(" " * (MAX_LINE_LENGTH + 1), "host-to-bridge")

    def test_rejects_an_empty_assistant_message(self) -> None:
        with self.assertRaisesRegex(ProtocolViolation, "text or at least one tool call"):
            decode_line(
                host_message(
                    "turn-1",
                    "agent_turn_result",
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "toolCalls": [],
                        }
                    },
                ),
                "host-to-bridge",
            )

    def test_encoder_revalidates_bridge_owned_messages(self) -> None:
        invalid = Envelope(
            PROTOCOL_VERSION,
            "result-1",
            "run_result",
            {
                "reward": 2,
                "status": "completed",
                "metadata": {
                    "upstreamCommit": "abc",
                    "protocolVersion": 1,
                    "domain": "mock",
                    "taskSplit": "base",
                    "taskId": None,
                    "trial": 1,
                    "seed": None,
                },
            },
        )

        with self.assertRaisesRegex(ProtocolViolation, "from 0 to 1"):
            encode_line(invalid, "bridge-to-host")


if __name__ == "__main__":
    unittest.main()
