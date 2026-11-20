import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import {
  linkedinAdsGet,
  linkedinAdsPost,
} from "@/services/connectors/linkedin-ads/http";
import { LINKEDIN_ZAVI_FAULT_CODE, isLinkedinDailyLimit } from "@/services/connectors/linkedin-ads/pause-refused";
import { ExpectedToolError } from "@/services/tools/types";
import { getAccountBinding, getCampaignBinding } from "../bindings";
import { decimalCents } from "../money";
import { readWallet, walletRow } from "../wallet";
import { linkedinBindingToken, resolveLinkedinAccount } from "./linkedin-account";
import { adBudgetIdemKey, commitAdSpend, committedAdHoldIds, releaseAdSpendHolds } from "@/services/decisions/ad-budget";
import { logEvent } from "@/services/logging/logEvent";

const money = z.object({
  amount: z.string(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
});
const campaignSchema = z
  .object({
    id: z.union([z.number().safe().int(), z.string()]).transform(String),
    account: z.string(),
    name: z.string(),
    status: z.string(),
    campaignGroup: z.string(),
    objectiveType: z.string().optional(),
    dailyBudget: money.optional(),
    totalBudget: money.optional(),
    runSchedule: z.object({
      start: z.number().int(),
      end: z.number().int().optional(),
    }),
    changeAuditStamps: z.object({
      created: z.object({ time: z.number().int() }),
      lastModified: z.object({ time: z.number().int() }),
    }),
  })
  .passthrough();
const storage = (tenantId: string) => tenantClient(asTenantId(tenantId));
const LINKEDIN_CAMPAIGN_GONE = "linkedin_ads_campaign_gone";
export async function linkedinCampaign(
  tenantId: string,
  bindingId: string,
  write = false,
  refuseBillingHold = write,
  pauseCritical = false,
  fresh = write,
) {
  const binding = await getCampaignBinding(tenantId, bindingId);
  if (binding.platform !== "linkedin")
    throw new ExpectedToolError(
      "ads_campaign_mismatch",
      "This campaign is not on LinkedIn.",
    );
  const accountBinding = await getAccountBinding(
    tenantId,
    binding.account_binding_id,
  );
  const { token, account } = await resolveLinkedinAccount(
    tenantId,
    accountBinding,
    write,
    refuseBillingHold,
    pauseCritical,
    fresh,
  );
  const path = `adAccounts/${account.id}/adCampaigns/${z
    .string()
    .regex(/^\d{1,20}$/)
    .parse(binding.provider_campaign_id)}`;
  const campaign = campaignSchema.parse(
    await linkedinAdsGet(token, path, {}, {}, pauseCritical ? { pauseCritical: true } : {}).catch((e: unknown) => {
      if (pauseCritical && e instanceof ExpectedToolError && e.meta?.status === 404)
        throw new ExpectedToolError(LINKEDIN_CAMPAIGN_GONE, "LinkedIn no longer has this campaign.", { status: 404 });
      throw e;
    }),
  );
  if (
    campaign.id !== binding.provider_campaign_id ||
    campaign.account !== `urn:li:sponsoredAccount:${account.id}` ||
    [campaign.dailyBudget, campaign.totalBudget].some(
      (b) => b && b.currencyCode !== account.currency,
    )
  )
    throw new ExpectedToolError(
      "ads_campaign_mismatch",
      "Campaign ownership or currency could not be verified.",
    );
  const snapshot = createHash("sha256")
    .update(JSON.stringify(campaign))
    .digest("hex");
  return { binding, accountBinding, token, account, path, campaign, snapshot };
}
const analyticsDay = (d: Date) => ({
  year: d.getUTCFullYear(),
  month: d.getUTCMonth() + 1,
  day: d.getUTCDate(),
});
export async function linkedinLifetimeSpend(
  tenantId: string,
  bindingId: string,
  options: { anyCurrency?: boolean } = {},
) {
  const context = await linkedinCampaign(tenantId, bindingId);
  const { token, account, campaign } = context;
  if (account.currency !== "USD" && !options.anyCurrency)
    throw new ExpectedToolError(
      "ads_currency_unsupported",
      "Shared wallet settlement supports USD accounts only.",
    );
  const created = new Date(campaign.changeAuditStamps.created.time);
  if (
    !Number.isFinite(created.getTime()) ||
    created.getTime() < Date.now() - 10 * 365 * 86400_000 ||
    created.getTime() > Date.now()
  )
    throw new Error("Campaign reporting history is unavailable");
  const report = await linkedinAdsGet<{
    elements?: Array<{ pivotValues?: string[]; costInLocalCurrency?: string }>;
  }>(
    token,
    "adAnalytics",
    {
      q: "analytics",
      pivot: "CAMPAIGN",
      timeGranularity: "ALL",
      dateRange: { start: analyticsDay(created), end: analyticsDay(new Date()) },
      accounts: [`urn:li:sponsoredAccount:${account.id}`],
      campaigns: [`urn:li:sponsoredCampaign:${campaign.id}`],
    },
    { fields: "pivotValues,costInLocalCurrency" },
    { fresh: true },
  );
  if (!Array.isArray(report.elements))
    throw new Error("LinkedIn spend is unavailable");
  if (report.elements.length === 0) return { ...context, cents: 0 };
  if (
    report.elements.length !== 1 ||
    report.elements[0].pivotValues?.length !== 1 ||
    report.elements[0].pivotValues[0] !==
      `urn:li:sponsoredCampaign:${campaign.id}`
  )
    throw new Error("LinkedIn campaign spend is incomplete");
  return {
    ...context,
    cents: decimalCents(report.elements[0].costInLocalCurrency),
  };
}
export type LinkedinPauseOutcome = "paused" | "already_paused" | "ended";
const ENDED_STATUSES = ["COMPLETED", "CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"];
async function recordLinkedinPauseIntent(
  tenantId: string,
  bindingId: string,
): Promise<string> {
  const binding = await getCampaignBinding(tenantId, bindingId);
  if (binding.platform !== "linkedin")
    throw new ExpectedToolError(
      "ads_campaign_mismatch",
      "This campaign is not on LinkedIn.",
    );
  const requestedAt = new Date().toISOString();
  const stop = await storage(tenantId).from("ads_campaign_lifecycle").upsert(
    {
      campaign_binding_id: bindingId,
      tenant_id: tenantId,
      stop_requested_at: requestedAt,
    },
    { onConflict: "tenant_id,campaign_binding_id" },
  );
  if (stop.error) throw new Error("Could not record the pause request");
  return requestedAt;
}
async function readLinkedinPauseIntent(
  tenantId: string,
  bindingId: string,
): Promise<string | null> {
  const stop = await storage(tenantId)
    .from("ads_campaign_lifecycle")
    .select("stop_requested_at")
    .eq("campaign_binding_id", bindingId)
    .maybeSingle();
  if (stop.error) throw new Error("Could not read pause intent");
  return (
    (stop.data as { stop_requested_at: string | null } | null)
      ?.stop_requested_at ?? null
  );
}
export async function pauseLinkedinBoundCampaign(
  tenantId: string,
  bindingId: string,
  recordIntent = true,
): Promise<LinkedinPauseOutcome | null> {
  const requestedAt = recordIntent
    ? await recordLinkedinPauseIntent(tenantId, bindingId)
    : await readLinkedinPauseIntent(tenantId, bindingId);
  if (!requestedAt) return null;
  return applyLinkedinPause(tenantId, bindingId, requestedAt);
}
export const LINKEDIN_PAUSE_SUPERSEDED =
  "This campaign was relaunched while Zavi was pausing it, so Zavi left it running. Pause it again if you still want it stopped.";
export const LINKEDIN_PAUSE_QUEUED =
  "Zavi saved your pause request and will keep retrying it. Check back in a few minutes.";
export const LINKEDIN_PAUSE_ZAVI_FAULT =
  "Zavi could not pause this campaign yet because of a problem on Zavi's side, so it can keep spending on LinkedIn for now. Zavi saved your pause request and keeps retrying it every few minutes. To stop it sooner, pause it in LinkedIn Campaign Manager.";
export const LINKEDIN_PAUSE_DAILY_LIMIT =
  "LinkedIn's daily request limit for this connection is used up, so Zavi could not pause this campaign and it can keep spending until the limit resets at 00:00 UTC (5:30 AM IST). Zavi saved your pause request and retries it then. To stop it sooner, pause it in LinkedIn Campaign Manager.";
export const LINKEDIN_PAUSE_UNCONFIRMED =
  "LinkedIn accepted the pause, but its daily request limit stops Zavi from checking it until 00:00 UTC (5:30 AM IST). Look at the campaign in LinkedIn Campaign Manager to be sure it stopped.";
export const LINKEDIN_PAUSE_DAILY_LIMIT_WALLET =
  "LinkedIn's daily request limit for this connection is used up, so Zavi could not pause this campaign and it can keep spending until the limit resets at 00:00 UTC (5:30 AM IST). Zavi saved your pause request and retries it then. It runs in Zavi's managed ad account, so it can only spend the shared-wallet funds set aside for it.";
export const LINKEDIN_PAUSE_UNCONFIRMED_WALLET =
  "LinkedIn accepted the pause, but its daily request limit stops Zavi from checking it until 00:00 UTC (5:30 AM IST). It runs in Zavi's managed ad account, so Zavi checks it again then for you. It can only spend the shared-wallet funds set aside for it.";
const pauseDailyLimitWords = (fundingSource: unknown) =>
  fundingSource === "wallet" ? LINKEDIN_PAUSE_DAILY_LIMIT_WALLET : LINKEDIN_PAUSE_DAILY_LIMIT;
const pauseUnconfirmedWords = (fundingSource: unknown) =>
  fundingSource === "wallet" ? LINKEDIN_PAUSE_UNCONFIRMED_WALLET : LINKEDIN_PAUSE_UNCONFIRMED;
const RETRIED_PAUSE_FAILURES = ["linkedin_ads_http_error", "linkedin_ads_bad_response"];
export async function requestLinkedinPause(
  tenantId: string,
  bindingId: string,
): Promise<LinkedinPauseOutcome> {
  const requestedAt = await recordLinkedinPauseIntent(tenantId, bindingId);
  let outcome: LinkedinPauseOutcome | null;
  try {
    outcome = await applyLinkedinPause(tenantId, bindingId, requestedAt);
  } catch (e) {
    const busy = e instanceof ExpectedToolError && e.meta?.http_status === 429;
    if (e instanceof ExpectedToolError && e.code === LINKEDIN_ZAVI_FAULT_CODE)
      throw new ExpectedToolError("ads_pause_queued", LINKEDIN_PAUSE_ZAVI_FAULT);
    if (e instanceof ExpectedToolError && !busy && !RETRIED_PAUSE_FAILURES.includes(e.code)) throw e;
    throw new ExpectedToolError("ads_pause_queued", LINKEDIN_PAUSE_QUEUED, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  if (!outcome)
    throw new ExpectedToolError("ads_pause_superseded", LINKEDIN_PAUSE_SUPERSEDED);
  return outcome;
}
async function claimLinkedinPause(
  tenantId: string,
  bindingId: string,
  requestedAt: string,
): Promise<string | null> {
  const prior = Date.parse(requestedAt);
  const claimedAt = new Date(
    Number.isFinite(prior) ? Math.max(Date.now(), prior + 1) : Date.now(),
  ).toISOString();
  const claim = await storage(tenantId)
    .from("ads_campaign_lifecycle")
    .update({ stop_requested_at: claimedAt })
    .eq("campaign_binding_id", bindingId)
    .eq("stop_requested_at", requestedAt)
    .select("campaign_binding_id");
  if (claim.error) throw new Error("Could not confirm the pause request");
  return claim.data?.length ? claimedAt : null;
}
export const LINKEDIN_PAUSE_CHECKING =
  "LinkedIn could not find this campaign just now, so Zavi is checking again. Your pause request is saved and Zavi keeps trying until LinkedIn answers. Check back in a few minutes.";
export function isLinkedinPauseChecking(e: unknown): boolean {
  return e instanceof ExpectedToolError && e.meta?.checking === true;
}
const PAUSE_CLAIM_ATTEMPTS = 3;
async function applyLinkedinPause(
  tenantId: string,
  bindingId: string,
  requestedAt: string,
): Promise<LinkedinPauseOutcome | null> {
  let current = requestedAt;
  for (let attempt = 0; attempt < PAUSE_CLAIM_ATTEMPTS; attempt++) {
    const outcome = await applyLinkedinPauseOnce(tenantId, bindingId, current);
    if (outcome !== "claim_lost") return outcome;
    const latest = await readLinkedinPauseIntent(tenantId, bindingId);
    if (!latest) return null;
    current = latest;
  }
  throw new ExpectedToolError("ads_pause_queued", LINKEDIN_PAUSE_QUEUED);
}
async function readLinkedinCampaignOrGone(tenantId: string, bindingId: string) {
  const gone = (e: unknown) => e instanceof ExpectedToolError && e.code === LINKEDIN_CAMPAIGN_GONE;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const found = await linkedinCampaign(tenantId, bindingId, true, false, true);
      await forgetLinkedin404(tenantId, bindingId).catch(() => undefined);
      return found;
    } catch (e) {
      if (!gone(e)) throw e;
    }
  }
  return null;
}
const LINKEDIN_GONE_GAP_MS = 5 * 60_000;
const LINKEDIN_404_SEEN = "provider_404_seen";
const seen404Rows = (tenantId: string, bindingId: string) =>
  storage(tenantId)
    .from("ads_campaign_operations")
    .select("id,created_at")
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "pause")
    .eq("status", "refused")
    .eq("payload->>reason", LINKEDIN_404_SEEN);
