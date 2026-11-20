
import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import { getBoolSetting } from "@/services/settings";
import {
  generateRawMacToken,
  hashMacToken,
} from "@/services/auth/mac-worker-token";

async function tenantExists(id: string): Promise<boolean> {
  const { data } = await serviceClient()
    .from("tenants")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  return !!data;
}

export async function staffLocalLaneGet(
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
    .from("tenant_local_lane")
    .select("enabled, last_drained_at, updated_by, updated_at")
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
        enabled: boolean;
        last_drained_at: string | null;
        updated_by: string | null;
        updated_at: string;
      }
    | null;

  res.json({
    tenant_id: tenantId,
    enabled: row?.enabled ?? false,
    last_drained_at: row?.last_drained_at ?? null,
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
    master_enabled: await getBoolSetting("fleet_local_lane_enabled"),
  });
}

export const SetBody = z.object({
  tenant_id: z.string().uuid(),
  enabled: z.boolean(),
});

export async function staffLocalLaneSet(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const parsed = SetBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { tenant_id, enabled } = parsed.data;

  if (!(await tenantExists(tenant_id))) {
    res
      .status(404)
      .json({ error: { code: "tenant_not_found", message: tenant_id } });
    return;
  }

  const { error } = await serviceClient().rpc("set_tenant_local_lane", {
    p_tenant_id: tenant_id,
    p_enabled: enabled,
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
    action: "local_lane.set",
    target_table: "tenant_local_lane",
    target_id: tenant_id,
    meta: { tenant_id, enabled },
  });

  res.json({ ok: true, tenant_id, enabled });
}

export const EnableBody = z.object({
  tenant_id: z.string().uuid(),
  label: z.string().trim().min(1).max(120).optional(),
});

export async function staffLocalLaneEnable(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const parsed = EnableBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { tenant_id } = parsed.data;

  if (!(await tenantExists(tenant_id))) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenant_id } });
    return;
  }

  const raw = generateRawMacToken();
  const salt = randomBytes(16).toString("hex");
  const hash = hashMacToken(raw, salt);
  const prefix = raw.slice(0, 21);
  const label =
    parsed.data.label?.trim() || `mac one-click ${tenant_id.slice(0, 8)} (${staff.email})`;

  const { data, error } = await serviceClient().rpc("enable_local_lane_for_tenant", {
    p_tenant_id: tenant_id,
    p_label: label,
    p_token_hash: hash,
    p_token_salt: salt,
    p_token_prefix: prefix,
    p_actor_user_id: staff.user_id,
    p_actor_email: staff.email,
  });
  if (error) {
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }
  const token_id = data as string;

  res.json({ ok: true, tenant_id, token_id, raw_token: raw });
}
