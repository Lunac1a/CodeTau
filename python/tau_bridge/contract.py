"""Strict loader for the Phase 5 upstream integration contract."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .protocol import PROTOCOL_VERSION

_SHA1 = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class IntegrationContract:
    display_name: str
    distribution: str
    repository: str
    release: str
    tag_object: str
    commit: str
    license: str
    python: str
    environment: str
    package_manager: str
    install_mode: str
    sync_mode: str
    modality: str
    communication: str
    task_split: str
    smoke_domain: str
    transport_kind: str
    protocol_version: int
    encoding: str


def _object(value: Any, name: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{name} must contain exactly: {', '.join(sorted(keys))}")
    return value


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def load_integration_contract(path: Path | None = None) -> IntegrationContract:
    source = path or Path(__file__).with_name("upstream-lock.json")
    try:
        raw: Any = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"unable to read integration contract: {source}") from error

    return parse_integration_contract(raw)


def parse_integration_contract(raw: Any) -> IntegrationContract:
    """Validate an already decoded integration contract."""

    root = _object(
        raw,
        "contract",
        {"schemaVersion", "benchmark", "runtime", "evaluation", "transport"},
    )
    if type(root["schemaVersion"]) is not int or root["schemaVersion"] != 1:
        raise ValueError("unsupported integration contract schemaVersion")

    benchmark = _object(
        root["benchmark"],
        "benchmark",
        {
            "displayName",
            "distribution",
            "repository",
            "release",
            "tagObject",
            "commit",
            "license",
        },
    )
    runtime = _object(
        root["runtime"],
        "runtime",
        {"python", "environment", "packageManager", "installMode", "syncMode"},
    )
    evaluation = _object(
        root["evaluation"],
        "evaluation",
        {"modality", "communication", "taskSplit", "smokeDomain"},
    )
    transport = _object(
        root["transport"],
        "transport",
        {"kind", "protocolVersion", "encoding"},
    )

    tag_object = _text(benchmark["tagObject"], "benchmark.tagObject")
    commit = _text(benchmark["commit"], "benchmark.commit")
    if not _SHA1.fullmatch(tag_object) or not _SHA1.fullmatch(commit):
        raise ValueError("benchmark tagObject and commit must be full SHA-1 values")
    if (
        type(transport["protocolVersion"]) is not int
        or transport["protocolVersion"] != PROTOCOL_VERSION
    ):
        raise ValueError("unsupported JSONL protocol version")

    return IntegrationContract(
        display_name=_text(benchmark["displayName"], "benchmark.displayName"),
        distribution=_text(benchmark["distribution"], "benchmark.distribution"),
        repository=_text(benchmark["repository"], "benchmark.repository"),
        release=_text(benchmark["release"], "benchmark.release"),
        tag_object=tag_object,
        commit=commit,
        license=_text(benchmark["license"], "benchmark.license"),
        python=_text(runtime["python"], "runtime.python"),
        environment=_text(runtime["environment"], "runtime.environment"),
        package_manager=_text(runtime["packageManager"], "runtime.packageManager"),
        install_mode=_text(runtime["installMode"], "runtime.installMode"),
        sync_mode=_text(runtime["syncMode"], "runtime.syncMode"),
        modality=_text(evaluation["modality"], "evaluation.modality"),
        communication=_text(evaluation["communication"], "evaluation.communication"),
        task_split=_text(evaluation["taskSplit"], "evaluation.taskSplit"),
        smoke_domain=_text(evaluation["smokeDomain"], "evaluation.smokeDomain"),
        transport_kind=_text(transport["kind"], "transport.kind"),
        protocol_version=transport["protocolVersion"],
        encoding=_text(transport["encoding"], "transport.encoding"),
    )
