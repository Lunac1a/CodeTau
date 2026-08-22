import json
import unittest
from pathlib import Path

from tau_bridge.contract import load_integration_contract, parse_integration_contract


class IntegrationContractTest(unittest.TestCase):
    def test_loads_pinned_tau3_contract(self) -> None:
        contract = load_integration_contract()

        self.assertEqual(contract.display_name, "tau3-bench")
        self.assertEqual(contract.distribution, "tau2")
        self.assertEqual(contract.release, "v1.0.1")
        self.assertEqual(
            contract.commit, "fc0055dc4e0a316c3f83133267fbd6faaa770992"
        )
        self.assertEqual(contract.license, "MIT")
        self.assertEqual(contract.python, ">=3.12,<3.14")
        self.assertEqual(contract.environment, "isolated")
        self.assertEqual(contract.task_split, "base")
        self.assertEqual(contract.smoke_domain, "mock")
        self.assertEqual(contract.transport_kind, "jsonl-stdio")
        self.assertEqual(contract.protocol_version, 1)

    def test_rejects_a_short_movable_commit_reference(self) -> None:
        source = Path(__file__).parents[1] / "tau_bridge" / "upstream-lock.json"
        value = json.loads(source.read_text(encoding="utf-8"))
        value["benchmark"]["commit"] = "v1.0.1"

        with self.assertRaisesRegex(ValueError, "full SHA-1"):
            parse_integration_contract(value)

    def test_rejects_unknown_contract_fields(self) -> None:
        source = Path(__file__).parents[1] / "tau_bridge" / "upstream-lock.json"
        value = json.loads(source.read_text(encoding="utf-8"))
        value["runtime"]["unreviewedOption"] = True

        with self.assertRaisesRegex(ValueError, "runtime must contain exactly"):
            parse_integration_contract(value)

    def test_rejects_boolean_protocol_version(self) -> None:
        source = Path(__file__).parents[1] / "tau_bridge" / "upstream-lock.json"
        value = json.loads(source.read_text(encoding="utf-8"))
        value["transport"]["protocolVersion"] = True

        with self.assertRaisesRegex(ValueError, "protocol version"):
            parse_integration_contract(value)


if __name__ == "__main__":
    unittest.main()
