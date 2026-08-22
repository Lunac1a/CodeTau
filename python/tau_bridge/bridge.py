"""Stateful stdio service for the CodeTau-to-tau JSONL boundary."""

from __future__ import annotations

import contextlib
import sys
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol, TextIO, TypeVar

from .contract import IntegrationContract, load_integration_contract
from .protocol import (
    PROTOCOL_VERSION,
    Envelope,
    ProtocolViolation,
    decode_line,
    encode_line,
)


@dataclass(frozen=True)
class RunConfig:
    domain: str
    task_split: str
    task_id: str | None
    trial: int
    seed: int | None


@dataclass(frozen=True)
class AgentInit:
    domain_policy: str
    tools: list[dict[str, Any]]
    message_history: list[dict[str, Any]]


@dataclass(frozen=True)
class AgentTurn:
    message: dict[str, Any]


@dataclass(frozen=True)
class RunOutcome:
    reward: float
    status: str


DriverEvent = AgentTurn | RunOutcome


class TauDriver(Protocol):
    """The narrow seam implemented by the pinned upstream adapter in Phase 5.4."""

    def start_run(self, config: RunConfig) -> AgentInit: ...

    def after_agent_init(self) -> DriverEvent: ...

    def after_agent_turn(self, message: dict[str, Any]) -> DriverEvent: ...

    def shutdown(self) -> None: ...


class BridgeState(Enum):
    NEW = "new"
    READY = "ready"
    WAITING_FOR_INIT = "waiting_for_init"
    WAITING_FOR_TURN = "waiting_for_turn"
    CLOSED = "closed"