async function linkedin404SeenAt(tenantId: string, bindingId: string): Promise<number | null> {
  const { data, error } = await seen404Rows(tenantId, bindingId);
  if (error) throw new Error("Campaign operation state is unavailable");
  const times = (Array.isArray(data) ? (data as Array<{ created_at?: string }>) : [])
    .map((r) => Date.parse(String(r.created_at)))
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}
async function forgetLinkedin404(tenantId: string, bindingId: string) {
  if ((await linkedin404SeenAt(tenantId, bindingId)) === null) return;
  const forgotten = await storage(tenantId)
    .from("ads_campaign_operations")
    .delete()
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "pause")
    .eq("status", "refused")
    .eq("payload->>reason", LINKEDIN_404_SEEN);
  if (forgotten.error) throw new Error("Could not clear the earlier LinkedIn 404");
}
async function linkedinGoneConfirmed(tenantId: string, bindingId: string): Promise<boolean> {
  if ((await linkedinCampaignGoneAt(tenantId, bindingId)) !== null) return true;
  const seenAt = await linkedin404SeenAt(tenantId, bindingId);
  if (seenAt !== null) return Date.now() - seenAt >= LINKEDIN_GONE_GAP_MS;
  const seen = await storage(tenantId)
    .from("ads_campaign_operations")
    .insert({
      id: randomUUID(),
      tenant_id: tenantId,
      campaign_binding_id: bindingId,
      kind: "pause",
      status: "refused",
      payload: { reason: LINKEDIN_404_SEEN },
    });
  if (seen.error) throw new Error("Could not record the LinkedIn 404");
  return false;
}
async function writeLinkedinStopReceipt(tenantId: string, bindingId: string, requestedAt: string, releaseHolds = true): Promise<boolean> {
  const holds = releaseHolds ? await committedAdHoldIds(tenantId, "linkedin", bindingId) : null;
  const confirmed = await storage(tenantId)
    .from("ads_campaign_lifecycle")
    .update({ stop_confirmed_at: new Date().toISOString() })
    .eq("campaign_binding_id", bindingId)
    .eq("stop_requested_at", requestedAt)
    .select("campaign_binding_id");
  if (confirmed.error)
    throw new Error("LinkedIn pause receipt could not be saved");
  if (!confirmed.data?.length) return false;
  if (holds) await releaseAdSpendHolds(tenantId, "linkedin", bindingId, holds);
  return true;
}
const goneOperations = (tenantId: string) =>
  storage(tenantId)
    .from("ads_campaign_operations")
    .select("campaign_binding_id,created_at,payload")
    .eq("kind", "finalize")
    .eq("status", "succeeded");
