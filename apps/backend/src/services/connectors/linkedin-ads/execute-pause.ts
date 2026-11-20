
import { z } from "zod";
import { getLinkedInCampaign } from "./client";
import { pauseLinkedInCampaign } from "./write";
import { logLinkedInRefusal } from "./http";
import { isLinkedinDailyLimit, linkedinPauseRefusedCopy, linkedinZaviFaultPauseCopy } from "./pause-refused";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { CampaignBinding } from "@/services/ads-wallet/bindings";

const bodySchema = z.object({
  campaign_id: z.string().regex(/^\d{1,20}$/),
  account_id: z.string().regex(/^\d{1,20}$/),
  status: z.literal("PAUSED"),
  name: z.string().min(1).max(300),
});

export type PauseResult = { ok: boolean; error?: string; code?: string; notice?: string };

const ENDED_STATUSES = new Set(["COMPLETED", "CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"]);
const endedNotice = (b: { name: string; campaign_id: string }) =>
  `LinkedIn shows ${b.name === b.campaign_id ? "this campaign" : `"${b.name}"`} already ended, so there was nothing to pause.`;

const relaunchedNotice = (b: { name: string; campaign_id: string }) =>
  `${b.name === b.campaign_id ? "This campaign" : `"${b.name}"`} was launched again after this pause was suggested, so Zavi left it running and did not pause it. Ask Zavi to pause it again if you still want it stopped.`;

async function relaunchedSinceCard(tenantId: string, actionId: string, bindingId: string): Promise<boolean> {
  const db = tenantClient(asTenantId(tenantId));
  const card = await db.from("channel_actions").select("created_at").eq("id", actionId).maybeSingle();
  const filedAt = Date.parse(String((card.data as { created_at?: string } | null)?.created_at ?? ""));
  if (card.error || !Number.isFinite(filedAt)) return false;
  const ops = await db
    .from("ads_campaign_operations")
    .select("created_at")
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "activate")
    .in("status", ["pending", "uncertain", "succeeded"]);
  if (ops.error || !Array.isArray(ops.data)) return false;
  return (ops.data as Array<{ created_at?: string }>).some((op) => Date.parse(String(op.created_at)) > filedAt);
}

