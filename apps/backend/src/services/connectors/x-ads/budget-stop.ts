import { asTenantId, tenantClient } from "@/services/tenant-client";
import {
  readAdBudgetMonthView,
  releaseAdSpendForObject,
} from "@/services/decisions/ad-budget";
import { getXCampaign, updateXCampaign, xAdsTenantToken } from "./client";
import { assertXWriteAccess } from "./resources";

export function xBudgetStopReason(facts: {
  active: boolean;
  fresh: boolean;
  complete: boolean;
  remaining: number;
  dailyCapacity: number;
  dailyLimit: number | null;
  daysLeft: number;
}): string | null {
  if (!facts.active) return "The shared ad budget is stopped.";
  if (!facts.fresh || !facts.complete)
    return "Shared spend or capacity could not be verified.";
  if (
    facts.remaining <= 0 ||
    facts.dailyCapacity * Math.max(1, facts.daysLeft) > facts.remaining
  )
    return "Running budgets exceed the remaining monthly spending limit.";
  if (facts.dailyLimit != null && facts.dailyCapacity > facts.dailyLimit)
    return "Running budgets exceed the shared daily spending limit.";
  return null;
}

export async function enforceXBudget(
  tenantId: string,
  now = new Date(),
): Promise<void> {
  const db = tenantClient(asTenantId(tenantId));
  const { data: holds, error: holdError } = await db
    .from("ad_budget_reservations")
    .select("object_id")
    .eq("platform", "x")
    .in("status", ["reserved", "committed"])
    .not("object_id", "is", null)
    .limit(1000);
  if (holdError) throw new Error("Cannot read managed X Ads budget holds.");
  if (!holds?.length) return;
  const view = await readAdBudgetMonthView(tenantId);
  const { data: objects, error } = await db
    .from("ad_campaigns")
    .select("platform,account_id,object_id,campaign_id,status,budget_kind,budget_usd,campaign_budget_usd,as_of")
    .in("status", ["ACTIVE", "ENABLED"])
    .limit(1000);
  const rows = (objects ?? []) as Array<{
    platform: string;
    account_id: string;
    object_id: string;
    campaign_id: string | null;
    status: string;
    budget_kind: string;
    budget_usd: number | null;
    campaign_budget_usd: number | null;
    as_of: string;
  }>;
  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const cboCampaigns = new Map<string, number | null>();
  for (const r of rows) if (r.budget_kind === "campaign_level" && r.campaign_id) cboCampaigns.set(`${r.platform}:${r.campaign_id}`, num(r.campaign_budget_usd));
  const reason = xBudgetStopReason({
    active: view?.status === "active",
    fresh:
      !!view?.actual_read_at &&
      now.getTime() - Date.parse(view.actual_read_at) <= 3 * 3600000 &&
      rows.every((r) => now.getTime() - Date.parse(r.as_of) <= 3 * 3600000),
    complete:
      !error && holds.length < 1000 &&
      rows.length < 1000 &&
      rows.every((r) =>
        r.budget_kind === "campaign_level" && r.platform !== "x"
          ? !!r.campaign_id && num(r.campaign_budget_usd) !== null
          : r.budget_kind === "daily" && num(r.budget_usd) !== null,
      ),
    remaining: view
      ? view.month_cap_usd -
        view.spent_usd -
        view.creator_held_usd -
        view.creator_spent_usd
      : 0,
    dailyCapacity:
      rows.reduce(
        (sum, r) =>
          sum + (r.budget_kind === "daily" ? Number(r.budget_usd ?? 0) * (r.platform === "x" ? 2 : 1) : 0),
        0,
      ) + [...cboCampaigns.values()].reduce<number>((sum, v) => sum + (v ?? 0), 0),
    dailyLimit: view?.daily_limit_usd ?? null,
    daysLeft: view?.days_left ?? 0,
  });
  if (!reason) return;
  const token = await xAdsTenantToken(tenantId);
  const failed: string[] = [];
  const paused: string[] = [];
  for (const id of new Set(
    (holds as Array<{ object_id: string }>).map((h) => h.object_id),
  )) {
    try {
      const lookup = await db
        .from("ad_campaigns")
        .select("account_id")
        .eq("platform", "x")
        .eq("object_id", id)
        .maybeSingle<{ account_id: string }>();
      if (lookup.error || !lookup.data) {
        failed.push(id);
        continue;
      }
      const accountId = lookup.data.account_id;
      await assertXWriteAccess(token, accountId);
      const campaign = await getXCampaign(token, accountId, id);
      if (!campaign || campaign.status === "PAUSED") {
        await releaseAdSpendForObject(tenantId, "x", id);
        continue;
      }
      await updateXCampaign(token, accountId, id, { entity_status: "PAUSED" });
      if ((await getXCampaign(token, accountId, id))?.status !== "PAUSED")
        throw new Error("Pause not confirmed");
      await releaseAdSpendForObject(tenantId, "x", id);
      paused.push(id);
    } catch {
      failed.push(id);
    }
  }
  const { alertFounderSafely } = await import("@/services/growth/cgo-blockers");
  await alertFounderSafely(tenantId, "X Ads budget stop", [
    {
      id: `x-budget-stop:${view?.id ?? tenantId}`,
      kind: "budget_stop",
      what: `${reason} Paused campaigns: ${paused.join(", ") || "none"}. Unconfirmed pauses: ${failed.join(", ") || "none"}.`,
      who: failed.length ? "you" : "zavi",
      since: now.toISOString(),
      usd_at_stake: view?.month_cap_usd ?? null,
      at_risk_now: failed.length > 0,
      meanwhile:
        "Check X Ads Manager for current delivery and delayed charges.",
      channel_slug: "x_ads",
    },
  ]);
  if (failed.length)
    throw new Error(
      `X Ads budget stop could not confirm ${failed.length} campaigns.`,
    );
}
