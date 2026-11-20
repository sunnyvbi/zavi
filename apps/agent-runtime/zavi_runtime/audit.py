from __future__ import annotations

from .models import RunContext, RunState, ToolResult
from .ports import Ports

STAGE_OK = "tool_use_completed"
STAGE_ERROR = "tool_use_errored"

def sanitize(tool_name: str, ms: int, code: str, iteration: int) -> dict[str, str | int]:
    return {
        "tool_name": tool_name[:64],
        "ms": max(0, int(ms)),
        "code": code[:64],
        "iter": max(0, int(iteration)),
    }

async def emit(ports: Ports, ctx: RunContext, state: RunState, tool_name: str, result: ToolResult) -> ToolResult:
    code = result.code or ("ok" if result.ok else "err")
    stage = STAGE_OK if code == "ok" else STAGE_ERROR
    try:
        await ports.write_run_event(ctx.run_id, ctx.tenant_id, stage, sanitize(tool_name, result.ms, code, state.iter))
    except Exception as e:
        ports.log("warn", "audit_write_failed", run_id=ctx.run_id, tool_name=tool_name, error=str(e))
    return result
