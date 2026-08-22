"""Run the protocol-only bridge entry point."""

import argparse
import os
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
parser.add_argument(
    "--allow-domain",
    choices=("mock", "airline"),
    default="mock",
    help="permit exactly one evaluation domain for this process",
)
parser.add_argument(
    "--user-mode",
    choices=("scripted", "official"),
    default="scripted",
)
parser.add_argument("--user-model")
parser.add_argument("--user-base-url")
parser.add_argument(
    "--evaluation",
    choices=("env", "all"),
    default="env",
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
    driver = OfficialTauDriver(
        user_mode=arguments.user_mode,
        user_model=arguments.user_model,
        user_base_url=arguments.user_base_url,
        user_api_key=os.environ.get("CODETAU_TAU_USER_API_KEY"),
        evaluation=arguments.evaluation,
    )

raise SystemExit(serve(driver, allowed_domains={arguments.allow_domain}))