async function markLinkedinCampaignGone(tenantId: string, bindingId: string) {
  if ((await linkedinCampaignGoneAt(tenantId, bindingId)) !== null) return;
  const { funding_source } = await getCampaignBinding(tenantId, bindingId);
  const restarted = await storage(tenantId).from("ads_campaign_spend_stability").delete().eq("campaign_binding_id", bindingId);
  if (restarted.error) throw new Error("Could not restart the LinkedIn spend clock");
  const marker = await storage(tenantId)
    .from("ads_campaign_operations")
    .insert({
      id: randomUUID(),
      tenant_id: tenantId,
      campaign_binding_id: bindingId,
      kind: "finalize",
      status: "succeeded",
      payload: funding_source === "wallet" ? { reason: "provider_gone" } : { reason: "provider_gone", recheck: "due" },
    });
  if (marker.error) throw new Error("Could not record that LinkedIn no longer has this campaign");
  await forgetLinkedin404(tenantId, bindingId);
}
export async function unmarkLinkedinCampaignGone(tenantId: string, bindingId: string) {
  await forgetLinkedin404(tenantId, bindingId);
  const undone = await storage(tenantId)
    .from("ads_campaign_operations")
    .update({ status: "refused", updated_at: new Date().toISOString() })
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "finalize")
    .eq("status", "succeeded");
  if (undone.error) throw new Error("Could not clear the record that LinkedIn no longer has this campaign");
}
async function linkedinCampaignGoneAt(tenantId: string, bindingId: string): Promise<number | null> {
  const { data, error } = await goneOperations(tenantId).eq("campaign_binding_id", bindingId);
  if (error) throw new Error("Campaign operation state is unavailable");
  const times = (Array.isArray(data) ? (data as Array<{ created_at: string }>) : []).map((r) => Date.parse(r.created_at));
  return times.length ? Math.min(...times) : null;
}
async function relaunchedSinceGone(tenantId: string, bindingId: string): Promise<boolean> {
  const goneAt = await linkedinCampaignGoneAt(tenantId, bindingId);
  if (goneAt === null) return true;
  const { data, error } = await storage(tenantId)
    .from("ads_campaign_operations")
    .select("created_at,updated_at")
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "activate")
    .eq("status", "succeeded");
  if (error || !Array.isArray(data)) throw new Error("Campaign operation state is unavailable");
  return (data as Array<{ created_at?: string; updated_at?: string }>).some(
    (op) => Date.parse(String(op.created_at)) > goneAt || Date.parse(String(op.updated_at)) > goneAt,
  );
}
export async function recheckGoneLinkedinCampaign(tenantId: string, bindingId: string): Promise<"answered" | "gone"> {
  if (await readLinkedinCampaignOrGone(tenantId, bindingId)) {
    const relaunched = await relaunchedSinceGone(tenantId, bindingId);
    await unmarkLinkedinCampaignGone(tenantId, bindingId);
    if (!relaunched) await pauseLinkedinBoundCampaign(tenantId, bindingId);
    return "answered";
  }
  const holds = await committedAdHoldIds(tenantId, "linkedin", bindingId);
  if (holds) await releaseAdSpendHolds(tenantId, "linkedin", bindingId, holds);
  const done = await storage(tenantId)
    .from("ads_campaign_operations")
    .update({ payload: { reason: "provider_gone", recheck: "done" }, updated_at: new Date().toISOString() })
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "finalize")
    .eq("status", "succeeded");
  if (done.error) throw new Error("Could not record the LinkedIn re-read");
  return "gone";
}
export async function expireLinkedinGoneRecheck(tenantId: string, bindingId: string) {
  const done = await storage(tenantId)
    .from("ads_campaign_operations")
    .update({ payload: { reason: "provider_gone", recheck: "expired" }, updated_at: new Date().toISOString() })
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "finalize")
    .eq("status", "succeeded");
  if (done.error) throw new Error("Could not record the LinkedIn re-read");
}
export async function goneLinkedinCampaignDates(tenantId: string): Promise<Map<string, string>> {
  const { data, error } = await goneOperations(tenantId).range(0, 999);
  if (error || !Array.isArray(data) || data.length === 1000)
    throw new Error("Campaign operation state is unavailable");
  const dates = new Map<string, string>();
  for (const r of data as Array<{ campaign_binding_id: string; created_at: string }>) {
    const day = String(r.created_at).slice(0, 10);
    const known = dates.get(r.campaign_binding_id);
    if (!known || day < known) dates.set(r.campaign_binding_id, day);
  }
  return dates;
}
export async function goneLinkedinCampaignIds(tenantId: string): Promise<Set<string>> {
  return new Set((await goneLinkedinCampaignDates(tenantId)).keys());
}
async function postLinkedinPause(token: string, path: string, fundingSource: unknown) {
  try {
    await linkedinAdsPost(token, path, "PARTIAL_UPDATE", {
      patch: { $set: { status: "PAUSED" } },
    });
  } catch (e) {
    if (isLinkedinDailyLimit(e))
      throw new ExpectedToolError("ads_pause_queued", pauseDailyLimitWords(fundingSource), { daily_limit: true });
    throw e;
  }
}
const pauseUnconfirmed = (fundingSource: unknown) =>
  new ExpectedToolError("ads_pause_queued", pauseUnconfirmedWords(fundingSource), { accepted: true });
