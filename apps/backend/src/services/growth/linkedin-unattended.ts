import type { UnattendedAction, UnattendedVerdict } from "./unattended-policy";
import { linkedinLaunchBody } from "@/services/ads-wallet/linkedin-growth";
import {
  linkedinLaunchObservedCents,
  linkedinLaunchSummary,
  linkedinUsdDrift,
} from "@/services/ads-wallet/linkedin-launch";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { adsUsd } from "@/services/ads-wallet/fx";
import { sharedWalletConsent } from "@/services/ads-wallet/consent";
import { isLinkedInAdsWriteEnabled } from "@/services/tools/linkedin-ads/write/_flag-check";
import { checkAgentTier } from "@/services/agents/entitlement";
import { isChannelLockedStrict } from "@/services/channels/lock";
export function evaluateLinkedinUnattended(f?: {
  reasons: string[];
}): UnattendedVerdict {
  const reasons = f?.reasons ?? ["linkedin_facts_unavailable"];
  return { verdict: reasons.length ? "ask_founder" : "allow", reasons };
}
export async function loadLinkedinUnattended(
  tenantId: string,
  action: Extract<UnattendedAction, { kind: "ad" }>,
  now: Date,
) {
  const reasons: string[] = [];
  try {
    const body = linkedinLaunchBody.parse(action.payload);
    const { readChannelAutorun, loadOpenAdviceForAd } =
      await import("./unattended-policy");
    const { cgoAdBudget } = await import("./cgo-ads");
    if (
      !(await readChannelAutorun(tenantId, "linkedin_ads")) ||
      !(await cgoAdBudget(tenantId, now))
    )
      reasons.push("active_growth_budget_and_autopilot_required");
    if (!(await sharedWalletConsent(tenantId)))
      reasons.push("linkedin_paid_consent_required");
    const tier = await checkAgentTier(tenantId, "linkedin_ads");
    if (
      !tier.enforced ||
      !tier.allowed ||
      (await isChannelLockedStrict("linkedin_ads")) ||
      !(await isLinkedInAdsWriteEnabled())
    )
      reasons.push("channel_unavailable");
    if (body.origin !== "agent") reasons.push("founder_requested_change");
    const advice = await loadOpenAdviceForAd(tenantId, action);
    if (!advice.refsResolved || advice.openAdvice !== "clear")
      reasons.push("open_advice_unresolved");
    if (reasons.length) return { reasons };
    const summary = await linkedinLaunchSummary(
      tenantId,
      body.campaign_binding_id,
    );
    if (
      summary.snapshot !== body.snapshot ||
      summary.currency !== body.currency ||
      summary.status !== "PAUSED" ||
      linkedinUsdDrift(
        adsUsd(body.total_budget_cents / 100, summary.fx),
        body.total_budget_usd,
        summary.currency,
      )
    )
      reasons.push("campaign_changed");
    const life = await tenantClient(asTenantId(tenantId))
      .from("ads_campaign_lifecycle")
      .select("created_paused,activation_attempted_at")
      .eq("campaign_binding_id", body.campaign_binding_id)
      .maybeSingle();
    if (life.error || !life.data) throw new Error("lifecycle unread");
    const lifecycle = life.data as {
      created_paused: boolean;
      activation_attempted_at: string | null;
    };
    const firstLaunch =
      lifecycle.created_paused === true &&
      lifecycle.activation_attempted_at === null &&
      (await linkedinLaunchObservedCents(
        tenantId,
        body.campaign_binding_id,
        summary.funding_source,
      )) === 0;
    if (summary.stop_requested_at || !firstLaunch)
      reasons.push("founder_pause_or_unknown");
    if (
      body.end_time <= now.getTime() ||
      body.end_time > now.getTime() + 366 * 86400000
    )
      reasons.push("campaign_ended_or_archived");
  } catch {
    reasons.push("linkedin_facts_unavailable");
  }
  return { reasons };
}

export type LinkedinPauseFacts = { autoPause: boolean | null };

export async function loadLinkedinPauseUnattended(tenantId: string): Promise<LinkedinPauseFacts> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("tenant_ads_write_caps")
      .select("enabled")
      .eq("tenant_id", tenantId)
      .eq("platform", "linkedin_ads")
      .maybeSingle();
    if (error) return { autoPause: null };
    return { autoPause: (data as { enabled?: boolean } | null)?.enabled === true };
  } catch {
    return { autoPause: null };
  }
}

export function evaluateLinkedinPauseUnattended(f?: LinkedinPauseFacts): UnattendedVerdict {
  if (f?.autoPause === true) return { verdict: "allow", reasons: [] };
  return { verdict: "ask_founder", reasons: [f?.autoPause === false ? "linkedin_autopause_off" : "linkedin_autopause_unreadable"] };
}
