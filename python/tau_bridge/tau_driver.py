"""Adapter from the CodeTau JSONL lifecycle to pinned tau2-bench v1.0.1."""

from __future__ import annotations

import json
from queue import Queue
from threading import Thread
from typing import Any

from tau2.agent.base_agent import HalfDuplexAgent
from tau2.data_model.message import AssistantMessage, MultiToolMessage, ToolCall, ToolMessage, UserMessage
from tau2.evaluator.evaluator import EvaluationType
from tau2.orchestrator.orchestrator import Orchestrator
from tau2.runner import build_environment, build_user, get_tasks, run_simulation

from .bridge import AgentInit, AgentTurn, DriverEvent, RunConfig, RunOutcome


class _ScriptedSmokeUser:
    """Deterministic user boundary used only by the Phase 5.4 integration smoke."""

    def __init__(self, instruction: str):
        self._instruction = instruction

    def get_init_state(self, message_history: list[Any] | None = None) -> int:
        return 0

    def set_seed(self, seed: int) -> None:
        return None

    def stop(self, message: Any = None, state: Any = None) -> None:
        return None

    def generate_next_message(self, message: Any, state: int) -> tuple[UserMessage, int]:
        if state == 0:
            return UserMessage.text(self._instruction), 1
        return UserMessage.text("###STOP###"), state + 1


class _BridgeAgent(HalfDuplexAgent[None]):
    def __init__(self, tools: list[Any], domain_policy: str):
        super().__init__(tools=tools, domain_policy=domain_policy)
        self.events: Queue[AgentTurn | RunOutcome | BaseException] = Queue()
        self.responses: Queue[dict[str, Any]] = Queue()
        self._tool_names: dict[str, str] = {}

    def get_init_state(self, message_history: list[Any] | None = None) -> None:
        return None

    def set_seed(self, seed: int) -> None:
        return None

    def generate_next_message(
        self, message: UserMessage | ToolMessage | MultiToolMessage, state: None
    ) -> tuple[AssistantMessage, None]:
        self.events.put(AgentTurn(_input_message(message, self._tool_names)))
        response = self.responses.get()
        calls = [
            ToolCall(
                id=call["id"],
                name=call["name"],
                arguments=call["arguments"],
                requestor="assistant",
            )
            for call in response["toolCalls"]
        ]
        for call in calls:
            self._tool_names[call.id] = call.name
        return AssistantMessage(
            role="assistant",
            content=response["content"],
            tool_calls=calls or None,
        ), state


def _json_result(content: str | None) -> Any:
    if content is None:
        return None
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return content


def _tool_result(message: ToolMessage, tool_names: dict[str, str]) -> dict[str, Any]:
    name = tool_names.get(message.id)
    if name is None:
        raise RuntimeError(f"tau returned an unknown tool call id: {message.id}")
    result = _json_result(message.content)
    if message.error:
        result = {"error": True, "result": result}
    return {"toolCallId": message.id, "name": name, "result": result}


def _input_message(
    message: UserMessage | ToolMessage | MultiToolMessage,
    tool_names: dict[str, str],
) -> dict[str, Any]:
    if isinstance(message, UserMessage):
        if message.content is None:
            raise RuntimeError("tau user emitted an empty message")
        return {"kind": "user", "content": message.content}
    if isinstance(message, ToolMessage):
        return {"kind": "tool", **_tool_result(message, tool_names)}
    return {
        "kind": "multi_tool",
        "results": [_tool_result(item, tool_names) for item in message.tool_messages],
    }


def _tool_definitions(tools: list[Any]) -> list[dict[str, Any]]:
    definitions: list[dict[str, Any]] = []
    for tool in tools:
        function = tool.openai_schema["function"]
        definitions.append({
            "name": function["name"],
            "description": function.get("description") or function["name"],
            "parameters": function["parameters"],
        })
    return definitions


