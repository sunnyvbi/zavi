
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";

export const metaAdsCapsBodySchema = z.object({
  tenant_id: z.string().uuid(),
  enabled: z.boolean(),
  max_daily_budget_usd: z.number().positive().nullable().optional(),
  max_pct_change_per_run: z.number().min(0).max(1).nullable().optional(),
  max_daily_total_change_usd: z.number().positive().nullable().optional(),
});

type CapRow = {
  tenant_id: string;
  platform: string;
  enabled: boolean;
  max_daily_budget_usd: number | null;
  max_pct_change_per_run: number | null;
  max_daily_total_change_usd: number | null;
  updated_at: string;
};

export async function staffMetaAdsCapsGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = String(req.query.tenant_id ?? "");
  const uuidCheck = z.string().uuid().safeParse(tenant_id);
  if (!uuidCheck.success) {
    res.status(400).json({
      error: { code: "bad_request", message: "tenant_id (uuid) required as query param" },
    });
    return;
  }
  const { data, error } = await serviceClient()
    .from("tenant_ads_write_caps")
    .select(
      "tenant_id, platform, enabled, max_daily_budget_usd, max_pct_change_per_run, max_daily_total_change_usd, updated_at",
    )
    .eq("tenant_id", tenant_id)
    .eq("platform", "meta_ads")
    .maybeSingle<CapRow>();
  if (error) {
    res.status(500).json({
      error: { code: "caps_query_failed", message: error.message },
    });
    return;
  }
  res.json({ cap: data ?? null });
}

export async function staffMetaAdsCapsPost(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = metaAdsCapsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }
  const b = parsed.data;

  const svc = serviceClient();
  const { data: before } = await svc
    .from("tenant_ads_write_caps")
    .select("*")
    .eq("tenant_id", b.tenant_id)
    .eq("platform", "meta_ads")
    .maybeSingle<CapRow>();

  const upsertRow = {
    tenant_id: b.tenant_id,
    platform: "meta_ads",
    enabled: b.enabled,
    max_daily_budget_usd: b.max_daily_budget_usd ?? null,
    max_pct_change_per_run: b.max_pct_change_per_run ?? null,
    max_daily_total_change_usd: b.max_daily_total_change_usd ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data: after, error } = await svc
    .from("tenant_ads_write_caps")
    .upsert(upsertRow, { onConflict: "tenant_id,platform" })
    .select()
    .single<CapRow>();
  if (error) {
    res.status(500).json({
      error: { code: "caps_upsert_failed", message: error.message },
    });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "meta_ads_caps_upsert",
    target_table: "tenant_ads_write_caps",
    target_id: b.tenant_id,
    tenant_id: b.tenant_id,
    meta: { before, after },
  });

  res.json({ ok: true, cap: after });
}
