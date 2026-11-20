
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";

async function tenantExists(id: string): Promise<boolean> {
  const { data } = await serviceClient()
    .from("tenants")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  return !!data;
}

export async function staffRetentionPolicyGet(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  const tenantId = String(req.query.tenant_id ?? "");
  if (!tenantId || !(await tenantExists(tenantId))) {
    res
      .status(404)
      .json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  const { data, error } = await serviceClient()
    .from("tenant_retention_policy")
    .select("raw_ttl_days, store_raw, updated_by, updated_at")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) {
    res
      .status(500)
      .json({ error: { code: "read_failed", message: error.message } });
    return;
  }

  const row = data as
    | {
        raw_ttl_days: number | null;
        store_raw: boolean;
        updated_by: string | null;
        updated_at: string;
      }
    | null;

  res.json({
    tenant_id: tenantId,
    raw_ttl_days: row?.raw_ttl_days ?? null,
    store_raw: row?.store_raw ?? true,
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
  });
}

export const SetRetentionBody = z.object({
  tenant_id: z.string().uuid(),
  raw_ttl_days: z.number().int().min(0).max(3650).nullable().optional(),
  store_raw: z.boolean(),
});

export async function staffRetentionPolicySet(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const parsed = SetRetentionBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { tenant_id, raw_ttl_days, store_raw } = parsed.data;

  if (!(await tenantExists(tenant_id))) {
    res
      .status(404)
      .json({ error: { code: "tenant_not_found", message: tenant_id } });
    return;
  }

  const { error } = await serviceClient().rpc("set_tenant_retention_policy", {
    p_tenant_id: tenant_id,
    p_raw_ttl_days: raw_ttl_days ?? null,
    p_store_raw: store_raw,
    p_updated_by: `staff:${staff.email}`,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "retention_policy.set",
    target_table: "tenant_retention_policy",
    target_id: tenant_id,
    meta: { tenant_id, raw_ttl_days: raw_ttl_days ?? null, store_raw },
  });

  res.json({
    ok: true,
    tenant_id,
    raw_ttl_days: raw_ttl_days ?? null,
    store_raw,
  });
}