class OfficialTauDriver:
    """Runs one pinned official task while the host supplies agent turns."""

    def __init__(
        self,
        *,
        event_timeout_seconds: float = 300.0,
        user_mode: str = "scripted",
        user_model: str | None = None,
        user_base_url: str | None = None,
        user_api_key: str | None = None,
        evaluation: str = "env",
    ):
        self._event_timeout_seconds = event_timeout_seconds
        if user_mode not in {"scripted", "official"}:
            raise ValueError("user_mode must be scripted or official")
        if user_mode == "official" and (not user_model or not user_base_url):
            raise ValueError("official user mode requires a model and base URL")
        self._user_mode = user_mode
        self._user_model = user_model
        self._user_base_url = user_base_url
        self._user_api_key = user_api_key or "lm-studio"
        self._evaluation_type = EvaluationType(evaluation)
        self._agent: _BridgeAgent | None = None
        self._orchestrator: Orchestrator | None = None
        self._thread: Thread | None = None

    def start_run(self, config: RunConfig) -> AgentInit:
        if self._agent is not None:
            raise RuntimeError("a tau run is already active")
        tasks = get_tasks(
            config.domain,
            task_split_name=config.task_split,
            task_ids=[config.task_id] if config.task_id is not None else None,
            num_tasks=1,
        )
        if len(tasks) != 1:
            raise RuntimeError("the smoke run must resolve exactly one task")
        task = tasks[0]
        environment = build_environment(config.domain)
        agent = _BridgeAgent(environment.get_tools(), environment.get_policy())
        if self._user_mode == "official":
            user = build_user(
                "user_simulator",
                environment,
                task,
                llm=self._user_model,
                llm_args={
                    "api_base": self._user_base_url,
                    "api_key": self._user_api_key,
                    "temperature": 0,
                },
            )
        else:
            instruction = getattr(task.user_scenario, "instructions", None)
            if not isinstance(instruction, str) or not instruction:
                raise RuntimeError(f"task {task.id} has no scripted user instruction")
            user = _ScriptedSmokeUser(instruction)
        self._agent = agent
        self._orchestrator = Orchestrator(
            domain=config.domain,
            agent=agent,
            user=user,
            environment=environment,
            task=task,
            max_steps=200 if self._user_mode == "official" else 10,
            max_errors=10 if self._user_mode == "official" else 3,
            seed=config.seed,
            validate_communication=True,
        )
        return AgentInit(
            domain_policy=environment.get_policy(),
            tools=_tool_definitions(environment.get_tools()),
            message_history=[],
        )

    def after_agent_init(self) -> DriverEvent:
        if self._agent is None or self._orchestrator is None:
            raise RuntimeError("no tau run is active")
        self._thread = Thread(target=self._run, name="codetau-tau-smoke", daemon=True)
        self._thread.start()
        return self._next_event()

    def after_agent_turn(self, message: dict[str, Any]) -> DriverEvent:
        if self._agent is None:
            raise RuntimeError("no tau run is active")
        self._agent.responses.put(message)
        return self._next_event()

    def _run(self) -> None:
        assert self._agent is not None
        assert self._orchestrator is not None
        try:
            simulation = run_simulation(
                self._orchestrator,
                evaluation_type=self._evaluation_type,
            )
            reward = simulation.reward_info.reward
            if reward is None:
                raise RuntimeError("tau evaluator returned no reward")
            self._agent.events.put(
                RunOutcome(
                    reward=float(reward),
                    status="completed",
                    termination_reason=simulation.termination_reason.value,
                    reward_info=simulation.reward_info.model_dump(mode="json"),
                )
            )
        except BaseException as error:
            self._agent.events.put(error)

    def _next_event(self) -> DriverEvent:
        assert self._agent is not None
        event = self._agent.events.get(timeout=self._event_timeout_seconds)
        if isinstance(event, BaseException):
            self._clear_finished_run()
            raise RuntimeError(f"official tau simulation failed: {event}") from event
        if isinstance(event, RunOutcome):
            self._clear_finished_run()
        return event

    def _clear_finished_run(self) -> None:
        self._agent = None
        self._orchestrator = None
        self._thread = None

    def shutdown(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            raise RuntimeError("cannot shut down while a tau run is active")
        self._clear_finished_run()
