from __future__ import annotations

import json
import re
import threading
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

Effect = Literal["read", "write"]
Risk = Literal["read", "write_low", "write_external", "write_code", "write_money"]
Autonomy = Literal["auto", "approval", "forbidden"]

NAME_RE = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")

class ExpectedToolError(Exception):
    def __init__(self, code: str, message: str | None = None, meta: dict[str, Any] | None = None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.meta = meta

class GovernedDispatch(BaseModel):
    model_config = ConfigDict(frozen=True)

    decision_id: str
    tool: str

class RunContext(BaseModel):
    model_config = ConfigDict(frozen=True)

    tenant_id: str
    run_id: str
    agent_slug: str
    trigger: str = "manual"
    user_id: str | None = None
    thread_id: str | None = None
    untrusted_inbound: bool = False
    draft_mode: bool = False
    actor: dict[str, Any] | None = None
    routing: dict[str, Any] | None = None
    governed_dispatch: GovernedDispatch | None = None

@dataclass
class RunState:
    call_sig_counts: dict[str, int] = field(default_factory=dict)
    error_code_counts: dict[str, int] = field(default_factory=dict)
    killed: bool = False
    iter: int = 0

MAX_TRACKED_RUNS = 512

class RunStates:
    def __init__(self, max_runs: int = MAX_TRACKED_RUNS) -> None:
        if max_runs < 1:
            raise ValueError("max_runs must be >= 1")
        self._max_runs = max_runs
        self._lock = threading.Lock()
        self._by_run: OrderedDict[str, RunState] = OrderedDict()

    def for_run(self, run_id: str) -> RunState:
        if not run_id:
            raise ValueError("run_id is required to resolve per-run state")
        with self._lock:
            state = self._by_run.get(run_id)
            if state is None:
                state = RunState()
                self._by_run[run_id] = state
                while len(self._by_run) > self._max_runs:
                    self._by_run.popitem(last=False)
            else:
                self._by_run.move_to_end(run_id)
            return state

    def discard(self, run_id: str) -> None:
        with self._lock:
            self._by_run.pop(run_id, None)

    def __len__(self) -> int:
        with self._lock:
            return len(self._by_run)

ToolRunner = Callable[[RunContext, Any], Awaitable[Any]]

@dataclass(frozen=True)
class ToolDef:
    server: str
    name: str
    description: str
    args: type[BaseModel]
    effect: Effect
    risk: Risk
    run: ToolRunner
    egress: bool = False
    governance_class: str | None = None
    untrusted_output: bool = False

    def __post_init__(self) -> None:
        if not NAME_RE.match(self.server) or not NAME_RE.match(self.name):
            raise ValueError(f"tool identity must be snake_case: {self.server}/{self.name}")
        if (self.effect == "read") != (self.risk == "read"):
            raise ValueError(f"{self.full_name}: effect={self.effect} conflicts with risk={self.risk}")
        if self.governance_class is not None and self.effect != "write":
            raise ValueError(f"{self.full_name}: only write tools can be governed")
        if not (isinstance(self.args, type) and issubclass(self.args, BaseModel)):
            raise ValueError(f"{self.full_name}: args must be a pydantic model class")

    @property
    def full_name(self) -> str:
        return f"{self.server}__{self.name}"

@dataclass(frozen=True)
class ToolCall:
    tool: str
    args: dict[str, Any]
    tool_call_id: str

@dataclass(frozen=True)
class ToolResult:
    ok: bool
    content: str
    code: str | None = None
    ms: int = 0
    denied: bool = False

@dataclass(frozen=True)
class Deny:
    code: str
    message: str
    meta: dict[str, Any] | None = None

def ok_result(output: Any, ms: int = 0) -> ToolResult:
    return ToolResult(ok=True, content=json.dumps(output, default=str), code="ok", ms=ms)

def error_result(
    code: str,
    message: str,
    meta: dict[str, Any] | None = None,
    *,
    ms: int = 0,
    denied: bool = False,
) -> ToolResult:
    body: dict[str, Any] = {"error": code, "message": message}
    if meta:
        body["meta"] = meta
    return ToolResult(ok=False, content=json.dumps(body, default=str), code=code, ms=ms, denied=denied)
