
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { invalidateCachedTenant } from "@/services/auth/tenant-cache";
import { invalidateTenantDisabledCache } from "@/services/tenants/disabled";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAuditStrict } from "@/services/staff/audit";
import { billingStripe } from "@/services/billing/client";
import { isLiveStorePlan, managedElsewhereLabel } from "@/services/billing/store-rail";
import { resolveMemberEmail, sgSend } from "@/email/sendAuthEmail";
import { renderTenantDisabledEmail } from "@/email/templates/tenant-disabled";
import { logEvent } from "@/services/logging/logEvent";

const Body = z.discriminatedUnion("disabled", [
  z.object({ disabled: z.literal(true), reason: z.string().trim().min(3).max(500) }),
  z.object({ disabled: z.literal(false), reason: z.string().trim().max(500).optional() }),
]);

const LIVE_STRIPE_STATUSES = new Set(["active", "trialing", "past_due"]);

type StripeEffect = {
  result:
    | "no_subscription"
    | "store_plan"
    | "not_configured"
    | "not_live"
    | "set_cancel"
    | "already_cancelling"
    | "resumed"
    | "left_as_customer_set"
    | "not_cancelling"
    | "unknown_prior"
    | "failed";
  subscription_id?: string;
  was_cancel_at_period_end?: boolean;
  schedule_released?: boolean;
};

type SubRow = {
  stripe_subscription_id: string | null;
  status: string | null;
  source: string | null;
};

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

async function applyStripe(
  sb: ReturnType<typeof staffCrossTenantClient>,
  tenantId: string,
  disabled: boolean,
  warnings: string[],
): Promise<StripeEffect> {
  try {
    const { data: row, error } = await sb
      .from("tenant_subscriptions")
      .select("stripe_subscription_id, status, source")
      .eq("tenant_id", tenantId)
      .maybeSingle<SubRow>();
    if (error) throw new Error(error.message);
    if (row && isLiveStorePlan(row)) {
      if (disabled) warnings.push(`The plan is billed through ${managedElsewhereLabel(row)}. Cancel it there; Zavi cannot.`);
      return { result: "store_plan" };
    }
    if (!row?.stripe_subscription_id) return { result: "no_subscription" };
    const stripe = billingStripe();
    if (!stripe) {
      warnings.push("Stripe billing is not configured on this server, so the subscription was not changed.");
      return { result: "not_configured", subscription_id: row.stripe_subscription_id };
    }
    const sub: Stripe.Subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    const base = { subscription_id: sub.id };
    if (!LIVE_STRIPE_STATUSES.has(sub.status)) return { result: "not_live", ...base };

    if (disabled) {
      if (sub.cancel_at_period_end) {
        return { result: "already_cancelling", ...base, was_cancel_at_period_end: true };
      }
      const scheduleId = idOf(sub.schedule as string | { id: string } | null);
      if (scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
      await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
      return { result: "set_cancel", ...base, was_cancel_at_period_end: false, schedule_released: !!scheduleId };
    }

    if (!sub.cancel_at_period_end) return { result: "not_cancelling", ...base };
    const { data: last, error: aErr } = await sb
      .from("staff_audit_log")
      .select("meta")
      .eq("tenant_id", tenantId)
      .eq("action", "tenant.disable")
      .contains("meta", { changed: true })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ meta: { side_effects?: { stripe?: StripeEffect } } | null }>();
    if (aErr) throw new Error(aErr.message);
    const prior = last?.meta?.side_effects?.stripe;
    if (prior?.result === "already_cancelling" || prior?.was_cancel_at_period_end === true) {
      return { result: "left_as_customer_set", ...base };
    }
    if (prior?.result !== "set_cancel" || prior.subscription_id !== sub.id) {
      warnings.push(
        "The subscription is set to cancel, but there is no record that Zavi set it. Left as is; resume it in Stripe if the customer wants to keep paying.",
      );
      return { result: "unknown_prior", ...base };
    }
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    return { result: "resumed", ...base };
  } catch (e) {
    warnings.push(`Stripe update failed: ${(e as Error).message}. Retry, or change the subscription in Stripe.`);
    return { result: "failed" };
  }
}