async function pauseLinkedinUnread(
  tenantId: string,
  bindingId: string,
  requestedAt: string,
): Promise<"claim_lost"> {
  const binding = await getCampaignBinding(tenantId, bindingId);
  const accountBinding = await getAccountBinding(tenantId, binding.account_binding_id);
  const token = await linkedinBindingToken(tenantId, accountBinding);
  const ids = z.string().regex(/^\d{1,20}$/);
  const path = `adAccounts/${ids.parse(accountBinding.provider_account_id)}/adCampaigns/${ids.parse(binding.provider_campaign_id)}`;
  if (!(await claimLinkedinPause(tenantId, bindingId, requestedAt))) return "claim_lost";
  await postLinkedinPause(token, path, binding.funding_source);
  throw pauseUnconfirmed(binding.funding_source);
}
async function applyLinkedinPauseOnce(
  tenantId: string,
  bindingId: string,
  requestedAt: string,
): Promise<LinkedinPauseOutcome | "claim_lost"> {
  let c: Awaited<ReturnType<typeof readLinkedinCampaignOrGone>>;
  try {
    c = await readLinkedinCampaignOrGone(tenantId, bindingId);
  } catch (e) {
    if (!isLinkedinDailyLimit(e)) throw e;
    return pauseLinkedinUnread(tenantId, bindingId, requestedAt);
  }
  if (!c) {
    if (!(await linkedinGoneConfirmed(tenantId, bindingId)))
      throw new ExpectedToolError("ads_pause_queued", LINKEDIN_PAUSE_CHECKING, { checking: true });
    if (await writeLinkedinStopReceipt(tenantId, bindingId, requestedAt, false))
      await markLinkedinCampaignGone(tenantId, bindingId);
    return "ended";
  }
  const outcome: LinkedinPauseOutcome =
    ENDED_STATUSES.includes(c.campaign.status) ||
    (c.campaign.runSchedule.end != null &&
      c.campaign.runSchedule.end <= Date.now())
      ? "ended"
      : c.campaign.status === "PAUSED"
        ? "already_paused"
        : "paused";
  let receiptAt = requestedAt;
  if (
    c.campaign.status !== "PAUSED" &&
    !ENDED_STATUSES.includes(c.campaign.status)
  ) {
    const claimed = await claimLinkedinPause(tenantId, bindingId, requestedAt);
    if (!claimed) return "claim_lost";
    receiptAt = claimed;
    await postLinkedinPause(c.token, c.path, c.binding.funding_source);
    const after = await linkedinCampaign(tenantId, bindingId, false, false, true).catch((e: unknown) => {
      if (isLinkedinDailyLimit(e)) throw pauseUnconfirmed(c.binding.funding_source);
      throw e;
    });
    if (after.campaign.status !== "PAUSED")
      throw new Error("LinkedIn pause could not be confirmed");
  }
  await writeLinkedinStopReceipt(tenantId, bindingId, receiptAt);
  return outcome;
}
const SETTLED_RECHECK_MS = 3600_000;
const SETTLED_STABLE_MS = 72 * 3600_000;

