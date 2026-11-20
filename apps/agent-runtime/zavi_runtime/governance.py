from __future__ import annotations

from .models import Autonomy, Deny, RunContext, RunState, ToolCall, ToolDef
from .policy import fail_open, kill_or_stop_gate
from .ports import Ports

MODES = ("off", "shadow", "enforce")
AUTONOMIES: tuple[Autonomy, ...] = ("auto", "approval", "forbidden")

CLASS_DEFAULT_AUTONOMY: dict[str, Autonomy] = {
    "slack.teammate_message": "auto",
    "send_email": "approval",
    "create_jira_issue": "approval",
    "jira.add_comment": "approval",
    "linear.create_issue": "approval",
    "linear.add_comment": "approval",
    "raw_open_pr_requires_human": "approval",
    "pr-reviewer.merge-pr": "forbidden",
    "stripe.create_payment": "approval",
    "stripe.remit_to_tenant": "approval",
    "dispute-response.submit-evidence": "approval",
    "stripe.create_connected_account": "approval",
}

async def resolve_mode(ports: Ports, tenant_id: str) -> str:
    mode = await fail_open(ports, "governance_mode_lookup_failed", ports.governance_mode(tenant_id), "enforce")
    return mode if mode in MODES else "enforce"

async def resolve_autonomy(ports: Ports, tenant_id: str, decision_class: str) -> Autonomy:
    fallback = CLASS_DEFAULT_AUTONOMY.get(decision_class, "approval")
    value = await fail_open(ports, "autonomy_lookup_failed", ports.effective_autonomy(tenant_id, decision_class), None)
    return value if value in AUTONOMIES else fallback

async def governance_gate(tool: ToolDef, call: ToolCall, ctx: RunContext, state: RunState, ports: Ports) -> Deny | None:
    decision_class = tool.governance_class
    if decision_class is None:
        return None
    mode = await resolve_mode(ports, ctx.tenant_id)
    if mode == "off":
        return None
    tag = tool.full_name
    if await kill_or_stop_gate(tool, call, ctx, state, ports) is not None:
        return Deny("run_cancelled", f"This action ({tag}) was not sent — the run was stopped before it could fire.")
    marker = ctx.governed_dispatch
    if marker is not None and marker.tool == tag:
        autonomy: Autonomy = "auto"
    else:
        autonomy = await resolve_autonomy(ports, ctx.tenant_id, decision_class)
    if mode == "shadow":
        ports.log("warn", "governance_shadow", tool=tag, decision_class=decision_class, autonomy=autonomy, run_id=ctx.run_id)
        return None
    if autonomy == "auto":
        return None
    if autonomy == "forbidden":
        return Deny("action_forbidden", f"This action ({tag}) is forbidden by your workspace's autonomy policy.")
    try:
        decision_id = await ports.emit_decision(
            ctx, decision_class, {"server_id": tool.server, "tool_name": tool.name, "governed_by": "chokepoint"}
        )
    except Exception:
        return Deny(
            "governance_emit_failed",
            f"This action ({tag}) requires approval but the approval could not be queued; blocked (fail-closed).",
        )
    if decision_id is None:
        return Deny(
            "approval_channel_unavailable",
            f"This action ({tag}) requires approval but no approval channel is available on this run; blocked (fail-closed).",
            {"decision_class": decision_class},
        )
    return Deny(
        "pending_approval",
        f"This action ({tag}) requires approval and has been queued for a human to review.",
        {"decision_id": decision_id, "decision_class": decision_class},
    )
