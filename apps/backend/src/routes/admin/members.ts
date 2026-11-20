
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { tierFromSubscription } from "@/services/agents/entitlement";
import { tierProTenantsFromBlob } from "@/services/billing/tiers";

type Member = {
  email: string | null;
  name: string | null;
  role: string;
  status: "active" | "invited";
};

type TenantRow = {
  tenant_id: string;
  tenant: string;
  slug: string;
  tier: string | null;
  seats_used: number;
  seat_limit: number | null;
  members: Member[];
};

export async function staffMembers(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/members: cross-tenant staff read-only board");

  const [tuRes, tenantsRes, seatsRes, subsRes, cfgRes, invRes] = await Promise.all([
    sb.from("tenant_users").select("tenant_id, user_id, role").limit(5000),
    sb.from("tenants").select("id, slug, display_name"),
    sb.from("tenant_seat_limits").select("tier, max_seats"),
    sb.from("tenant_subscriptions").select("tenant_id, tier, status, comp_expires_at").limit(5000),
    sb.from("system_config").select("blob").eq("id", 1).maybeSingle<{ blob: Record<string, unknown> | null }>(),
    sb
      .from("tenant_member_invites")
      .select("tenant_id, email, role, invited_at")
      .is("accepted_at", null)
      .is("revoked_at", null)
      .limit(5000),
  ]);

  type Tenant = { id: string; slug: string; display_name: string | null };
  const tenantById = new Map<string, Tenant>();
  for (const t of (tenantsRes.data ?? []) as Tenant[]) tenantById.set(t.id, t);

  type Sub = { tenant_id: string; tier: string | null; status: string | null; comp_expires_at: string | null };
  const subByTenant = new Map<string, Sub>();
  for (const s of (subsRes.data ?? []) as Sub[]) subByTenant.set(s.tenant_id, s);
  const proTenants = new Set(tierProTenantsFromBlob(cfgRes.data?.blob ?? null));
  const billingTier = (id: string) => (proTenants.has(id) ? "pro" : tierFromSubscription(subByTenant.get(id) ?? null));

  const seatByTier = new Map<string, number>();
  for (const s of (seatsRes.data ?? []) as Array<{ tier: string; max_seats: number }>) {
    seatByTier.set(s.tier, s.max_seats);
  }

  const identityById = new Map<string, { email: string | null; name: string | null }>();
  try {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      const users = data?.users ?? [];
      for (const u of users) {
        const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
        identityById.set(u.id, {
          email: u.email ?? null,
          name: (meta.full_name as string) ?? (meta.name as string) ?? null,
        });
      }
      if (users.length < 1000) break;
    }
  } catch {
  }

  const byTenant = new Map<string, TenantRow>();
  const ensure = (tenantId: string): TenantRow => {
    let row = byTenant.get(tenantId);
    if (!row) {
      const t = tenantById.get(tenantId);
      const tier = billingTier(tenantId);
      const cap = seatByTier.get(tier);
      row = {
        tenant_id: tenantId,
        tenant: t?.display_name || t?.slug || tenantId.slice(0, 8),
        slug: t?.slug ?? tenantId.slice(0, 8),
        tier,
        seats_used: 0,
        seat_limit: cap == null || cap < 0 ? null : cap,
        members: [],
      };
      byTenant.set(tenantId, row);
    }
    return row;
  };

  type TU = { tenant_id: string; user_id: string; role: string | null };
  for (const m of (tuRes.data ?? []) as TU[]) {
    const row = ensure(m.tenant_id);
    const id = identityById.get(m.user_id);
    row.members.push({
      email: id?.email ?? null,
      name: id?.name ?? null,
      role: m.role || "member",
      status: "active",
    });
    row.seats_used += 1;
  }

  type Inv = { tenant_id: string; email: string; role: string | null; invited_at: string | null };
  for (const inv of (invRes.data ?? []) as Inv[]) {
    const row = ensure(inv.tenant_id);
    row.members.push({
      email: inv.email ?? null,
      name: null,
      role: inv.role || "member",
      status: "invited",
    });
  }

  const roleRank = (m: Member): number => {
    if (m.status === "invited") return 3;
    if (m.role === "owner") return 0;
    if (m.role === "admin") return 1;
    return 2;
  };
  const tenants = [...byTenant.values()];
  for (const t of tenants) t.members.sort((a, b) => roleRank(a) - roleRank(b));
  tenants.sort((a, b) => b.seats_used - a.seats_used || a.tenant.localeCompare(b.tenant));

  res.json({
    tenants,
    summary: {
      tenants: tenants.length,
      members: tenants.reduce((n, t) => n + t.seats_used, 0),
      invited: tenants.reduce((n, t) => n + t.members.filter((m) => m.status === "invited").length, 0),
    },
  });
}