function stopConfirmedAfter(requested: string | null, confirmed: string | null): boolean {
  if (!requested || !confirmed) return false;
  const r = Date.parse(requested);
  const c = Date.parse(confirmed);
  return Number.isFinite(r) && Number.isFinite(c) && c >= r;
}

async function stopStillStands(tenantId: string, bindingId: string, stopRequested: string | null): Promise<boolean> {
  const launch = await storage(tenantId)
    .from("ads_campaign_operations")
    .select("id")
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "activate")
    .in("status", ["pending", "uncertain"])
    .maybeSingle();
  if (!launch.error && launch.data) return false;
  const life = await storage(tenantId)
    .from("ads_campaign_lifecycle")
    .select("stop_requested_at,stop_confirmed_at")
    .eq("campaign_binding_id", bindingId)
    .maybeSingle();
  if (life.error) return true;
  const row = life.data as { stop_requested_at: string | null } | null;
  return (row?.stop_requested_at ?? null) === stopRequested;
}

async function settledAndQuiet(tenantId: string, bindingId: string): Promise<boolean> {
  const [reservation, stability] = await Promise.all([
    storage(tenantId).from("ads_campaign_reservations").select("reserved_cents").eq("campaign_binding_id", bindingId).maybeSingle(),
    storage(tenantId).from("ads_campaign_spend_stability").select("stable_since,ended_since,last_observed_at").eq("campaign_binding_id", bindingId).maybeSingle(),
  ]);
  if (reservation.error || stability.error || !reservation.data || !stability.data) return false;
  if (Number((reservation.data as { reserved_cents: unknown }).reserved_cents) !== 0) return false;
  const s = stability.data as { stable_since: string | null; ended_since: string | null; last_observed_at: string | null };
  const now = Date.now();
  const at = (v: string | null) => (v ? Date.parse(v) : NaN);
  return (
    at(s.ended_since) <= now - SETTLED_STABLE_MS &&
    at(s.stable_since) <= now - SETTLED_STABLE_MS &&
    at(s.last_observed_at) > now - SETTLED_RECHECK_MS
  );
}

