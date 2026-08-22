"""Run the protocol-only bridge entry point."""

import argparse
import sys

from .bridge import serve
from .fake_driver import FakeTauDriver

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

parser = argparse.ArgumentParser(description="CodeTau tau JSONL bridge")
parser.add_argument(
    "--fake",
    action="store_true",
    help="use the deterministic protocol-test driver instead of official tau",
)
arguments = parser.parse_args()

if arguments.fake:
    driver = FakeTauDriver()
else:
    try:
        from .tau_driver import OfficialTauDriver
    except ImportError as error:
        parser.error(
            "official tau runtime is unavailable; run with the pinned upstream Python "
            f"environment ({error})"
        )
    driver = OfficialTauDriver()

raise SystemExit(serve(driver))
