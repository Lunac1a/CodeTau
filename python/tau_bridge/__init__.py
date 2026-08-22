"""CodeTau's isolated compatibility boundary for the official tau runtime."""

from .contract import (
    IntegrationContract,
    load_integration_contract,
    parse_integration_contract,
)
from .protocol import Envelope, ProtocolViolation, decode_line, encode_line

__all__ = [
    "IntegrationContract",
    "load_integration_contract",
    "parse_integration_contract",
    "Envelope",
    "ProtocolViolation",
    "decode_line",
    "encode_line",
]