const GONE_UNREAD_LIMIT_MS = SETTLED_STABLE_MS;
type GoneMarker = Record<string, unknown>;
async function readGoneMarker(tenantId: string, bindingId: string): Promise<GoneMarker | null> {
  const { data, error } = await goneOperations(tenantId).eq("campaign_binding_id", bindingId);
  if (error) throw new Error("Campaign operation state is unavailable");
  const [marker] = (Array.isArray(data) ? data : []) as Array<{ payload?: GoneMarker | null }>;
  return marker ? (marker.payload ?? { reason: "provider_gone" }) : null;
}
async function saveGoneMarker(tenantId: string, bindingId: string, payload: GoneMarker) {
  const saved = await storage(tenantId)
    .from("ads_campaign_operations")
    .update({ payload, updated_at: new Date().toISOString() })
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "finalize")
    .eq("status", "succeeded");
  if (saved.error) throw new Error("Could not record the LinkedIn spend read");
}
async function readGoneAnalytics(
  tenantId: string,
  bindingId: string,
  start: Date,
  end: Date,
): Promise<{ accountId: string; cents: number | null } | null> {
  try {
    const binding = await getCampaignBinding(tenantId, bindingId);
    const { token, account } = await resolveLinkedinAccount(tenantId, await getAccountBinding(tenantId, binding.account_binding_id));
    if (account.currency !== "USD") return { accountId: account.id, cents: null };
    const urn = `urn:li:sponsoredCampaign:${binding.provider_campaign_id}`;
    const report = await linkedinAdsGet<{
      elements?: Array<{ pivotValues?: string[]; costInLocalCurrency?: string }>;
    }>(
      token,
      "adAnalytics",
      {
        q: "analytics",
        pivot: "CAMPAIGN",
        timeGranularity: "ALL",
        dateRange: { start: analyticsDay(start), end: analyticsDay(end) },
        accounts: [`urn:li:sponsoredAccount:${account.id}`],
        campaigns: [urn],
      },
      { fields: "pivotValues,costInLocalCurrency" },
      { fresh: true },
    );
    if (!Array.isArray(report.elements)) return null;
    if (report.elements.length === 0) return { accountId: account.id, cents: null };
    const only = report.elements.length === 1 ? report.elements[0] : null;
    if (only?.pivotValues?.length !== 1 || only.pivotValues[0] !== urn) return null;
    return { accountId: account.id, cents: decimalCents(only.costInLocalCurrency) };
  } catch {
    return null;
  }
}
async function linkedinGoneFinalCents(tenantId: string, bindingId: string, recordedSpend: number): Promise<number | null> {
  const read = await readGoneAnalytics(tenantId, bindingId, new Date(Date.now() - 10 * 365 * 86400_000), new Date());
  if (!read) return null;
  return read.cents === null ? recordedSpend : Math.max(recordedSpend, read.cents);
}
export async function linkedinGonePeriodSpend(
  tenantId: string,
  bindingId: string,
  start: Date,
  end: Date,
): Promise<{ account_id: string; cents: number } | null> {
  const marker = await readGoneMarker(tenantId, bindingId);
  if (!marker || marker.settled === true) return null;
  const read = await readGoneAnalytics(tenantId, bindingId, start, end);
  return read && read.cents !== null ? { account_id: read.accountId, cents: read.cents } : null;
}
async function noteGoneSpendUnread(tenantId: string, bindingId: string, marker: GoneMarker, reservedCents: number, noHolds: boolean): Promise<boolean> {
  const since = Date.parse(String(marker.unread_since));
  if (!Number.isFinite(since)) await saveGoneMarker(tenantId, bindingId, { ...marker, unread_since: new Date().toISOString() });
  if (!Number.isFinite(since) || Date.now() - since < GONE_UNREAD_LIMIT_MS) {
    await logEvent({
      level: "warn",
      source: "ads-wallet",
      code: "ads_wallet.gone_final_spend_unread",
      tenant_id: tenantId,
      message: "LinkedIn did not answer the final spend read for a campaign it no longer has. The wallet coverage stays and Zavi reads it again on the next tick.",
    }).catch(() => undefined);
    throw new Error("The final LinkedIn spend read did not answer; the wallet coverage stays and it is read again next tick");
  }
  if (marker.unread_alerted_at) return true;
  const nothingHeld = reservedCents === 0 && noHolds;
  await logEvent({
    level: "error",
    source: "ads-wallet",
    code: "ads_wallet.gone_final_spend_stuck",
    tenant_id: tenantId,
    message: nothingHeld
      ? "LinkedIn has not answered the final spend read for a campaign it no longer has for three days. Nothing stays reserved for it, so Zavi stops reading and any spend LinkedIn did not report is uncharged."
      : "LinkedIn has not answered the final spend read for a campaign it no longer has for three days. The wallet coverage stays reserved until it answers or someone settles it by hand.",
  }).catch(() => undefined);
  if (nothingHeld) {
    await saveGoneMarker(tenantId, bindingId, { ...marker, settled: true, final_spend_unread: true });
    return true;
  }
  const { alertFounderSafely } = await import("@/services/growth/cgo-blockers");
  const told = await alertFounderSafely(tenantId, "LinkedIn final spend unread", [
    {
      id: `stuck:linkedin_final_spend:${bindingId}`,
      kind: "stuck",
      who: "zavi",
      what: `LinkedIn no longer has one of your campaigns and has not told Zavi its final spend, so ${reservedCents > 0 ? `$${(reservedCents / 100).toFixed(2)} stays reserved in your ads wallet` : "its monthly budget stays held"}. It is released once LinkedIn answers`,
      since: new Date(since).toISOString(),
      usd_at_stake: reservedCents / 100,
      at_risk_now: true,
      meanwhile: "Zavi keeps reading it every few minutes",
    },
  ]);
  if (!told) throw new Error("The stuck LinkedIn final spend could not be reported");
  await saveGoneMarker(tenantId, bindingId, { ...marker, unread_alerted_at: new Date().toISOString() });
  return true;
}

async function settleGoneLinkedinCampaign(tenantId: string, bindingId: string): Promise<boolean> {
  const marker = await readGoneMarker(tenantId, bindingId);
  if (!marker) return false;
  if (marker.settled === true) return true;
  const { data, error } = await storage(tenantId)
    .from("ads_campaign_reservations")
    .select("reserved_cents,spent_cents")
    .eq("campaign_binding_id", bindingId)
    .maybeSingle();
  if (error || !data) throw new Error("Campaign coverage is unavailable");
  const row = data as { reserved_cents: unknown; spent_cents: unknown };
  const recordedSpend = Number(row.spent_cents);
  if (!Number.isSafeInteger(recordedSpend)) throw new Error("Campaign coverage is unavailable");
  const reserved = Number(row.reserved_cents);
  const holds = await committedAdHoldIds(tenantId, "linkedin", bindingId);
  const stillThere = await readLinkedinCampaignOrGone(tenantId, bindingId).then(
    (found) => (found ? true : false),
    () => null,
  );
  if (stillThere) {
    await unmarkLinkedinCampaignGone(tenantId, bindingId);
    return false;
  }
  const finalSpend = stillThere === null ? null : await linkedinGoneFinalCents(tenantId, bindingId, recordedSpend);
  if (finalSpend === null) return noteGoneSpendUnread(tenantId, bindingId, marker, reserved, holds?.length === 0);
  if (finalSpend > recordedSpend) {
    const charged = await tenantRpc(asTenantId(tenantId), "ads_wallet_settle_bound", {
      p_campaign_binding_id: bindingId,
      p_spend_cents: finalSpend,
    });
    if (charged.error) throw new Error("Could not settle LinkedIn spend");
  }
  const { unread_since: _since, unread_alerted_at: _alerted, ...answered } = marker;
  if ("unread_since" in marker) await saveGoneMarker(tenantId, bindingId, answered);
  const observed = await tenantRpc(asTenantId(tenantId), "ads_observe_linkedin_spend", {
    p_campaign_binding_id: bindingId,
    p_spend_cents: finalSpend,
    p_ended: true,
  });
  if (observed.error) throw new Error("Campaign spend stability could not be recorded");
  if (observed.data === true && holds) {
    await releaseAdSpendHolds(tenantId, "linkedin", bindingId, holds);
    await saveGoneMarker(tenantId, bindingId, { ...answered, settled: true });
  }
  return true;
}

