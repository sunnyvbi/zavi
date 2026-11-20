from __future__ import annotations

import json
import logging
from typing import Any, Protocol

from .models import RunContext, ToolCall, ToolDef, ToolResult

logger = logging.getLogger("zavi_runtime")

class Ports(Protocol):
    ledger_enabled: bool

    async def tool_deny_reason(self, tenant_id: str, agent_slug: str, tool: str) -> str | None: ...

    async def is_agent_killed(self, tenant_id: str, agent_slug: str) -> bool: ...

    async def is_run_stopped(self, run_id: str) -> bool: ...

    async def governance_mode(self, tenant_id: str) -> str: ...

    async def effective_autonomy(self, tenant_id: str, decision_class: str) -> str | None: ...

    async def emit_decision(self, ctx: RunContext, decision_class: str, body: dict[str, Any]) -> str | None: ...

    async def ledger_lookup(self, run_id: str, tool_call_id: str) -> ToolResult | None: ...

    async def ledger_claim(self, ctx: RunContext, call: ToolCall, tool: ToolDef, input_hash: str) -> None: ...

    async def ledger_commit(self, run_id: str, tool_call_id: str, result: ToolResult) -> None: ...

    async def write_run_event(self, run_id: str, tenant_id: str, stage: str, meta: dict[str, Any]) -> None: ...

    def log(self, level: str, code: str, **meta: Any) -> None: ...

class SupabasePorts:
    def __init__(self, client: Any, *, ledger_enabled: bool = False):
        self.client = client
        self.ledger_enabled = ledger_enabled

    def _one(self, query: Any) -> dict[str, Any] | None:
        res = query.maybe_single().execute()
        return getattr(res, "data", None) or None

    async def tool_deny_reason(self, tenant_id: str, agent_slug: str, tool: str) -> str | None:
        res = (
            self.client.table("tenant_tool_deny")
            .select("agent_slug, reason")
            .eq("tenant_id", tenant_id)
            .eq("tool_name", tool)
            .in_("agent_slug", [agent_slug, ""])
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", None) or []
        if not rows:
            return None
        row = rows[0]
        scope = "tenant-wide" if row.get("agent_slug") == "" else f"agent {agent_slug}"
        reason = row.get("reason")
        return f"{reason} (scope: {scope})" if reason else f"tool denied by tenant policy (scope: {scope})"

    async def is_agent_killed(self, tenant_id: str, agent_slug: str) -> bool:
        row = self._one(
            self.client.table("tenant_agent_kill_switch")
            .select("agent_slug")
            .eq("tenant_id", tenant_id)
            .eq("agent_slug", agent_slug)
            .eq("override_state", "hidden")
            .eq("source", "staff")
        )
        return row is not None

    async def is_run_stopped(self, run_id: str) -> bool:
        row = self._one(self.client.table("agent_runs").select("stop_requested").eq("id", run_id))
        return bool(row and row.get("stop_requested") is True)

    async def governance_mode(self, tenant_id: str) -> str:
        tenant_row = self._one(
            self.client.table("tenant_app_setting")
            .select("value")
            .eq("tenant_id", tenant_id)
            .eq("key", "governed_chokepoint")
        )
        if tenant_row and tenant_row.get("value") is not None:
            return str(tenant_row["value"])
        global_row = self._one(self.client.table("app_setting").select("value").eq("key", "governed_chokepoint"))
        if global_row and global_row.get("value") is not None:
            return str(global_row["value"])
        return "enforce"

    async def effective_autonomy(self, tenant_id: str, decision_class: str) -> str | None:
        res = self.client.rpc(
            "effective_autonomy", {"p_tenant_id": tenant_id, "p_decision_class": decision_class}
        ).execute()
        data = getattr(res, "data", None)
        return data if isinstance(data, str) else None

    async def emit_decision(self, ctx: RunContext, decision_class: str, body: dict[str, Any]) -> str | None:
        res = self.client.rpc(
            "emit_decision",
            {
                "p_tenant_id": ctx.tenant_id,
                "p_agent_run_id": ctx.run_id,
                "p_decision_class": decision_class,
                "p_body": body,
            },
        ).execute()
        data = getattr(res, "data", None)
        return data if isinstance(data, str) else None

    async def ledger_lookup(self, run_id: str, tool_call_id: str) -> ToolResult | None:
        row = self._one(
            self.client.table("agent_tool_effects")
            .select("result")
            .eq("run_id", run_id)
            .eq("tool_use_id", tool_call_id)
            .eq("status", "committed")
        )
        stored = row.get("result") if row else None
        return ToolResult(**stored) if isinstance(stored, dict) else None

    async def ledger_claim(self, ctx: RunContext, call: ToolCall, tool: ToolDef, input_hash: str) -> None:
        self.client.table("agent_tool_effects").upsert(
            {
                "run_id": ctx.run_id,
                "tenant_id": ctx.tenant_id,
                "tool_use_id": call.tool_call_id,
                "tool_name": tool.full_name,
                "input_hash": input_hash,
                "status": "pending",
            },
            on_conflict="run_id,tool_use_id",
            ignore_duplicates=True,
        ).execute()

    async def ledger_commit(self, run_id: str, tool_call_id: str, result: ToolResult) -> None:
        self.client.table("agent_tool_effects").update(
            {"status": "committed", "result": result.__dict__}
        ).eq("run_id", run_id).eq("tool_use_id", tool_call_id).execute()

    async def write_run_event(self, run_id: str, tenant_id: str, stage: str, meta: dict[str, Any]) -> None:
        self.client.table("agent_run_events").insert(
            {"agent_run_id": run_id, "tenant_id": tenant_id, "stage": stage, "meta": meta}
        ).execute()

    def log(self, level: str, code: str, **meta: Any) -> None:
        logger.log(logging.getLevelName(level.upper()), "%s %s", code, json.dumps(meta, default=str))
