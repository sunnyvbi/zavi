from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from .models import Deny, RunContext, RunState, ToolCall, ToolDef
from .ports import Ports

Gate = Callable[[ToolDef, ToolCall, RunContext, RunState, Ports], Awaitable[Deny | None]]

REPEAT_TOOL_CALL_CAP = 8
REPEAT_ERROR_CAP = 8

DRAFT_DENY_MESSAGE = (
    "draft candidate: side-effecting tools are disabled while comparing candidates. "
    "This call was not executed. Summarize what you WOULD do instead."
)

def call_signature(tool: str, args: dict[str, Any]) -> str:
    return f"{tool}:{json.dumps(args, sort_keys=True, default=str)}"

def loop_cap_message(reason: str, tool: str) -> str:
    why = (
        f"`{tool}` has now been called with the SAME input {REPEAT_TOOL_CALL_CAP}+ times this run — it is looping with no new information."
        if reason == "same_call"
        else f"`{tool}` keeps returning the SAME error {REPEAT_ERROR_CAP}+ times this run — retrying is not getting past it."
    )
    return "\n".join(
        [
            "RUNAWAY LOOP — STOP calling this tool.",
            "",
            why,
            "",
            f"Do NOT call `{tool}` (or any tool) again for this. Summarize the answer NOW from what you have ALREADY gathered, "
            "and if a piece is genuinely missing, say exactly what you could not get. A partial, honest summary is the correct "
            "outcome here — another identical call will not help and only burns the run budget.",
        ]
    )

async def fail_open(ports: Ports, code: str, probe: Awaitable[Any], default: Any) -> Any:
    try:
        return await probe
    except Exception as e:
        ports.log("warn", code, error=str(e))
        return default

async def draft_mode_gate(tool: ToolDef, call: ToolCall, ctx: RunContext, state: RunState, ports: Ports) -> Deny | None:
    if ctx.draft_mode and tool.effect == "write":
        return Deny("best_of_n_draft_readonly", DRAFT_DENY_MESSAGE)
    return None

async def loop_breaker_gate(tool: ToolDef, call: ToolCall, ctx: RunContext, state: RunState, ports: Ports) -> Deny | None:
    if state.call_sig_counts.get(call_signature(tool.full_name, call.args), 0) >= REPEAT_TOOL_CALL_CAP:
        return Deny("repeat_tool_loop_capped", loop_cap_message("same_call", tool.full_name))
    if any(n >= REPEAT_ERROR_CAP for n in state.error_code_counts.values()):
        return Deny("repeat_tool_loop_capped", loop_cap_message("same_error", tool.full_name))
    return None

async def tenant_deny_gate(tool: ToolDef, call: ToolCall, ctx: RunContext, state: RunState, ports: Ports) -> Deny | None:
    reason = await fail_open(
        ports, "tenant_deny_lookup_failed", ports.tool_deny_reason(ctx.tenant_id, ctx.agent_slug, tool.full_name), None
    )
    return Deny("tenant_tool_deny", reason) if reason else None

async def untrusted_inbound_egress_gate(
    tool: ToolDef, call: ToolCall, ctx: RunContext, state: RunState, ports: Ports
) -> Deny | None:
    if ctx.untrusted_inbound and tool.egress:
        return Deny(
            "egress_denied_untrusted_inbound",
            f"EGRESS DENIED: `{tool.full_name}` is blocked on this turn because it was triggered by an UNTRUSTED INBOUND "
            "source (inbound email or GitHub webhook — D2 zero-click-exfil control).",
        )
    return None

async def kill_or_stop_gate(tool: ToolDef, call: ToolCall, ctx: RunContext, state: RunState, ports: Ports) -> Deny | None:
    if await fail_open(ports, "kill_switch_lookup_failed", ports.is_agent_killed(ctx.tenant_id, ctx.agent_slug), False):
        state.killed = True
        return Deny("kill_switch", "kill_switch")
    if await fail_open(ports, "run_stop_lookup_failed", ports.is_run_stopped(ctx.run_id), False):
        state.killed = True
        return Deny("run_cancelled", "run_cancelled")
    return None

GATES: tuple[Gate, ...] = (
    draft_mode_gate,
    loop_breaker_gate,
    tenant_deny_gate,
    untrusted_inbound_egress_gate,
    kill_or_stop_gate,
)
