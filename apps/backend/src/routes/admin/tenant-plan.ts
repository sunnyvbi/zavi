
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAudit } from "@/services/staff/audit";
import { tierProTenantsFromBlob } from "@/services/billing/tiers";
import { isLiveStorePlan, managedElsewhereLabel } from "@/services/billing/store-rail";
import { requestPreviewUpgrade } from "@/services/growth/preview-upgrade";
import { logEvent } from "@/services/logging/logEvent";

type Deps = {
  requestPreviewRerun?: (tenantId: string) => Promise<boolean>;
};

const Body = z.discriminatedUnion("tier", [
  z.object({
    tier: z.enum(["starter", "growth", "pro"]),
    months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
    reason: z.string().trim().min(3).max(500),
  }),
  z.object({
    tier: z.literal("free"),
    reason: z.string().trim().min(3).max(500),
  }),
]);

type SubRow = {
  stripe_event_created: number;
  plan: string | null;
  monthly_usd: number | null;
  monthly_credits: number | null;
  tier: string | null;
  status: string | null;
  stripe_subscription_id: string | null;
  source: string | null;
  current_period_end: string | null;
  comp_expires_at: string | null;
  grandfathered: boolean | null;
  credits_revoked_at: string | null;
};

const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function addMonths(from: Date, months: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function makeStaffSetTenantPlan(deps: Deps = {}) {
  const requestPreviewRerun = deps.requestPreviewRerun ?? requestPreviewUpgrade;
  return (req: Request, res: Response) => setTenantPlan(req, res, requestPreviewRerun);
}

export const staffSetTenantPlan = makeStaffSetTenantPlan();

async function setTenantPlan(
  req: Request,
  res: Response,
  requestPreviewRerun: (tenantId: string) => Promise<boolean>,
): Promise<void> {
  const staff = assertStaff(req);
  const tenantId = req.params.tenant_id;
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "invalid body" },
    });
    return;
  }
  const body = parsed.data;
  const sb = staffCrossTenantClient("admin/tenant-plan: staff comp of one tenant's tier");

  const { data: tenant, error: tErr } = await sb.from("tenants").select("id").eq("id", tenantId).maybeSingle();
  if (tErr) {
    res.status(500).json({ error: { code: "tenant_lookup_failed", message: tErr.message } });
    return;
  }
  if (!tenant) {
    res.status(404).json({ error: { code: "tenant_not_found", message: "no such tenant" } });
    return;
  }

  const { data: sub, error: sErr } = await sb
    .from("tenant_subscriptions")
    .select(
      "stripe_event_created, plan, monthly_usd, monthly_credits, tier, status, stripe_subscription_id, source, current_period_end, comp_expires_at, grandfathered, credits_revoked_at",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle<SubRow>();
  if (sErr) {
    res.status(500).json({ error: { code: "subscription_lookup_failed", message: sErr.message } });
    return;
  }

  const isComp = !!sub?.comp_expires_at;
  const refuse = (code: string, message: string) => {
    res.status(409).json({ error: { code, message } });
  };
  if (sub?.grandfathered) return refuse("grandfathered", "tenant is grandfathered on lifetime Full");
  if (body.tier !== "free") {
    const { data: cfg, error: cErr } = await sb.from("system_config").select("blob").eq("id", 1).maybeSingle<{
      blob: Record<string, unknown> | null;
    }>();
    if (cErr) {
      res.status(500).json({ error: { code: "config_read_failed", message: cErr.message } });
      return;
    }
    if (tierProTenantsFromBlob(cfg?.blob ?? null).includes(tenantId)) {
      return refuse("pro_override", "tenant is on the tier_pro_tenants list and already has Pro");
    }
  }
  if (sub?.credits_revoked_at) return refuse("refund_blocked", "tenant's credits were revoked after a refund/dispute");
  if (!isComp && sub?.stripe_subscription_id && sub.status && LIVE_STATUSES.has(sub.status)) {
    return refuse("paying_customer", "tenant has a live Stripe subscription; change it in Stripe");
  }
  if (!isComp && isLiveStorePlan(sub)) {
    return refuse("paying_customer", `tenant has a live subscription billed by ${managedElsewhereLabel(sub)}; change it there`);
  }
  if (!isComp && sub && ((sub.plan ?? "free") !== "free" || sub.monthly_usd != null || sub.monthly_credits != null)) {
    return refuse("not_free", "tenant is on a legacy paid plan, not Free");
  }

  const now = new Date();
  let patch: Record<string, unknown>;
  if (body.tier === "free") {
    if (!isComp) return refuse("not_comped", "tenant is not on a staff-comped plan");
    patch = { tier: null, comp_expires_at: null };
  } else {
    const until = addMonths(now, body.months).toISOString();
    patch = { tier: body.tier, comp_expires_at: until, current_period_end: until };
  }
  patch.updated_at = now.toISOString();

  if (sub) {
    const { data: updated, error: wErr } = await sb
      .from("tenant_subscriptions")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("stripe_event_created", sub.stripe_event_created)
      .is("credits_revoked_at", null)
      .eq("grandfathered", false)
      .select("tenant_id");
    if (wErr) {
      res.status(500).json({ error: { code: "plan_write_failed", message: wErr.message } });
      return;
    }
    if (!updated || updated.length === 0) {
      return refuse("changed_concurrently", "billing changed while saving; reload and try again");
    }
  } else {
    const { error: wErr } = await sb.from("tenant_subscriptions").insert({ tenant_id: tenantId, ...patch });
    if (wErr) {
      if ((wErr as { code?: string }).code === "23505") {
        return refuse("changed_concurrently", "billing changed while saving; reload and try again");
      }
      res.status(500).json({ error: { code: "plan_write_failed", message: wErr.message } });
      return;
    }
  }

  const { error: touchErr } = await sb.rpc("_credit_balance_touch", { p_tenant_id: tenantId });
  if (touchErr) console.warn(`[staff/plan] balance touch failed (plan saved): ${touchErr.message}`);

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: body.tier === "free" ? "tenant.plan_comp_end" : "tenant.plan_comp",
    target_table: "tenant_subscriptions",
    target_id: tenantId,
    tenant_id: tenantId,
    meta: {
      before: sub ? { tier: sub.tier, status: sub.status, comp_expires_at: sub.comp_expires_at } : null,
      after: { tier: patch.tier ?? null, comp_expires_at: patch.comp_expires_at ?? null },
      reason: body.reason,
    },
  });

  let previewRerun: "requested" | "no_previews" | "request_failed" | undefined;
  if (body.tier !== "free") {
    try {
      previewRerun = (await requestPreviewRerun(tenantId)) ? "requested" : "no_previews";
    } catch (e) {
      previewRerun = "request_failed";
      await logEvent({
        level: "warn",
        source: "admin.tenant-plan",
        code: "preview_rerun_request_failed",
        tenant_id: tenantId,
        error: e,
      });
    }
  }

  res.json({
    tenant_id: tenantId,
    tier: (patch.tier as string | null) ?? "free",
    comp_expires_at: (patch.comp_expires_at as string | null) ?? null,
    ...(previewRerun ? { preview_rerun: previewRerun } : {}),
  });
}
