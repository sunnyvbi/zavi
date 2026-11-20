
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Status = "active" | "trialing" | "past_due" | "canceled" | "incomplete";

type Row = {
  tenant_id: string;
  tenant: string;
  slug: string;
  plan: string;
  status: Status;
  grandfathered: boolean;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  credit_balance: number | null;
};

const STATUS_RANK: Record<Status, number> = {
  past_due: 0,
  canceled: 1,
  incomplete: 2,
  trialing: 3,
  active: 4,
};

export async function staffBilling(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/billing: cross-tenant staff read-only board");

  const [subs, balances, tenants] = await Promise.all([
    sb
      .from("tenant_subscriptions")
      .select(
        "tenant_id, plan, status, current_period_end, cancel_at_period_end",
      )
      .limit(5000),
    sb
      .from("tenant_credit_balances")
      .select("tenant_id, included_allowance, included_used, purchased_balance, reserved")
      .limit(5000),
    sb.from("tenants").select("id, slug, display_name"),
  ]);

  type Tenant = { id: string; slug: string | null; display_name: string | null };
  const nameById = new Map<string, string>();
  const slugById = new Map<string, string>();
  for (const t of (tenants.data ?? []) as Tenant[]) {
    nameById.set(t.id, t.display_name || t.slug || t.id.slice(0, 8));
    slugById.set(t.id, t.slug || "");
  }

  type Bal = {
    tenant_id: string;
    included_allowance: number | null;
    included_used: number | null;
    purchased_balance: number | null;
    reserved: number | null;
  };
  const balanceById = new Map<string, number>();
  for (const b of (balances.data ?? []) as Bal[]) {
    const allowance = b.included_allowance ?? 0;
    const used = b.included_used ?? 0;
    const purchased = b.purchased_balance ?? 0;
    const reserved = b.reserved ?? 0;
    balanceById.set(b.tenant_id, allowance - used + purchased - reserved);
  }

  type Sub = {
    tenant_id: string;
    plan: string | null;
    status: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean | null;
  };
  const rows: Row[] = ((subs.data ?? []) as Sub[]).map((s) => {
    const status = (s.status ?? "active") as Status;
    return {
      tenant_id: s.tenant_id,
      tenant: nameById.get(s.tenant_id) ?? s.tenant_id.slice(0, 8),
      slug: slugById.get(s.tenant_id) ?? "",
      plan: s.plan ?? "free",
      status,
      grandfathered: false,
      current_period_end: s.current_period_end,
      cancel_at_period_end: s.cancel_at_period_end ?? false,
      credit_balance: balanceById.has(s.tenant_id)
        ? (balanceById.get(s.tenant_id) as number)
        : null,
    };
  });

  rows.sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.tenant.localeCompare(b.tenant);
  });

  res.json({
    subscriptions: rows,
    summary: {
      total: rows.length,
      past_due: rows.filter((r) => r.status === "past_due").length,
      canceled: rows.filter((r) => r.status === "canceled").length,
      trialing: rows.filter((r) => r.status === "trialing").length,
    },
  });
}
