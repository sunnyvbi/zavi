
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { serviceClient } from "@/services/supabase";
import { teamsEnabled } from "@/services/connectors/teams/adapter";
import { logEvent } from "@/services/logging/logEvent";

export async function teamsStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const configured = teamsEnabled();
  let connected = false;
  if (configured) {
    const { data } = await serviceClient()
      .from("teams_tenants")
      .select("status")
      .eq("tenant_id", auth.tenant_id)
      .eq("status", "enabled")
      .maybeSingle<{ status: string }>();
    connected = !!data;
  }
  res.json({ configured, connected });
}

export async function teamsBind(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!teamsEnabled()) {
    res.status(503).json({ error: { code: "teams_disabled" } });
    return;
  }

  const bindCode = String((req.body as { bind_code?: unknown })?.bind_code ?? "").trim();
  if (!bindCode) {
    res.status(400).json({ error: { code: "missing_bind_code" } });
    return;
  }

  const svc = serviceClient();
  const { data: member } = await svc
    .from("tenant_users")
    .select("role")
    .eq("user_id", auth.user_id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle<{ role: string | null }>();
  if (!member || !["owner", "admin"].includes(String(member.role))) {
    res.status(403).json({ error: { code: "not_admin" } });
    return;
  }

  const { data: status, error } = await svc.rpc("confirm_teams_binding", {
    p_tenant_id: auth.tenant_id,
    p_bind_code: bindCode,
  });
  if (error) {
    console.warn("[teams-bind] confirm_teams_binding failed for tenant", auth.tenant_id, error.message);
    res.status(500).json({ error: { code: "bind_failed" } });
    return;
  }

  switch (String(status)) {
    case "ok":
      await logEvent({
        level: "info",
        source: "connectors.teams.bind",
        code: "teams_bound",
        tenant_id: auth.tenant_id,
        meta: { actor_user_id: auth.user_id },
      }).catch(() => {});
      res.json({ ok: true, connected: true });
      return;
    case "m365_already_bound":
      res.status(409).json({ error: { code: "m365_already_bound" } });
      return;
    case "invalid_or_expired":
    default:
      res.status(410).json({ error: { code: "invalid_or_expired" } });
      return;
  }
}

export async function teamsDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "unset_teams_connection", {});
  if (error) {
    console.warn("[teams-disconnect] unset_teams_connection failed for tenant", auth.tenant_id, error.message);
    res.status(500).json({ error: { code: "disconnect_failed" } });
    return;
  }

  await logEvent({
    level: "info",
    source: "connectors.teams.disconnect",
    code: "teams_disconnected",
    tenant_id: auth.tenant_id,
    meta: { actor_user_id: auth.user_id, removed: Number(data ?? 0) },
  }).catch(() => {});

  res.json({ ok: true, connected: false });
}