export async function executeLinkedInPause(d: { tenant_id: string; body: unknown; id?: string }): Promise<PauseResult> {
  const p = bodySchema.safeParse(d.body);
  if (!p.success) return { ok: false, code: "linkedin_ads_body_invalid", error: "This pause card is missing details, so Zavi did not change anything. Dismiss it and ask for the pause again." };
  const b = p.data;

  let bound: CampaignBinding | null = null;
  try {
    const { findCampaignBinding } = await import("@/services/ads-wallet/bindings");
    bound = await findCampaignBinding(d.tenant_id, "linkedin", b.campaign_id);
  } catch (e) {
    return { ok: false, code: e instanceof ExpectedToolError ? e.code : "ads_binding_unavailable", error: "The campaign's account could not be verified, so Zavi did not change it." };
  }
  if (bound) {
    let outcome: import("@/services/ads-wallet/adapters/linkedin").LinkedinPauseOutcome;
    try {
      const { getAccountBinding } = await import("@/services/ads-wallet/bindings");
      const account = await getAccountBinding(d.tenant_id, bound.account_binding_id);
      if (account.provider_account_id !== b.account_id) {
        return { ok: false, code: "linkedin_ads_campaign_not_found", error: `Campaign "${b.name}" is no longer in the LinkedIn Ads account on this card.` };
      }
      if (d.id && (await relaunchedSinceCard(d.tenant_id, d.id, bound.id))) return { ok: true, notice: relaunchedNotice(b) };
      const { requestLinkedinPause } = await import("@/services/ads-wallet/adapters/linkedin");
      outcome = await requestLinkedinPause(d.tenant_id, bound.id);
    } catch (e) {
      if (e instanceof ExpectedToolError && e.meta?.accepted === true) return { ok: true, notice: `"${b.name}": ${e.message}`.slice(0, 400) };
      if (e instanceof ExpectedToolError && (e.code === "ads_pause_queued" || e.code === "ads_pause_superseded")) return { ok: false, code: e.code, error: `"${b.name}": ${e.message}`.slice(0, 400) };
      await logLinkedInRefusal(e, { tenantId: d.tenant_id, objectId: b.campaign_id, stage: "pause" });
      const msg = e instanceof ExpectedToolError ? e.message : "LinkedIn Ads did not confirm the pause.";
      return { ok: false, code: e instanceof ExpectedToolError ? e.code : "linkedin_ads_write_failed", error: (linkedinPauseRefusedCopy(e, `"${b.name}"`) ?? `Pause of "${b.name}" failed: ${msg}`).slice(0, 400) };
    }
    if (outcome === "ended") return { ok: true, notice: endedNotice(b) };
    if (outcome === "already_paused") return { ok: true, notice: `"${b.name}" was already paused in LinkedIn Ads.` };
    return { ok: true, notice: `Paused "${b.name}" in LinkedIn Ads.` };
  }

  try {
    const { linkedinAccountStoppable } = await import("./own-accounts");
    if (!(await linkedinAccountStoppable(d.tenant_id, b.account_id)))
      return { ok: false, code: "linkedin_ads_account_not_in_use", error: `The ad account on this card is not used in this workspace, so Zavi did not pause ${b.name === b.campaign_id ? "this campaign" : `"${b.name}"`}.` };
  } catch {
    return { ok: false, code: "ads_binding_unavailable", error: "The campaign's account could not be verified, so Zavi did not change it." };
  }

  let current: { id: string; name: string; status: string | null } | undefined;
  let unread = false;
  try {
    current = (await getLinkedInCampaign(d.tenant_id, b.account_id, b.campaign_id, { pauseCritical: true })) ?? undefined;
    if (!current) current = (await getLinkedInCampaign(d.tenant_id, b.account_id, b.campaign_id, { pauseCritical: true })) ?? undefined;
  } catch (e) {
    unread = isLinkedinDailyLimit(e);
    const msg = e instanceof ExpectedToolError ? e.message : "LinkedIn Ads could not be read.";
    if (!unread) return { ok: false, code: e instanceof ExpectedToolError ? e.code : "linkedin_ads_read_failed", error: linkedinZaviFaultPauseCopy(e, `"${b.name}"`) ?? msg };
  }
  if (!unread && !current) {
    return { ok: false, code: "linkedin_ads_campaign_checking", error: `LinkedIn could not find ${b.name === b.campaign_id ? "this campaign" : `"${b.name}"`} just now, so Zavi did not change anything and cannot say it has stopped. Check it in LinkedIn Campaign Manager, or approve this again in a few minutes.` };
  }
  if (current?.status === "PAUSED") {
    return { ok: true, notice: `"${b.name}" was already paused in LinkedIn Ads.` };
  }
  if (current?.status && ENDED_STATUSES.has(current.status)) {
    return { ok: true, notice: endedNotice(b) };
  }
  if (!unread && current?.status !== "ACTIVE") {
    return { ok: false, code: "linkedin_ads_campaign_not_active", error: `${b.name === b.campaign_id ? "This campaign" : `"${b.name}"`} is not running, so there is nothing to pause.` };
  }

  try {
    await pauseLinkedInCampaign(d.tenant_id, b.account_id, b.campaign_id);
  } catch (e) {
    await logLinkedInRefusal(e, { tenantId: d.tenant_id, objectId: b.campaign_id, stage: "pause" });
    const msg = e instanceof ExpectedToolError ? e.message : "LinkedIn Ads did not confirm the pause.";
    return { ok: false, code: e instanceof ExpectedToolError ? e.code : "linkedin_ads_write_failed", error: (linkedinPauseRefusedCopy(e, `"${b.name}"`) ?? `Pause of "${b.name}" failed: ${msg}`).slice(0, 400) };
  }
  return { ok: true, notice: `Paused "${b.name}" in LinkedIn Ads.` };
}
