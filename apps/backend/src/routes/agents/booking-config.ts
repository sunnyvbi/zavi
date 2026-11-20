
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { getCatalog } from "@/services/tools/operator-db/catalog";
import { getBookingMetricConfig } from "@/services/growth/booking-metrics/config";
import { inngest } from "@/../workers/client";

async function regexCatalogPrefill(tenant_id: string): Promise<Record<string, unknown> | null> {
  try {
    const cat = await getCatalog(tenant_id);
    const b = cat?.hints?.bookings;
    if (cat && b?.table && b?.created_at_field) {
      return {
        engine: cat.dialect,
        booking_source: b.table,
        date_field: b.created_at_field,
        status_field: null,
        completed_statuses: [],
        revenue_field: b.gmv_proxy_field ?? null,
        refund_field: null,
        refund_basis: "none",
        currency: null,
        reporting_timezone: "UTC",
        amount_unit: "dollars",
      };
    }
  } catch {
  }
  return null;
}

async function isMongoOperatorDb(tenant_id: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("tenant_db_config")
    .select("type")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) {
    console.warn(`[booking-config] tenant_db_config read failed for ${tenant_id}: ${error.message}`);
    return false;
  }
  return data?.type === "mongodb";
}

export async function getBookingConfig(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const current = await getBookingMetricConfig(auth.tenant_id);

  if (current) {
    res.json({ config: current, proposed: null, detecting: false });
    return;
  }

  const isPoll = req.query.poll === "1";
  const proposed = await regexCatalogPrefill(auth.tenant_id);
  const canDetect = await isMongoOperatorDb(auth.tenant_id);
  if (canDetect && !isPoll) {
    try {
      await inngest.send({
        name: "booking-mapping.detect.requested",
        data: { tenant_id: auth.tenant_id },
      });
    } catch (e) {
      console.warn(
        `[booking-config] enqueue detect failed for tenant ${auth.tenant_id}: ${(e as Error).message}`,
      );
    }
  }

  res.json({ config: null, proposed, detecting: canDetect });
}

const BodySchema = z.object({
  engine: z.enum(["mongodb", "postgres", "mysql"]),
  booking_source: z.string().min(1).max(128),
  date_field: z.string().min(1).max(128),
  status_field: z.string().max(128).nullable().optional(),
  completed_statuses: z.array(z.string().max(128)).max(64).default([]),
  revenue_field: z.string().max(128).nullable().optional(),
  refund_field: z.string().max(128).nullable().optional(),
  refund_basis: z.enum(["none", "booking_created_net", "refund_event_day"]).default("none"),
  currency: z.string().max(8).nullable().optional(),
  reporting_timezone: z.string().max(64).default("UTC"),
  amount_unit: z.enum(["dollars", "cents"]).default("dollars"),
  confirm: z.boolean().default(false),
});

export async function upsertBookingConfig(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = BodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }
  const b = parsed.data;

  const sb = serverClientFromBearer(auth.access_token);
  const { data, error } = await sb.rpc("upsert_booking_metric_config", {
    p_tenant_id: auth.tenant_id,
    p_engine: b.engine,
    p_booking_source: b.booking_source,
    p_date_field: b.date_field,
    p_status_field: b.status_field ?? null,
    p_completed_statuses: b.completed_statuses,
    p_revenue_field: b.revenue_field ?? null,
    p_refund_field: b.refund_field ?? null,
    p_refund_basis: b.refund_basis,
    p_currency: b.currency ?? null,
    p_reporting_timezone: b.reporting_timezone,
    p_confirm: b.confirm,
    p_amount_unit: b.amount_unit,
  });

  if (error) {
    const forbidden = error.message.includes("not a member");
    res.status(forbidden ? 403 : 400).json({
      error: { code: forbidden ? "not_a_member" : "upsert_failed", message: error.message },
    });
    return;
  }
  res.json({ config: data });
}