class BridgeViolation(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        fatal: bool = False,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.fatal = fatal
        self.details = details


T = TypeVar("T")


class BridgeService:
    def __init__(
        self,
        driver: TauDriver,
        output: TextIO,
        diagnostics: TextIO,
        contract: IntegrationContract | None = None,
        allowed_domains: set[str] | None = None,
    ):
        self._driver = driver
        self._output = output
        self._diagnostics = diagnostics
        self._contract = contract or load_integration_contract()
        self._allowed_domains = allowed_domains or {self._contract.smoke_domain}
        self._state = BridgeState.NEW
        self._pending_id: str | None = None
        self._run_id: str | None = None
        self._run: RunConfig | None = None
        self._turn = 0

    @property
    def state(self) -> BridgeState:
        return self._state

    def _driver_call(self, action: str, call: Any) -> T:
        try:
            with contextlib.redirect_stdout(self._diagnostics):
                with contextlib.redirect_stderr(self._diagnostics):
                    return call()
        except Exception as error:
            raise BridgeViolation(
                "driver_failure",
                f"tau driver failed during {action}: {error}",
                fatal=True,
                details={"action": action},
            ) from error

    def _emit(self, message_id: str, message_type: str, payload: dict[str, Any]) -> None:
        try:
            line = encode_line(
                Envelope(PROTOCOL_VERSION, message_id, message_type, payload),
                "bridge-to-host",
            )
        except ProtocolViolation as error:
            raise BridgeViolation(
                "driver_contract_error",
                f"bridge generated an invalid {message_type} message: {error}",
                fatal=True,
                details={"messageType": message_type},
            ) from error
        self._output.write(f"{line}\n")
        self._output.flush()

    def emit_error(
        self,
        message_id: str,
        code: str,
        message: str,
        *,
        fatal: bool,
        details: dict[str, Any] | None = None,
    ) -> None:
        self._diagnostics.write(f"[{code}] {message}\n")
        self._diagnostics.flush()
        self._emit(
            message_id,
            "error",
            {
                "code": code,
                "message": message,
                "fatal": fatal,
                "details": details,
            },
        )

    def _expect(self, state: BridgeState, message: Envelope) -> None:
        if self._state is not state:
            raise BridgeViolation(
                "unexpected_state",
                f"{message.type} is not allowed while bridge state is {self._state.value}",
                details={"state": self._state.value, "messageType": message.type},
            )

    def _expect_correlation(self, message: Envelope) -> None:
        if message.id != self._pending_id:
            raise BridgeViolation(
                "correlation_mismatch",
                f"expected response id {self._pending_id}, received {message.id}",
                details={"expectedId": self._pending_id, "actualId": message.id},
            )

    def _handle_handshake(self, message: Envelope) -> None:
        self._expect(BridgeState.NEW, message)
        if message.payload["protocolVersion"] != PROTOCOL_VERSION:
            raise BridgeViolation(
                "unsupported_version",
                f"host requested protocol {message.payload['protocolVersion']}; only 1 is supported",
                fatal=True,
            )
        self._emit(
            message.id,
            "handshake_result",
            {
                "server": {"name": "codetau-tau-bridge", "version": "0.1.0"},
                "protocolVersion": PROTOCOL_VERSION,
                "upstream": {
                    "displayName": self._contract.display_name,
                    "distribution": self._contract.distribution,
                    "release": self._contract.release,
                    "commit": self._contract.commit,
                },
            },
        )
        self._state = BridgeState.READY

    def _handle_run_start(self, message: Envelope) -> None:
        self._expect(BridgeState.READY, message)
        if message.payload["domain"] not in self._allowed_domains:
            raise BridgeViolation(
                "unsupported_scope",
                "bridge does not permit domain "
                f"{message.payload['domain']}; allowed: {', '.join(sorted(self._allowed_domains))}",
            )
        if message.payload["taskSplit"] != self._contract.task_split:
            raise BridgeViolation(
                "unsupported_scope",
                f"Phase 5.2 only permits task split {self._contract.task_split}",
            )
        config = RunConfig(
            domain=message.payload["domain"],
            task_split=message.payload["taskSplit"],
            task_id=message.payload["taskId"],
            trial=message.payload["trial"],
            seed=message.payload["seed"],
        )
        initialization = self._driver_call(
            "start_run", lambda: self._driver.start_run(config)
        )
        if not isinstance(initialization, AgentInit):
            raise BridgeViolation(
                "driver_contract_error",
                "start_run must return AgentInit",
                fatal=True,
            )
        self._run = config
        self._run_id = message.id
        self._turn = 0
        self._pending_id = f"{message.id}:init"
        self._emit(
            self._pending_id,
            "agent_init",
            {
                "domainPolicy": initialization.domain_policy,
                "tools": initialization.tools,
                "messageHistory": initialization.message_history,
            },
        )
        self._state = BridgeState.WAITING_FOR_INIT

    def _dispatch_driver_event(self, event: DriverEvent) -> None:
        if isinstance(event, AgentTurn):
            if self._run_id is None:
                raise BridgeViolation(
                    "bridge_state_corrupt", "missing active run id", fatal=True
                )
            self._turn += 1
            self._pending_id = f"{self._run_id}:turn:{self._turn}"
            self._emit(self._pending_id, "agent_turn", {"message": event.message})
            self._state = BridgeState.WAITING_FOR_TURN
            return
        if isinstance(event, RunOutcome):
            if self._run is None or self._run_id is None:
                raise BridgeViolation(
                    "bridge_state_corrupt", "missing active run metadata", fatal=True
                )
            self._emit(
                self._run_id,
                "run_result",
                {
                    "reward": event.reward,
                    "status": event.status,
                    "metadata": {
                        "upstreamCommit": self._contract.commit,
                        "protocolVersion": PROTOCOL_VERSION,
                        "domain": self._run.domain,
                        "taskSplit": self._run.task_split,
                        "taskId": self._run.task_id,
                        "trial": self._run.trial,
                        "seed": self._run.seed,
                    },
                },
            )
            self._state = BridgeState.READY
            self._pending_id = None
            self._run_id = None
            self._run = None
            return
        raise BridgeViolation(
            "driver_contract_error",
            "driver returned an unsupported event",
            fatal=True,
        )

    def _handle_agent_init_result(self, message: Envelope) -> None:
        self._expect(BridgeState.WAITING_FOR_INIT, message)
        self._expect_correlation(message)
        event = self._driver_call("after_agent_init", self._driver.after_agent_init)
        self._dispatch_driver_event(event)

    def _handle_agent_turn_result(self, message: Envelope) -> None:
        self._expect(BridgeState.WAITING_FOR_TURN, message)
        self._expect_correlation(message)
        event = self._driver_call(
            "after_agent_turn",
            lambda: self._driver.after_agent_turn(message.payload["message"]),
        )
        self._dispatch_driver_event(event)

    def _handle_shutdown(self, message: Envelope) -> None:
        self._expect(BridgeState.READY, message)
        self._driver_call("shutdown", self._driver.shutdown)
        self._emit(message.id, "shutdown_result", {})
        self._state = BridgeState.CLOSED

    def handle(self, message: Envelope) -> None:
        handlers = {
            "handshake": self._handle_handshake,
            "run_start": self._handle_run_start,
            "agent_init_result": self._handle_agent_init_result,
            "agent_turn_result": self._handle_agent_turn_result,
            "shutdown": self._handle_shutdown,
        }
        handlers[message.type](message)


def serve(
    driver: TauDriver,
    input_stream: TextIO = sys.stdin,
    output_stream: TextIO = sys.stdout,
    diagnostics: TextIO = sys.stderr,
    contract: IntegrationContract | None = None,
    allowed_domains: set[str] | None = None,
) -> int:
    service = BridgeService(
        driver,
        output_stream,
        diagnostics,
        contract,
        allowed_domains,
    )
    for line in input_stream:
        try:
            message = decode_line(line, "host-to-bridge")
            service.handle(message)
        except ProtocolViolation as error:
            service.emit_error(
                "protocol",
                error.code,
                str(error),
                fatal=False,
                details=None,
            )
            continue
        except BridgeViolation as error:
            message_id = locals().get("message")
            error_id = message_id.id if isinstance(message_id, Envelope) else "protocol"
            try:
                service.emit_error(
                    error_id,
                    error.code,
                    str(error),
                    fatal=error.fatal,
                    details=error.details,
                )
            except BridgeViolation as emit_error:
                diagnostics.write(f"[fatal_emit_error] {emit_error}\n")
                diagnostics.flush()
                return 1
            if error.fatal:
                return 1
            continue
        if service.state is BridgeState.CLOSED:
            return 0

    try:
        service.emit_error(
            "protocol",
            "unexpected_eof",
            f"stdin closed while bridge state is {service.state.value}",
            fatal=True,
            details={"state": service.state.value},
        )
    except BridgeViolation as error:
        diagnostics.write(f"[fatal_emit_error] {error}\n")
        diagnostics.flush()
    return 2


class UnavailableTauDriver:
    """Explicit placeholder until the pinned tau adapter is added in Phase 5.4."""

    def start_run(self, config: RunConfig) -> AgentInit:
        raise RuntimeError("official tau runtime adapter is not installed")

    def after_agent_init(self) -> DriverEvent:
        raise RuntimeError("no tau run is active")

    def after_agent_turn(self, message: dict[str, Any]) -> DriverEvent:
        raise RuntimeError("no tau run is active")

    def shutdown(self) -> None:
        return None
