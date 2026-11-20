
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Row = {
  tenant_id: string;
  tenant: string;
  slug: string;
  team_name: string | null;
  scopes: number;
  connected_at: string | null;
  token_expires_at: string | null;
  status: "ok" | "expiring" | "expired" | "no_expiry";
};

export async function staffConnectorsHealth(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/connectors-health: cross-tenant staff read-only board");

  const [conns, tenants] = await Promise.all([
    sb
      .from("connector_metadata")
      .select("tenant_id, slug, team_name, scopes, connected_at, token_expires_at")
      .order("connected_at", { ascending: false })
      .limit(1000),
    sb.from("tenants").select("id, slug, display_name"),
  ]);

  const nameById = new Map<string, string>();
  for (const t of (tenants.data ?? []) as Array<{ id: string; slug: string; display_name: string | null }>) {
    nameById.set(t.id, t.display_name || t.slug || t.id.slice(0, 8));
  }

  const now = Date.now();
  const soon = now + 7 * 24 * 60 * 60 * 1000;
  type Conn = {
    tenant_id: string;
    slug: string;
    team_name: string | null;
    scopes: string[] | null;
    connected_at: string | null;
    token_expires_at: string | null;
  };
  const rows: Row[] = ((conns.data ?? []) as Conn[]).map((c) => {
    let status: Row["status"] = "no_expiry";
    if (c.token_expires_at) {
      const exp = new Date(c.token_expires_at).getTime();
      status = exp < now ? "expired" : exp < soon ? "expiring" : "ok";
    }
    return {
      tenant_id: c.tenant_id,
      tenant: nameById.get(c.tenant_id) ?? c.tenant_id.slice(0, 8),
      slug: c.slug,
      team_name: c.team_name,
      scopes: Array.isArray(c.scopes) ? c.scopes.length : 0,
      connected_at: c.connected_at,
      token_expires_at: c.token_expires_at,
      status,
    };
  });

  const rank: Record<Row["status"], number> = { expired: 0, expiring: 1, no_expiry: 2, ok: 3 };
  rows.sort((a, b) => rank[a.status] - rank[b.status]);

  res.json({
    connectors: rows,
    summary: {
      total: rows.length,
      expired: rows.filter((r) => r.status === "expired").length,
      expiring: rows.filter((r) => r.status === "expiring").length,
    },
  });
}
