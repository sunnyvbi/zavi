from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, TypedDict

from deepagents import FilesystemPermission, create_deep_agent
from langchain.agents.middleware import AgentMiddleware, ToolCallLimitMiddleware
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain.tools import ToolRuntime
from langchain_core.tools import StructuredTool

from .execute import execute
from .models import RunContext, RunStates, ToolCall, ToolDef
from .ports import Ports

BUILTIN_TOOL_NAMES: frozenset[str] = frozenset(
    {"delete", "edit_file", "glob", "grep", "ls", "read_file", "task", "write_file"}
)

EXCLUDED_BUILTIN_TOOLS: frozenset[str] = frozenset({"execute", "shell"})

FS_PERMISSIONS: tuple[FilesystemPermission, ...] = (
    FilesystemPermission(operations=["write"], paths=["/memory/**"], mode="deny"),
    FilesystemPermission(operations=["write"], paths=["/skills/**"], mode="deny"),
    FilesystemPermission(operations=["read"], paths=["/memory/**", "/skills/**"], mode="allow"),
    FilesystemPermission(operations=["read", "write"], paths=["/**"], mode="allow"),
)

class SubagentSpec(TypedDict):
    name: str
    description: str
    system_prompt: str
    tools: Sequence[ToolDef]

class ToolSurfaceMiddleware(AgentMiddleware[Any, Any, Any]):
    def __init__(self, excluded: frozenset[str] = EXCLUDED_BUILTIN_TOOLS) -> None:
        super().__init__()
        self.excluded = excluded

    def _filter(self, request: ModelRequest[Any]) -> ModelRequest[Any]:
        kept = [t for t in request.tools if getattr(t, "name", None) not in self.excluded]
        return request if len(kept) == len(request.tools) else request.override(tools=kept)

    def wrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], ModelResponse]
    ) -> ModelResponse:
        return handler(self._filter(request))

    async def awrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse]]
    ) -> ModelResponse:
        return await handler(self._filter(request))

def as_langchain_tool(tool: ToolDef, states: RunStates, ports: Ports) -> StructuredTool:
    async def body(runtime: ToolRuntime[RunContext], **kwargs: Any) -> str:
        ctx = runtime.context
        call = ToolCall(tool=tool.full_name, args=kwargs, tool_call_id=runtime.tool_call_id or uuid.uuid4().hex)
        return (await execute(tool, call, ctx, states.for_run(ctx.run_id), ports)).content

    return StructuredTool.from_function(
        coroutine=body, name=tool.full_name, description=tool.description, args_schema=tool.args
    )

def build_tools(defs: Sequence[ToolDef], states: RunStates, ports: Ports) -> list[StructuredTool]:
    return [as_langchain_tool(t, states, ports) for t in defs]

def read_only(defs: Sequence[ToolDef]) -> list[ToolDef]:
    return [t for t in defs if t.effect == "read"]

def build_subagents(specs: Sequence[SubagentSpec], states: RunStates, ports: Ports) -> list[dict[str, Any]]:
    out = []
    for spec in specs:
        writes = [t.full_name for t in spec["tools"] if t.effect != "read"]
        if writes:
            raise ValueError(f"subagent {spec['name']} may only hold read tools, got {writes}")
        out.append({**spec, "tools": build_tools(spec["tools"], states, ports)})
    return out

def build_agent(
    model: Any,
    defs: Sequence[ToolDef],
    *,
    states: RunStates,
    ports: Ports,
    system_prompt: str | None = None,
    subagents: Sequence[SubagentSpec] = (),
    run_limit: int = 50,
    **kwargs: Any,
) -> Any:
    return create_deep_agent(
        model=model,
        tools=build_tools(defs, states, ports),
        system_prompt=system_prompt,
        context_schema=RunContext,
        subagents=build_subagents(subagents, states, ports),
        permissions=list(FS_PERMISSIONS),
        middleware=[ToolCallLimitMiddleware(run_limit=run_limit), ToolSurfaceMiddleware()],
        **kwargs,
    )
