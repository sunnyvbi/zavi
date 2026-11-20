
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Row = {
  tenant_id: string;
  tenant: string;
  team_id: string;
  workspace: string;
  purpose: string;
  is_primary: boolean;
  scopes: number;
  channels: number;
  connected_at: string | null;
};

export async function staffSlackWorkspaces(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/slack-workspaces: cross-tenant staff read-only board");

  const [ws, tenants, channels] = await Promise.all([
    sb
      .from("slack_workspaces")
      .select("tenant_id, team_id, team_name, label, purpose, is_primary, scopes, connected_at")
      .order("connected_at", { ascending: false })
      .limit(1000),
    sb.from("tenants").select("id, slug, display_name"),
    sb.from("slack_channels").select("tenant_id, team_id").limit(50000),
  ]);

  const nameById = new Map<string, string>();
  for (const t of (tenants.data ?? []) as Array<{ id: string; slug: string; display_name: string | null }>) {
    nameById.set(t.id, t.display_name || t.slug || t.id.slice(0, 8));
  }

  const channelCount = new Map<string, number>();
  for (const c of (channels.data ?? []) as Array<{ tenant_id: string; team_id: string }>) {
    const key = `${c.tenant_id}::${c.team_id}`;
    channelCount.set(key, (channelCount.get(key) ?? 0) + 1);
  }

  type Ws = {
    tenant_id: string;
    team_id: string;
    team_name: string | null;
    label: string | null;
    purpose: string | null;
    is_primary: boolean | null;
    scopes: string[] | null;
    connected_at: string | null;
  };
  const rows: Row[] = ((ws.data ?? []) as Ws[]).map((w) => ({
    tenant_id: w.tenant_id,
    tenant: nameById.get(w.tenant_id) ?? w.tenant_id.slice(0, 8),
    team_id: w.team_id,
    workspace: w.label || w.team_name || w.team_id,
    purpose: w.purpose || "general",
    is_primary: w.is_primary === true,
    scopes: Array.isArray(w.scopes) ? w.scopes.length : 0,
    channels: channelCount.get(`${w.tenant_id}::${w.team_id}`) ?? 0,
    connected_at: w.connected_at,
  }));

  rows.sort((a, b) => {
    const t = a.tenant.localeCompare(b.tenant);
    if (t !== 0) return t;
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return a.workspace.localeCompare(b.workspace);
  });

  res.json({
    workspaces: rows,
    summary: {
      total: rows.length,
      tenants: new Set(rows.map((r) => r.tenant_id)).size,
      primary: rows.filter((r) => r.is_primary).length,
    },
  });
}
