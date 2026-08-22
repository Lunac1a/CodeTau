"""Run the protocol-only bridge entry point."""

import argparse
import sys

from .bridge import UnavailableTauDriver, serve
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

raise SystemExit(serve(FakeTauDriver() if arguments.fake else UnavailableTauDriver()))
