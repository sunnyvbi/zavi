
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

const PER_GRANT_CAP = 100000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffCreditGrantsList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/credit-grants: cross-tenant grant audit");

  const [grants, tenants] = await Promise.all([
    sb
      .from("tenant_credit_ledger")
      .select("tenant_id, amount, grant_key, created_at")
      .eq("kind", "grant")
      .order("created_at", { ascending: false })
      .limit(200),
    sb.from("tenants").select("id, slug, display_name, credits_unlimited"),
  ]);

  const nameById = new Map<string, string>();
  const unlimitedTenantIds: string[] = [];
  type TenantRow = { id: string; slug: string; display_name: string | null; credits_unlimited: boolean | null };
  for (const t of (tenants.data ?? []) as TenantRow[]) {
    nameById.set(t.id, t.display_name || t.slug || t.id.slice(0, 8));
    if (t.credits_unlimited) unlimitedTenantIds.push(t.id);
  }

  type Row = { tenant_id: string; amount: number; grant_key: string | null; created_at: string };
  const grantsOut = ((grants.data ?? []) as Row[]).map((g) => ({
    tenant_id: g.tenant_id,
    tenant: nameById.get(g.tenant_id) ?? g.tenant_id.slice(0, 8),
    amount: g.amount,
    grant_key: g.grant_key,
    revoked: (g.grant_key ?? "").endsWith(":revoked"),
    created_at: g.created_at,
  }));

  res.json({ grants: grantsOut, per_grant_cap: PER_GRANT_CAP, unlimited_tenant_ids: unlimitedTenantIds });
}

export async function staffCreditGrant(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const body = (req.body ?? {}) as {
    tenant_id?: unknown;
    amount?: unknown;
    reason?: unknown;
    grant_key?: unknown;
  };

  const tenant_id = String(body.tenant_id ?? "");
  const amount = Number(body.amount);
  const reason = String(body.reason ?? "").trim();
  const grant_key = String(body.grant_key ?? "").trim();

  if (!UUID_RE.test(tenant_id)) {
    res.status(400).json({ error: { code: "invalid_tenant_id", message: "tenant_id must be a UUID" } });
    return;
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > PER_GRANT_CAP) {
    res.status(400).json({
      error: { code: "invalid_amount", message: `amount must be a positive integer ≤ ${PER_GRANT_CAP}` },
    });
    return;
  }
  if (reason.length < 3) {
    res.status(400).json({ error: { code: "invalid_reason", message: "reason is required (≥3 chars)" } });
    return;
  }
  if (grant_key.length < 8) {
    res.status(400).json({ error: { code: "invalid_grant_key", message: "grant_key (idempotency token) required" } });
    return;
  }

  const sb = staffCrossTenantClient("admin/credit-grant: issue promo credits");

  const lookupFailed = () =>
    res.status(503).json({
      error: { code: "tenant_lookup_failed", message: "Could not verify the tenant id; no credits were granted." },
    });
  const { data: tenant, error: tenantErr } = await sb.from("tenants").select("id").eq("id", tenant_id).maybeSingle();
  if (tenantErr) {
    lookupFailed();
    return;
  }
  if (!tenant) {
    const { data: memberships, error: memberErr } = await sb
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", tenant_id);
    if (memberErr) {
      lookupFailed();
      return;
    }
    const ids = ((memberships ?? []) as Array<{ tenant_id: string }>).map((m) => m.tenant_id);
    let message = `No tenant with id ${tenant_id}.`;
    if (ids.length === 1) message = `${tenant_id} is a user id, not a tenant id. That user's tenant is ${ids[0]}.`;
    else if (ids.length > 1)
      message = `${tenant_id} is a user id, not a tenant id. That user belongs to ${ids.length} tenants (${ids.join(", ")}); use the intended one.`;
    res.status(404).json({ error: { code: "tenant_not_found", message } });
    return;
  }

  const { data, error } = await sb.rpc("grant_promo_credits", {
    p_tenant_id: tenant_id,
    p_credits: amount,
    p_reason: reason,
    p_grant_key: grant_key,
    p_actor_email: staff.email,
  });

  if (error) {
    res.status(400).json({ error: { code: "grant_failed", message: error.message } });
    return;
  }
  res.json({ granted: data === true, idempotent_replay: data === false });
}

export async function staffCreditGrantRevoke(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const grant_key = String((req.body ?? {}).grant_key ?? "").trim();
  if (grant_key.length < 8) {
    res.status(400).json({ error: { code: "invalid_grant_key", message: "grant_key required" } });
    return;
  }

  const sb = staffCrossTenantClient("admin/credit-grant/revoke: claw back a grant");
  const { data, error } = await sb.rpc("revoke_promo_credits", {
    p_grant_key: grant_key,
    p_actor_email: staff.email,
  });

  if (error) {
    res.status(400).json({ error: { code: "revoke_failed", message: error.message } });
    return;
  }
  res.json({ revoked: data === true });
}

export async function staffCreditUnlimitedSet(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const body = (req.body ?? {}) as { tenant_id?: unknown; unlimited?: unknown; reason?: unknown };

  const tenant_id = String(body.tenant_id ?? "");
  const reason = String(body.reason ?? "").trim();

  if (!UUID_RE.test(tenant_id)) {
    res.status(400).json({ error: { code: "invalid_tenant_id", message: "tenant_id must be a UUID" } });
    return;
  }
  if (typeof body.unlimited !== "boolean") {
    res.status(400).json({ error: { code: "invalid_unlimited", message: "unlimited must be a boolean" } });
    return;
  }
  if (reason.length < 3) {
    res.status(400).json({ error: { code: "invalid_reason", message: "reason is required (≥3 chars)" } });
    return;
  }

  const sb = staffCrossTenantClient("admin/credit-unlimited: toggle tenant credit exemption");
  const { data, error } = await sb.rpc("set_tenant_credits_unlimited", {
    p_tenant_id: tenant_id,
    p_unlimited: body.unlimited,
    p_reason: reason,
    p_actor_email: staff.email,
  });

  if (error) {
    res.status(400).json({ error: { code: "unlimited_set_failed", message: error.message } });
    return;
  }
  res.json({ unlimited: body.unlimited, changed: data === true });
}