async function emailOwners(
  ownerIds: string[],
  disabled: boolean,
  workspaceName: string | null,
  warnings: string[],
): Promise<{ sent: number; failed: number; no_address: number }> {
  const out = { sent: 0, failed: 0, no_address: 0 };
  const mail = renderTenantDisabledEmail({ disabled, workspaceName });
  for (const uid of ownerIds) {
    try {
      const to = await resolveMemberEmail(uid);
      if (!to) {
        out.no_address++;
        continue;
      }
      await sgSend(to, mail.subject, mail.html, mail.text);
      out.sent++;
    } catch (e) {
      out.failed++;
      warnings.push(`Owner email failed: ${(e as Error).message}`);
    }
  }
  if (ownerIds.length === 0 || out.sent === 0) {
    warnings.push("No owner email was sent (no owner with an email address, or every send failed).");
  }
  return out;
}

export async function staffSetTenantDisabled(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenantId = req.params.tenant_id;
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: "Send { disabled: true, reason } (reason 3 to 500 characters) or { disabled: false }.",
      },
    });
    return;
  }
  const body = parsed.data;
  const reason = body.reason?.trim() || null;
  const sb = staffCrossTenantClient("admin/tenant-disable: staff disables or re-enables one tenant");

  const { data: before, error: tErr } = await sb
    .from("tenants")
    .select("id, display_name, disabled_at, disabled_reason")
    .eq("id", tenantId)
    .maybeSingle<{ id: string; display_name: string | null; disabled_at: string | null; disabled_reason: string | null }>();
  if (tErr) {
    res.status(500).json({ error: { code: "tenant_query_failed", message: tErr.message } });
    return;
  }
  if (!before) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  const { data: rpcData, error: rpcErr } = await sb.rpc("set_tenant_disabled", {
    p_tenant: tenantId,
    p_disabled: body.disabled,
    p_reason: reason,
    p_actor: staff.user_id,
  });
  if (rpcErr) {
    res.status(500).json({ error: { code: "set_disabled_failed", message: rpcErr.message } });
    return;
  }
  const result = (rpcData ?? {}) as { changed?: boolean; disabled_at?: string | null };
  const changed = result.changed === true;
  const disabledAt = result.disabled_at ?? null;

  const warnings: string[] = [];
  const sideEffects: Record<string, unknown> = {};
  if (changed) {
    invalidateTenantDisabledCache(tenantId);
    let ownerIds: string[] = [];
    try {
      const { data: members, error: mErr } = await sb
        .from("tenant_users")
        .select("user_id, role")
        .eq("tenant_id", tenantId);
      if (mErr) throw new Error(mErr.message);
      const rows = (members ?? []) as Array<{ user_id: string; role: string }>;
      for (const m of rows) invalidateCachedTenant(m.user_id);
      ownerIds = rows.filter((m) => m.role === "owner").map((m) => m.user_id);
      sideEffects.members_invalidated = rows.length;
    } catch (e) {
      warnings.push(`Could not load members to refresh their sessions: ${(e as Error).message}. They see the change within 30 seconds.`);
    }
    sideEffects.stripe = await applyStripe(sb, tenantId, body.disabled, warnings);
    sideEffects.email = await emailOwners(ownerIds, body.disabled, before.display_name, warnings);
  }

  try {
    await writeStaffAuditStrict({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: body.disabled ? "tenant.disable" : "tenant.enable",
      target_table: "tenants",
      target_id: tenantId,
      tenant_id: tenantId,
      meta: {
        reason,
        changed,
        before: { disabled_at: before.disabled_at, disabled_reason: before.disabled_reason },
        after: { disabled_at: body.disabled ? disabledAt : null },
        side_effects: sideEffects,
        warnings,
      },
    });
  } catch (e) {
    await logEvent({
      level: "error",
      source: "admin.tenant-disable",
      code: "audit_failed",
      tenant_id: tenantId,
      message: (e as Error).message,
    });
    res.status(500).json({
      error: {
        code: "audit_failed",
        message: `The workspace was ${body.disabled ? "disabled" : "re-enabled"}, but the audit record failed. Retry to record it.`,
      },
    });
    return;
  }

  res.json({ ok: true, changed, disabled_at: body.disabled ? disabledAt : null, warnings });
}