type WalletPauseCause = "no_limit" | "hold_short" | "overdrawn";
const WALLET_PAUSE_WORDS: Record<WalletPauseCause, (name: string) => string> = {
  no_limit: (name) =>
    `Zavi paused your LinkedIn campaign "${name}" because it has no total budget or no end date, so your ads wallet cannot set aside enough to cover it. Give it a total budget and an end date, then launch it again`,
  hold_short: (name) =>
    `Zavi paused your LinkedIn campaign "${name}" because the money set aside for it in your ads wallet no longer covers its total budget. Add funds to your ads wallet, then launch it again`,
  overdrawn: (name) =>
    `Zavi paused your LinkedIn campaign "${name}" because your ads wallet ran out of money. Add funds to your ads wallet, then launch it again`,
};
async function tellWalletPause(tenantId: string, bindingId: string, cause: WalletPauseCause, name: string) {
  const { alertFounderSafely } = await import("@/services/growth/cgo-blockers");
  await alertFounderSafely(tenantId, "LinkedIn wallet pause", [
    {
      id: `linkedin_wallet_pause:${bindingId}:${cause}`,
      kind: "budget_stop",
      who: "you",
      what: WALLET_PAUSE_WORDS[cause](name.slice(0, 120)),
      since: new Date().toISOString(),
      usd_at_stake: null,
      at_risk_now: false,
      notify_now: true,
      meanwhile: "The campaign is paused and spends nothing until it is launched again",
      channel_slug: "linkedin_ads",
    },
  ]);
}
async function walletOverdrawnUncovered(tenantId: string): Promise<boolean> {
  const w = await readWallet(tenantId);
  if (w.available_cents >= 0) return false;
  return !(await refillCoversOverdraft(tenantId, w));
}
async function refillCoversOverdraft(tenantId: string, w: Awaited<ReturnType<typeof readWallet>>): Promise<boolean> {
  const refill = Number(w.refill_cents);
  if (!w.funding_enabled || !w.auto_refill_enabled || w.last_error) return false;
  if (!w.pending && !(w.available_cents < Number(w.threshold_cents))) return false;
  if (!Number.isSafeInteger(refill) || refill < -w.available_cents) return false;
  try {
    if (!(await walletRow(tenantId)).payment_method_id) return false;
    const { refillEligibility } = await import("../providers");
    return (await refillEligibility(tenantId)) === "allowed";
  } catch {
    return false;
  }
}

export async function settleLinkedinBoundCampaign(
  tenantId: string,
  bindingId: string,
) {
  try {
    await settleLinkedinCampaignTick(tenantId, bindingId);
  } catch (e) {
    if (!isLinkedinPauseChecking(e)) throw e;
  }
}
async function settleLinkedinCampaignTick(tenantId: string, bindingId: string) {
  await reconcileLinkedinOperation(tenantId, bindingId);
  const stop = await storage(tenantId)
    .from("ads_campaign_lifecycle")
    .select("stop_requested_at,stop_confirmed_at")
    .eq("campaign_binding_id", bindingId)
    .maybeSingle();
  if (stop.error) throw new Error("Campaign stop intent is unavailable");
  const stopRow = stop.data as { stop_requested_at: string | null; stop_confirmed_at?: string | null } | null;
  const stopRequested = stopRow?.stop_requested_at ?? null;
  const stopConfirmed = stopConfirmedAfter(stopRequested, stopRow?.stop_confirmed_at ?? null);
  const goneAt = await linkedinCampaignGoneAt(tenantId, bindingId);
  if (goneAt !== null) {
    if (stopRequested && (await settleGoneLinkedinCampaign(tenantId, bindingId))) return;
    if (!stopRequested) await unmarkLinkedinCampaignGone(tenantId, bindingId);
  }
  if ((!stopRequested || stopConfirmed) && (await settledAndQuiet(tenantId, bindingId))) return;
  let zaviPaused = stopConfirmed;
  let pauseFailure: unknown = null;
  let repaused = false;
  if (stopRequested && !stopConfirmed) {
    let outcome: LinkedinPauseOutcome | null = null;
    try {
      outcome = await pauseLinkedinBoundCampaign(tenantId, bindingId, false);
      zaviPaused = outcome !== null;
    } catch (e) {
      if (isLinkedinPauseChecking(e)) throw e;
      pauseFailure = e;
    }
    if (outcome === "ended") {
      const goneNow = await linkedinCampaignGoneAt(tenantId, bindingId);
      if (goneNow !== null && (await settleGoneLinkedinCampaign(tenantId, bindingId))) return;
    }
  }
  const settledHolds = await committedAdHoldIds(tenantId, "linkedin", bindingId);
  let c: Awaited<ReturnType<typeof linkedinLifetimeSpend>>;
  try {
    c = await linkedinLifetimeSpend(tenantId, bindingId);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.meta?.status === 404 && !(await readLinkedinCampaignOrGone(tenantId, bindingId))) {
      if (!(await linkedinGoneConfirmed(tenantId, bindingId))) {
        if ((await readWallet(tenantId)).available_cents < 0) await recordLinkedinPauseIntent(tenantId, bindingId);
        return;
      }
      if (await writeLinkedinStopReceipt(tenantId, bindingId, await recordLinkedinPauseIntent(tenantId, bindingId), false))
        await markLinkedinCampaignGone(tenantId, bindingId);
      await settleGoneLinkedinCampaign(tenantId, bindingId);
      return;
    }
    if ((await readWallet(tenantId)).available_cents < 0)
      await pauseLinkedinBoundCampaign(tenantId, bindingId);
    throw e;
  }
  await forgetLinkedin404(tenantId, bindingId).catch(() => undefined);
  if (c.binding.funding_source !== "wallet")
    throw new Error("Campaign is provider-funded");
  if (stopConfirmed && c.campaign.status === "ACTIVE" && (await stopStillStands(tenantId, bindingId, stopRequested))) {
    repaused = true;
    try {
      zaviPaused =
        (await pauseLinkedinBoundCampaign(tenantId, bindingId, false)) !== null;
    } catch (e) {
      pauseFailure = e;
    }
  }
  const result = await tenantRpc(
    asTenantId(tenantId),
    "ads_wallet_settle_bound",
    { p_campaign_binding_id: bindingId, p_spend_cents: c.cents },
  );
  if (result.error) throw new Error("Could not settle LinkedIn spend");
  if (pauseFailure) throw pauseFailure;
  const { data, error } = await storage(tenantId)
    .from("ads_campaign_reservations")
    .select("reserved_cents,spent_cents")
    .eq("campaign_binding_id", bindingId)
    .maybeSingle();
  if (error || !data) throw new Error("Campaign coverage is unavailable");
  const row = data as { reserved_cents: unknown; spent_cents?: unknown };
  const reserved = Number(row.reserved_cents);
  const recordedSpend = Number(row.spent_cents);
  const charged = Number.isSafeInteger(recordedSpend)
    ? Math.max(recordedSpend, c.cents)
    : c.cents;
  const cap = c.campaign.totalBudget
    ? decimalCents(c.campaign.totalBudget.amount)
    : null;
  const end = c.campaign.runSchedule.end;
  if (c.campaign.status === "ACTIVE" && !repaused) {
    const cause: WalletPauseCause | null =
      cap === null || !end
        ? "no_limit"
        : reserved < Math.max(0, cap - charged)
          ? "hold_short"
          : (await walletOverdrawnUncovered(tenantId))
            ? "overdrawn"
            : null;
    if (cause && (await pauseLinkedinBoundCampaign(tenantId, bindingId)) === "paused")
      await tellWalletPause(tenantId, bindingId, cause, c.campaign.name);
  }
  const ended =
    ["COMPLETED", "CANCELED", "ARCHIVED"].includes(c.campaign.status) ||
    (c.campaign.runSchedule.end != null &&
      c.campaign.runSchedule.end <= Date.now()) ||
    (zaviPaused && c.campaign.status === "PAUSED");
  const observed = await tenantRpc(
    asTenantId(tenantId),
    "ads_observe_linkedin_spend",
    {
      p_campaign_binding_id: bindingId,
      p_spend_cents: c.cents,
      p_ended: ended,
    },
  );
  if (observed.error)
    throw new Error("Campaign spend stability could not be recorded");
  if (observed.data === true && settledHolds)
    await releaseAdSpendHolds(tenantId, "linkedin", bindingId, settledHolds);
}

export async function reconcileLinkedinOperation(
  tenantId: string,
  bindingId: string,
) {
  const operations = await storage(tenantId)
    .from("ads_campaign_operations")
    .select("id,status,created_at")
    .eq("campaign_binding_id", bindingId)
    .in("status", ["pending", "uncertain"])
    .eq("kind", "activate")
    .maybeSingle();
  if (operations.error)
    throw new Error("Campaign operation state is unavailable");
  const operation = operations.data as {
    id: string;
    status: string;
    created_at: string;
  } | null;
  if (!operation || Date.now() - Date.parse(operation.created_at) < 10 * 60_000)
    return;
  const idem_key = adBudgetIdemKey(operation.id, "resume");
  if (operation.status === "pending") {
    const [held, life] = await Promise.all([
      storage(tenantId).from("ad_budget_reservations").select("status").eq("idem_key", idem_key).maybeSingle(),
      storage(tenantId).from("ads_campaign_lifecycle").select("stop_requested_at").eq("campaign_binding_id", bindingId).maybeSingle(),
    ]);
    if (held.error || life.error)
      throw new Error("Campaign operation state is unavailable");
    if (
      (held.data as { status?: string } | null)?.status === "committed" &&
      life.data &&
      (life.data as { stop_requested_at?: string | null }).stop_requested_at == null
    ) {
      const done = await storage(tenantId)
        .from("ads_campaign_operations")
        .update({ status: "succeeded", updated_at: new Date().toISOString() })
        .eq("id", operation.id)
        .eq("status", "pending");
      if (done.error) throw new Error("Could not record the confirmed launch");
      return;
    }
    const unclear = await storage(tenantId)
      .from("ads_campaign_operations")
      .update({ status: "uncertain", updated_at: new Date().toISOString() })
      .eq("id", operation.id)
      .eq("status", "pending");
    if (unclear.error) throw new Error("Could not record the unclear launch");
  }
  await commitAdSpend(
    {
      status: "held",
      tenant_id: tenantId,
      idem_key,
      fresh: false,
    },
    bindingId,
  );
  await pauseLinkedinBoundCampaign(tenantId, bindingId);
  const result = await storage(tenantId)
    .from("ads_campaign_operations")
    .update({ status: "refused", updated_at: new Date().toISOString() })
    .eq("id", operation.id)
    .in("status", ["pending", "uncertain"]);
  if (result.error) throw new Error("Could not record the reconciled pause");
}
