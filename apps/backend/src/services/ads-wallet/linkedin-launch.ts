import {managedLinkedinEnabled} from "./managed-linkedin";
import { createHash } from "node:crypto";
import { z } from "zod";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_PLAN_UNREAD, linkedinPlanState } from "@/services/connectors/linkedin-ads/plan-check";
import { comingSoonMessage, isChannelLockedStrict } from "@/services/channels/lock";
import { isLinkedInAdsWriteEnabled, LINKEDIN_ADS_WRITES_OFF_MESSAGE } from "@/services/tools/linkedin-ads/write/_flag-check";
import {
  LINKEDIN_ADS_BILLING_HOLD,
  LINKEDIN_ADS_DAILY_LIMIT,
  linkedinAdsGet,
  linkedinAdsPost,
  linkedinOnBillingHold,
  linkedinCreativePath,
  logLinkedInRefusal,
} from "@/services/connectors/linkedin-ads/http";
import {
  linkedinCampaign,
  linkedinLifetimeSpend,
  pauseLinkedinBoundCampaign,
  unmarkLinkedinCampaignGone,
} from "./adapters/linkedin";
import { MANAGED_ACCOUNT_BILLING_HOLD, managedLinkedinNotServingWords } from "./adapters/linkedin-account";
import { campaignDelivery } from "@/services/connectors/linkedin-ads/ad-delivery";
import { requireSharedWalletConsent } from "./consent";
import { fundingEnabled } from "./wallet";
import { adsFx, adsUsd } from "./fx";
import { decimalCents } from "./money";
import { dailyHoldEndsOn, utcStamp } from "@/services/growth/ad-plan-shape";
import { logEvent } from "@/services/logging/logEvent";
import {
  readActiveAdBudget,
  readAdBudgetMonthView,
  reserveAdSpend,
  commitAdSpend,
  dropAdSpendHold,
  adBudgetRefusal,
  adBudgetIdemKey,
  lifetimeDailyUsd,
  budgetMargin,
  type AdSpendHold,
} from "@/services/decisions/ad-budget";
import { adConstraintForPlatform, linkedinLaunchSpend, linkedinMinTotalCents, linkedinMinTotalUsd, linkedinTotalBelowDailyWords } from "@zavi/shared";

export const linkedinLaunchInput = z
  .object({
    request_id: z.string().uuid(),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    total_budget_cents: z.number().int().safe().min(Math.round(linkedinMinTotalUsd() * 100)),
    end_time: z.number().int(),
  })
  .strict();
const id = z.string().regex(/^\d{1,20}$/);
const fail = (message: string): never => {
  throw new ExpectedToolError("ads_launch_conflict", message);
};
const failForGood = (message: string): never => {
  throw new ExpectedToolError("ads_launch_conflict", message, { card_cannot_run: true });
};
export const LINKEDIN_LAUNCH_UNCONFIRMED =
  "This launch may have reached LinkedIn, but Zavi could not confirm it. Zavi tried to pause the campaign to be safe, but it may still be running. Check the campaign in LinkedIn Campaign Manager and pause it there if it is running, then review the launch again. The budget set aside for it stays held until Zavi confirms what happened.";
export const LINKEDIN_LAUNCH_UNCONFIRMED_WALLET =
  "This launch may have reached LinkedIn, but Zavi could not confirm it. Zavi tried to pause the campaign to be safe, but it may still be running. It runs in Zavi's managed ad account, so Zavi keeps checking it and retries the pause every few minutes for you. It can only spend the shared-wallet funds set aside for it, and they stay held until Zavi confirms what happened. Check its status on your LinkedIn Ads page in a few minutes, then review the launch again.";
export const linkedinLaunchUnconfirmedWords = (fundingSource: unknown) =>
  fundingSource === "wallet" ? LINKEDIN_LAUNCH_UNCONFIRMED_WALLET : LINKEDIN_LAUNCH_UNCONFIRMED;
export const LINKEDIN_NOT_FINISHED =
  "This campaign is not finished: it has no ad yet, so Zavi cannot launch it. Finish it on your LinkedIn Ads page first. Your campaign stays paused.";
export const LINKEDIN_ACCOUNT_STOPPED =
  "This ad account is stopped for new campaigns, so Zavi cannot launch on it. Choose Use this account again in Ads account settings to turn it back on. Your campaign stays paused.";
const NOT_ONLY_PAUSED = "Only a paused campaign can be launched here.";
export const LINKEDIN_MIN_RUNWAY_MS = 12 * 3600_000;
export function linkedinEndTimeRefusal(endTime: number, startMs: number, now: number = Date.now()): string | null {
  const after = "Nothing was sent to LinkedIn and your campaign stays paused. Ask Zavi for a new end date, then approve the new card.";
  if (endTime <= now) return `The end date on this launch (${utcStamp(endTime)}) has already passed. ${after}`;
  if (endTime < now + LINKEDIN_MIN_RUNWAY_MS) return `This launch would stop ${utcStamp(endTime)}, less than 12 hours from now. ${after}`;
  if (endTime > now + 366 * 86400_000 || endTime <= startMs) return "Choose an end date within the next year.";
  return null;
}
const BUDGET_REFUSAL_PREFIX = adBudgetRefusal("");
const usdWords = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function linkedinOverDailyWords(day?: { worstUsd: number; limitUsd: number; hasDailyBudget: boolean } | null): string {
  const own = !!day && day.worstUsd > day.limitUsd;
  const figure = day
    ? own
      ? ` It can spend up to ${usdWords(day.worstUsd)} in a day, and the daily limit is ${usdWords(day.limitUsd)}.`
      : ` Together with what your other ads can spend in a day, it would pass the ${usdWords(day.limitUsd)} daily limit.`
    : "";
  const lower = !day || day.hasDailyBudget ? "lower this campaign's daily budget" : "lower the total budget";
  return `This launch would go over the daily limit on your monthly ad budget.${figure} Nothing was sent to LinkedIn. Raise the daily limit on your monthly ad budget on the Growth page, or ${lower}, then try again.`;
}
export function linkedinBudgetRefusalWords(error: string): string {
  const reason = error.startsWith(BUDGET_REFUSAL_PREFIX) ? error.slice(BUDGET_REFUSAL_PREFIX.length) : error;
  if (reason.startsWith("over_month"))
    return "This launch would go over your monthly ad budget. Nothing was sent to LinkedIn. Lower the total budget or raise your monthly ad budget, then try again.";
  if (reason.startsWith("over_daily_limit")) return linkedinOverDailyWords();
  if (reason.startsWith("platform_unread"))
    return reason.includes("Reconnect")
      ? "Zavi could not read your LinkedIn ad spending on its last check, so it cannot tell how much of this month's ad budget is left. Nothing was sent to LinkedIn. Reconnect LinkedIn Ads from Connectors in the left menu, then try again."
      : "Zavi could not read your LinkedIn ad spending on its last check, so it cannot tell how much of this month's ad budget is left. Nothing was sent to LinkedIn. Try again after the next hourly check.";
  if (reason.startsWith("object_busy"))
    return "Another change to this campaign is still finishing. Nothing was sent to LinkedIn. Try again in a minute.";
  if (reason.startsWith("over_projection"))
    return "This month's ad spending is on track to go over your monthly ad budget, so this launch was not sent to LinkedIn. Open the launch and approve it yourself to go ahead.";
  if (reason.startsWith("unavailable"))
    return "Zavi could not check your monthly ad budget just now. Nothing was sent to LinkedIn. Try again in a minute.";
  return "Your monthly ad budget did not allow this launch. Nothing was sent to LinkedIn. Check your monthly ad budget, then try again.";
}
const refuseBudget = (error: string, words?: string): never => {
  throw new ExpectedToolError("ads_launch_conflict", words ?? linkedinBudgetRefusalWords(error), { budget_refusal: error });
};
const LINKEDIN_CLEAN_REFUSALS = new Set(["linkedin_ads_write_refused", "linkedin_ads_token_revoked", "linkedin_ads_forbidden"]);
const LINKEDIN_NOT_HELD = "Nothing changed in LinkedIn and nothing was held.";
function linkedinSaysTotalBelowDaily(reason: unknown): boolean {
  if (typeof reason !== "string" || !/total\s*budget/i.test(reason)) return false;
  return /daily\s*budget/i.test(reason) || /CONDITIONAL_VALUE_TOO_LOW/.test(reason);
}
function linkedinFirstWriteRefusal(e: ExpectedToolError): ExpectedToolError {
  const status = e.meta?.http_status;
  if (e.code !== "linkedin_ads_write_refused" || status === 402 || status === 429 || e.meta?.billing_hold)
    return new ExpectedToolError(e.code, `${e.message} ${LINKEDIN_NOT_HELD}`, e.meta);
  if (linkedinSaysTotalBelowDaily(e.meta?.linkedin_reason))
    return new ExpectedToolError(
      e.code,
      `LinkedIn does not accept a total budget below the campaign's daily budget. Check the daily budget in LinkedIn Campaign Manager, then review the launch again. ${LINKEDIN_NOT_HELD}`,
      { ...e.meta, card_cannot_run: true },
    );
  return new ExpectedToolError(e.code, `LinkedIn did not accept this total budget or end date. ${LINKEDIN_NOT_HELD} Check both, then try again.`, e.meta);
}
const LINKEDIN_NOT_SWITCHED_ON = "LinkedIn did not let Zavi switch this campaign on, so it stays paused and cannot spend.";
function linkedinSwitchOnRefusal(e: ExpectedToolError, partlyOn: boolean): ExpectedToolError {
  const status = e.meta?.http_status;
  const named = e.code !== "linkedin_ads_write_refused" || status === 402 || status === 429 || !!e.meta?.billing_hold;
  const kept = partlyOn
    ? "LinkedIn kept this launch's new total budget and end date and switched on some of its ads or its campaign group, but none of them can spend while the campaign is paused."
    : "LinkedIn kept this launch's new total budget and end date, but they cannot spend anything while the campaign is paused.";
  return new ExpectedToolError(
    e.code,
    `${LINKEDIN_NOT_SWITCHED_ON} ${named ? `${e.message} ` : ""}${kept} Nothing is held for this launch.${named ? "" : " Try again in a few minutes."}`,
    e.meta,
  );
}
const LINKEDIN_RECONNECT_REFUSALS = new Set(["linkedin_ads_token_revoked", "linkedin_ads_forbidden"]);
export const LINKEDIN_MANAGED_WRITE_FORBIDDEN =
  "LinkedIn did not let Zavi change this campaign in Zavi's managed LinkedIn ad account. This is on Zavi's side, and there is nothing you need to fix, ask for or reconnect. Try again later.";
function managedWriteRefusal(e: ExpectedToolError, wallet: boolean): ExpectedToolError {
  if (!wallet || e.code !== "linkedin_ads_forbidden") return e;
  return new ExpectedToolError(e.code, LINKEDIN_MANAGED_WRITE_FORBIDDEN, e.meta);
}
export function linkedinLaunchNotSentError(e: unknown): boolean {
  if (!(e instanceof ExpectedToolError) || e.meta?.outcome_unknown) return false;
  return e.code === "ads_launch_not_sent" || LINKEDIN_RECONNECT_REFUSALS.has(e.code);
}
function spendUnread(e: unknown): never {
  if (!(e instanceof ExpectedToolError))
    throw new ExpectedToolError("ads_launch_conflict", "Zavi could not read this campaign's spending from LinkedIn just now. Nothing was sent to LinkedIn, and nothing was held or spent. Try again in a few minutes.");
  if (!e.code.startsWith("linkedin_ads_")) throw e;
  const words = `${e.message} Nothing was sent to LinkedIn, and nothing was held or spent.`;
  if (LINKEDIN_RECONNECT_REFUSALS.has(e.code)) throw new ExpectedToolError(e.code, words, e.meta);
  throw new ExpectedToolError(
    "ads_launch_conflict",
    LINKEDIN_CLEAN_REFUSALS.has(e.code) || e.message === LINKEDIN_ADS_DAILY_LIMIT
      ? words
      : "Zavi could not read this campaign's spending from LinkedIn just now. Nothing was sent to LinkedIn, and nothing was held or spent. Try again in a few minutes.",
    e.meta,
  );
}
export const LINKEDIN_FX_TOLERANCE_PCT = 2;
const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const accountMoney = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
export function linkedinUsdDrift(
  usd: number,
  approvedUsd: number,
  currency: string,
): string | null {
  const now = Math.round(usd * 100),
    approved = Math.round(approvedUsd * 100);
  if (currency === "USD")
    return now === approved ? null : "Campaign or currency changed. Review it again.";
  if (now * 100 <= approved * (100 + LINKEDIN_FX_TOLERANCE_PCT)) return null;
  return `The exchange rate moved since this launch was approved, so it now comes to ${dollars(now)}, more than ${LINKEDIN_FX_TOLERANCE_PCT}% above the ${dollars(approved)} approved. Nothing was sent to LinkedIn. Review the launch again.`;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).sort().join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const moneyCents = (m: { amount: string } | undefined) => (m ? decimalCents(m.amount) : null);
export function linkedinTotalBelowDailyRefusal(
  totalCents: number,
  dailyCents: number | null,
  currency: string,
  unitsPerUsd: number,
): string | null {
  if (dailyCents === null || totalCents >= dailyCents) return null;
  return linkedinTotalBelowDailyWords(dailyCents, linkedinMinTotalCents(currency, unitsPerUsd), currency);
}
export function linkedinLaunchSnapshot(t: {
  campaign: { id: string; account: string; campaignGroup: string; name: string; dailyBudget?: { amount: string }; [k: string]: unknown };
  currency: string;
  group: { id: number | string; account: string };
  creatives: Array<{ rawId: string; campaign: string; content?: unknown }>;
  stop_requested_at: string | null;
}): string {
  const c = t.campaign;
  return createHash("sha256")
    .update(
      canonicalJson({
        campaign: {
          id: c.id,
          account: c.account,
          group: c.campaignGroup,
          name: c.name,
          page: c.associatedEntity,
          type: c.type,
          objective: c.objectiveType,
          cost_type: c.costType,
          optimization: c.optimizationTargetType,
          daily_budget_cents: moneyCents(c.dailyBudget),
          bid_cents: moneyCents(c.unitCost as { amount: string } | undefined),
          locale: c.locale,
          targeting: c.targetingCriteria,
          audience_expansion: c.audienceExpansionEnabled,
          offsite_delivery: c.offsiteDeliveryEnabled,
          creative_selection: c.creativeSelection,
          political_intent: c.politicalIntent,
        },
        currency: t.currency,
        group: { id: String(t.group.id), account: t.group.account },
        ads: t.creatives.map((a) => ({ id: a.rawId, campaign: a.campaign, content: a.content })),
        stop_requested_at: t.stop_requested_at,
      }),
    )
    .digest("hex");
}
export function linkedinWorstDayUsd(remainingUsd: number, dailyBudgetUsd: number | null): number {
  const factor = adConstraintForPlatform("linkedin")?.hold_factor ?? 1;
  return lifetimeDailyUsd(dailyBudgetUsd === null ? remainingUsd : Math.min(remainingUsd, dailyBudgetUsd * factor), 1, 1);
}
async function launchTree(tenantId: string, bindingId: string, fresh: boolean) {
  const c = await linkedinCampaign(tenantId, bindingId, true, true, false, fresh);
  const fx = await adsFx(c.account.currency);
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_lifecycle")
    .select("provider_group_id,provider_creative_ids,stop_requested_at")
    .eq("campaign_binding_id", bindingId)
    .maybeSingle();
  if (error || !data)
    return fail(
      "Zavi could not confirm which ads belong to this campaign, so it cannot launch it. Your campaign stays paused.",
    );
  const parsedLifecycle = z
    .object({
      provider_group_id: id,
      provider_creative_ids: z.array(id).min(1).max(100),
      stop_requested_at: z.string().nullable(),
    })
    .safeParse(data);
  if (!parsedLifecycle.success) return fail(LINKEDIN_NOT_FINISHED);
  const lifecycle = parsedLifecycle.data;
  const stopped = await tenantClient(asTenantId(tenantId))
    .from("ads_account_binding_status")
    .select("disabled_at")
    .eq("account_binding_id", c.binding.account_binding_id)
    .maybeSingle();
  if (stopped.error)
    return fail("Zavi could not check whether this ad account is still on, so it cannot launch this campaign. Your campaign stays paused. Try again in a minute.");
  const accountStopped = !!(stopped.data as { disabled_at?: string | null } | null)?.disabled_at;
  if (
    c.campaign.campaignGroup !==
    `urn:li:sponsoredCampaignGroup:${lifecycle.provider_group_id}`
  )
    return failForGood("The campaign group changed. Review it again.");
  const base = `adAccounts/${c.account.id}`;
  const group = await linkedinAdsGet<{
    id: number | string;
    account: string;
    status: string;
  }>(c.token, `${base}/adCampaignGroups/${lifecycle.provider_group_id}`);
  if (
    String(group.id) !== lifecycle.provider_group_id ||
    group.account !== c.campaign.account
  )
    return fail("The campaign group ownership could not be verified.");
  const creatives = await Promise.all(
    lifecycle.provider_creative_ids.map(async (creativeId) => {
      const creative = await linkedinAdsGet<{
        id: string | number;
        campaign: string;
        intendedStatus: string;
        servingHoldReasons?: string[];
        isServing?: boolean;
        review?: { status?: string };
        content?: unknown;
      }>(c.token, linkedinCreativePath(c.account.id, creativeId));
      if (
        String(creative.id).replace(/^urn:li:sponsoredCreative:/, "") !==
          creativeId ||
        creative.campaign !== `urn:li:sponsoredCampaign:${c.campaign.id}`
      )
        return fail("An ad no longer belongs to this campaign.");
      return { ...creative, rawId: creativeId };
    }),
  );
  const siblings = await linkedinAdsGet<{
    elements?: Array<{ id: number | string; campaignGroup: string }>;
    metadata?: { nextPageToken?: string };
  }>(c.token, `${base}/adCampaigns`, {
    q: "search",
    pageSize: 100,
    search: {
      campaignGroup: {
        values: [
          `urn:li:sponsoredCampaignGroup:${lifecycle.provider_group_id}`,
        ],
      },
    },
  });
  if (
    !Array.isArray(siblings.elements) ||
    siblings.metadata?.nextPageToken ||
    siblings.elements.length !== 1 ||
    String(siblings.elements[0].id) !== c.campaign.id
  )
    return fail(
      "Review this group in LinkedIn: it contains campaigns outside this launch.",
    );
  const snapshot = linkedinLaunchSnapshot({
    campaign: c.campaign,
    currency: fx.currency,
    group,
    creatives,
    stop_requested_at: lifecycle.stop_requested_at,
  });
  return { ...c, lifecycle, group, creatives, snapshot, base, fx, accountStopped };
}
const NOT_SERVING: Array<[string, string, string]> = [
  ["STOPPED", "LinkedIn has stopped the ad account from running ads", "Check the account's status in LinkedIn Campaign Manager, then review the launch again."],
  ["ACCOUNT_TOTAL_BUDGET_HOLD", "the ad account has used up the total budget set on it in LinkedIn", "Raise or remove the account's total budget in LinkedIn Campaign Manager, then review the launch again."],
  ["ACCOUNT_END_DATE_HOLD", "the end date set on the ad account in LinkedIn has passed", "Move or remove the account's end date in LinkedIn Campaign Manager, then review the launch again."],
  ["RESTRICTED_HOLD", "LinkedIn has restricted the ad account", "Open LinkedIn Campaign Manager to read LinkedIn's notice about it, or contact LinkedIn support."],
  ["INTERNAL_HOLD", "LinkedIn is holding the ad account on its side", "This usually clears on its own. Try again later, and contact LinkedIn support if it stays."],
];
const ACCOUNT_NOT_ACTIVE: Record<string, [string, string]> = {
  DRAFT: ["the ad account is not fully set up in LinkedIn yet", "Finish setting it up in LinkedIn Campaign Manager, including a payment method, then review the launch again."],
  CANCELED: ["the ad account is closed in LinkedIn", "Choose another ad account in Ads account settings."],
  PENDING_DELETION: ["the ad account is being closed in LinkedIn", "Choose another ad account in Ads account settings."],
  REMOVED: ["the ad account is closed in LinkedIn", "Choose another ad account in Ads account settings."],
};
const NOT_SERVING_FALLBACK: [string, string] = ["LinkedIn says the ad account cannot run ads right now", "Check the account in LinkedIn Campaign Manager, then review the launch again."];
export function linkedinAccountNotServingWords(
  account: { status: string; servingStatuses?: readonly string[] },
  fundingSource: unknown,
): string | null {
  const wallet = fundingSource === "wallet";
  if (linkedinOnBillingHold(account.servingStatuses)) return wallet ? `${MANAGED_ACCOUNT_BILLING_HOLD} Your campaign stays paused.` : LINKEDIN_ADS_BILLING_HOLD;
  const statuses = account.servingStatuses ?? [];
  if (account.status === "ACTIVE" && statuses.length === 1 && statuses[0] === "RUNNABLE") return null;
  const [reason, step] =
    account.status !== "ACTIVE"
      ? ACCOUNT_NOT_ACTIVE[account.status] ?? NOT_SERVING_FALLBACK
      : (NOT_SERVING.find(([code]) => statuses.includes(code))?.slice(1) as [string, string] | undefined) ?? NOT_SERVING_FALLBACK;
  if (wallet) return `${managedLinkedinNotServingWords(reason)} Your campaign stays paused.`;
  return `This campaign cannot launch because ${reason}. ${step} Nothing was sent to LinkedIn and your campaign stays paused.`;
}
function launchStateRefusal(tree: Awaited<ReturnType<typeof launchTree>>): string | null {
  if (tree.campaign.status !== "PAUSED" || !["DRAFT", "PAUSED", "ACTIVE"].includes(tree.group.status))
    return NOT_ONLY_PAUSED;
  if (tree.accountStopped) return LINKEDIN_ACCOUNT_STOPPED;
  const notServing = linkedinAccountNotServingWords(tree.account, tree.binding.funding_source);
  if (notServing) return notServing;
  if (
    tree.creatives.some(
      (c) =>
        !["DRAFT", "PAUSED", "ACTIVE"].includes(c.intendedStatus) ||
        c.servingHoldReasons?.some((r) => /REJECT|CANCEL|ARCHIV/i.test(r)),
    )
  )
    return "One or more ads are not ready for launch.";
  return null;
}
async function linkedinWalletRefusal(tenantId: string, accountBindingId: string): Promise<string | null> {
  if (!managedLinkedinEnabled() || !fundingEnabled())
    return "Zavi wallet payments for LinkedIn are not switched on yet, so this campaign cannot launch from the wallet. It stays paused.";
  await requireSharedWalletConsent(tenantId);
  const { data: grant, error } = await tenantClient(asTenantId(tenantId))
    .from("ads_managed_account_grants")
    .select("account_id")
    .eq("account_id", accountBindingId)
    .is("disabled_at", null)
    .maybeSingle();
  if (error || !grant) return "This LinkedIn ad account can no longer spend from the Zavi wallet. Your campaign stays paused.";
  return null;
}
export async function linkedinLaunchSummary(
  tenantId: string,
  bindingId: string,
) {
  const tree = await launchTree(tenantId, bindingId, false);
  const writesOn = await isLinkedInAdsWriteEnabled();
  return {
    campaign_binding_id: bindingId,
    platform: "linkedin",
    campaign_id: tree.campaign.id,
    name: tree.campaign.name,
    account_id: tree.account.id,
    funding_source: tree.binding.funding_source,
    account_binding_id: tree.binding.account_id,
    launch_blocker: writesOn ? launchStateRefusal(tree) : `${LINKEDIN_ADS_WRITES_OFF_MESSAGE}, so Zavi cannot launch campaigns yet.`,
    currency: tree.account.currency,
    fx: tree.fx,
    stop_requested_at: tree.lifecycle.stop_requested_at,
    status: tree.campaign.status,
    snapshot: tree.snapshot,
    daily_budget_cents: tree.campaign.dailyBudget
      ? decimalCents(tree.campaign.dailyBudget.amount)
      : null,
    total_budget_cents: tree.campaign.totalBudget
      ? decimalCents(tree.campaign.totalBudget.amount)
      : null,
    end_time: tree.campaign.runSchedule.end ?? null,
    start_time: tree.campaign.runSchedule.start,
    ads: tree.creatives.map((c, i) => ({ label: `Ad ${i + 1}`, status: c.intendedStatus })),
    ...campaignDelivery(
      tree.campaign.status,
      tree.creatives.map((c) => ({
        campaign_id: tree.campaign.id,
        intended_status: c.intendedStatus,
        is_serving: typeof c.isServing === "boolean" ? c.isServing : null,
        hold_reasons: c.servingHoldReasons ?? [],
        review_status: c.review?.status ?? null,
      })),
    ),
  };
}
function linkedinTotalNotAboveSpentWords(spentCents: number, currency: string): string {
  return `This campaign has already spent ${accountMoney(spentCents, currency)}, and its total budget covers its whole life, so a new total must be above that. Nothing was sent to LinkedIn. Choose a higher total, then try again.`;
}
export function linkedinWalletTooSmallWords(totalCents: number, spentCents: number, funds?: { availableCents: number; ownHeldCents: number } | null): string {
  const needs = totalCents - spentCents;
  const spent = spentCents > 0
    ? ` This campaign has already spent ${dollars(spentCents)} of that total, so the launch needs ${dollars(needs)} more.`
    : "";
  const have = funds
    ? ` You have ${dollars(Math.max(0, funds.availableCents))} available${funds.ownHeldCents > 0 ? `, counting the ${dollars(funds.ownHeldCents)} already set aside for this campaign` : ""}.`
    : "";
  return `Your shared-wallet balance cannot cover this launch with a ${dollars(totalCents)} total budget.${spent}${have} Nothing was sent to LinkedIn and nothing was held. Add balance from the balance panel on your LinkedIn Ads page, or lower the total budget, then try again.`;
}
async function linkedinWalletFunds(tenantId: string, bindingId: string, observedCents: number): Promise<{ availableCents: number; ownHeldCents: number } | null> {
  try {
    const { readWallet } = await import("./wallet");
    const wallet = await readWallet(tenantId);
    const own = await tenantClient(asTenantId(tenantId))
      .from("ads_campaign_reservations")
      .select("reserved_cents,spent_cents")
      .eq("campaign_binding_id", bindingId)
      .maybeSingle();
    if (own.error) return null;
    const f = own.data as { reserved_cents?: number | string; spent_cents?: number | string } | null;
    const ownHeld = f ? Math.max(0, Number(f.reserved_cents ?? 0) - Math.max(0, observedCents - Number(f.spent_cents ?? 0))) : 0;
    return Number.isFinite(ownHeld) ? { availableCents: wallet.available_cents + ownHeld, ownHeldCents: ownHeld } : null;
  } catch {
    return null;
  }
}
export async function linkedinLaunchObservedCents(
  tenantId: string,
  bindingId: string,
  fundingSource: "wallet" | "provider",
): Promise<number | null> {
  return linkedinLifetimeSpend(tenantId, bindingId, { anyCurrency: fundingSource === "provider" }).then(
    (spend) => spend.cents,
    () => null,
  );
}
export async function linkedinLaunchOwnHoldUsd(
  tenantId: string,
  bindingId: string,
): Promise<number | null> {
  const r = await tenantRpc(asTenantId(tenantId), "ad_object_hold_usd", {
    p_platform: "linkedin",
    p_object_id: bindingId,
  }).then(
    (x) => x,
    () => null,
  );
  if (!r || r.error) return null;
  const usd = Number(r.data);
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}
async function launchedBefore(tenantId: string, bindingId: string): Promise<boolean> {
  const r = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_operations")
    .select("status")
    .eq("campaign_binding_id", bindingId)
    .eq("kind", "activate");
  if (r.error || !Array.isArray(r.data)) return true;
  return (r.data as Array<{ status: unknown }>).some((o) => o.status !== "refused");
}
export async function linkedinCampaignEverRan(tenantId: string, bindingId: string): Promise<boolean> {
  if (await launchedBefore(tenantId, bindingId)) return true;
  const life = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_lifecycle")
    .select("activation_attempted_at,stop_requested_at")
    .eq("campaign_binding_id", bindingId)
    .maybeSingle();
  if (life.error || !life.data) return true;
  const row = life.data as { activation_attempted_at?: string | null; stop_requested_at?: string | null };
  return !!row.activation_attempted_at || !!row.stop_requested_at;
}
export async function linkedinRelaunchSpentCents(
  tenantId: string,
  s: { campaign_binding_id: string; funding_source: string },
): Promise<number | null> {
  if (!(await linkedinCampaignEverRan(tenantId, s.campaign_binding_id))) return null;
  return linkedinLaunchObservedCents(tenantId, s.campaign_binding_id, s.funding_source === "wallet" ? "wallet" : "provider");
}
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const OVER_MONTH_NO_FIGURE = `${linkedinBudgetRefusalWords(adBudgetRefusal("over_month"))} Zavi could not work out the monthly ad budget this needs, so do not name an amount.`;
export async function linkedinOverMonthWords(tenantId: string, newUsd: number, ownHoldUsd: number): Promise<string | null> {
  try {
    const view = await readAdBudgetMonthView(tenantId);
    if (!view || view.status !== "active") return null;
    const cents = (n: number) => Math.round(n * 100);
    const needsCents = Math.ceil(Number((newUsd * budgetMargin(view) * 100).toFixed(6)));
    const usedCents = cents(view.spent_usd) + cents(view.held_usd) + cents(view.creator_held_usd) + cents(view.creator_spent_usd) - cents(ownHoldUsd);
    const { monthlyNeededForCap } = await import("@/services/growth/ad-budget-shortfall");
    const minimum = monthlyNeededForCap(view, (usedCents + needsCents) / 100);
    if (minimum === null || !Number.isFinite(minimum) || minimum <= view.monthly_usd) return null;
    const free = dollars(Math.max(cents(view.month_cap_usd) - usedCents, 0));
    const prorated = view.month_cap_usd < view.monthly_usd - 0.005;
    const month = prorated
      ? `Your ${usd(view.monthly_usd)} monthly ad budget gives ${dollars(cents(view.month_cap_usd))} this month because it counts only the days left, and ${dollars(usedCents)} of that is already spent or held.`
      : `${dollars(usedCents)} of your ${usd(view.monthly_usd)} monthly ad budget is already spent or held.`;
    return `This launch would go over your monthly ad budget: it needs ${dollars(needsCents)} this month and ${free} is free. ${month} Nothing was sent to LinkedIn. Lower the total budget, or raise your monthly ad budget to at least ${usd(minimum)}, then try again.`;
  } catch {
    return null;
  }
}
export async function linkedinLaunchFilingRefusal(
  tenantId: string,
  s: Pick<Awaited<ReturnType<typeof linkedinLaunchSummary>>, "campaign_binding_id" | "funding_source" | "account_binding_id" | "launch_blocker" | "start_time" | "fx" | "daily_budget_cents" | "currency">,
  ask: { total_budget_cents: number; end_time: number; spent_cents?: number | null },
  now: number = Date.now(),
): Promise<string | null> {
  if (!(await isLinkedInAdsWriteEnabled())) return `${LINKEDIN_ADS_WRITES_OFF_MESSAGE}, so Zavi cannot launch campaigns yet.`;
  const plan = await linkedinPlanState(tenantId);
  if (plan === "unread") return LINKEDIN_PLAN_UNREAD;
  if (plan === "not_on_plan") return "LinkedIn launch is unavailable for this workspace.";
  if (await isChannelLockedStrict("linkedin_ads")) return comingSoonMessage("LinkedIn Ads");
  if (s.launch_blocker) return s.launch_blocker;
  const endRefusal = linkedinEndTimeRefusal(ask.end_time, s.start_time, now);
  if (endRefusal) return endRefusal;
  const belowDaily = linkedinTotalBelowDailyRefusal(ask.total_budget_cents, s.daily_budget_cents, s.currency, s.fx.units_per_usd);
  if (belowDaily) return `${belowDaily} Nothing was sent to LinkedIn.`;
  const totalUsd = adsUsd(ask.total_budget_cents / 100, s.fx);
  if (totalUsd < linkedinMinTotalUsd()) return `The total budget must be at least $${linkedinMinTotalUsd()} (converted to USD).`;
  const spent = ask.spent_cents ?? null;
  if (spent !== null && ask.total_budget_cents <= spent) return linkedinTotalNotAboveSpentWords(spent, s.currency);
  if (s.funding_source === "wallet") {
    try {
      const walletRefusal = await linkedinWalletRefusal(tenantId, s.account_binding_id);
      if (walletRefusal) return walletRefusal;
    } catch (e) {
      if (e instanceof ExpectedToolError && e.code === "ads_consent_required") return e.message;
    }
  }
  const budget = await readActiveAdBudget(tenantId).then(
    (b) => ({ read: true as const, b }),
    () => ({ read: false as const }),
  );
  if (!budget.read) return null;
  if (!budget.b) return "Set a monthly ad budget before launching LinkedIn campaigns.";
  if (spent === null && (await launchedBefore(tenantId, s.campaign_binding_id))) return null;
  const newCents = ask.total_budget_cents - (spent ?? 0);
  const newUsd = adsUsd(newCents / 100, s.fx);
  const dailyUsd = s.daily_budget_cents === null ? null : adsUsd(s.daily_budget_cents / 100, s.fx);
  if (budget.b.daily_limit_usd !== null && linkedinWorstDayUsd(newUsd, dailyUsd) > budget.b.daily_limit_usd)
    return linkedinOverDailyWords({ worstUsd: linkedinWorstDayUsd(newUsd, dailyUsd), limitUsd: budget.b.daily_limit_usd, hasDailyBudget: dailyUsd !== null });
  const ownHold = await linkedinLaunchOwnHoldUsd(tenantId, s.campaign_binding_id);
  if (Math.ceil(Number((newUsd * budgetMargin(budget.b) * 100).toFixed(6))) / 100 > budget.b.left_usd + (ownHold ?? 0))
    return (await linkedinOverMonthWords(tenantId, newUsd, ownHold ?? 0)) ?? OVER_MONTH_NO_FIGURE;
  if (s.funding_source === "wallet") {
    const funds = await linkedinWalletFunds(tenantId, s.campaign_binding_id, spent ?? 0);
    if (funds !== null && newCents > funds.availableCents) return linkedinWalletTooSmallWords(ask.total_budget_cents, spent ?? 0, funds);
  }
  return null;
}
export type InterruptedLinkedinLaunch = "succeeded" | "not_sent" | "not_reopened" | "reconciled" | "unknown";
const ATTEMPT_CLOCK_MARGIN_MS = 5 * 60_000;
async function readInterruptedLinkedinLaunch(tenantId: string, requestId: string) {
  const db = tenantClient(asTenantId(tenantId));
  const op = await db
    .from("ads_campaign_operations")
    .select("status,campaign_binding_id,created_at")
    .eq("id", requestId)
    .maybeSingle();
  if (op.error) return { verdict: "unknown" as const };
  const row = op.data as { status: string; campaign_binding_id: string; created_at: string } | null;
  if (row?.status === "succeeded") return { verdict: "succeeded" as const };
  if (row && row.status !== "refused") return { verdict: "unknown" as const };
  const idem_key = adBudgetIdemKey(requestId, "resume");
  const held = await db.from("ad_budget_reservations").select("status,reason").eq("idem_key", idem_key).maybeSingle();
  if (held.error) return { verdict: "unknown" as const };
  const hold = held.data as { status: string; reason: string | null } | null;
  const holdNeverSent = !hold || hold.status === "reserved" || hold.status === "refused" || (hold.status === "released" && (hold.reason === "rejected" || hold.reason === "not_landed"));
  if (row) {
    if (!holdNeverSent) return { verdict: "reconciled" as const };
    const life = await db.from("ads_campaign_lifecycle").select("activation_attempted_at").eq("campaign_binding_id", row.campaign_binding_id).maybeSingle();
    if (life.error) return { verdict: "unknown" as const };
    const attempted = Date.parse(String((life.data as { activation_attempted_at?: string | null } | null)?.activation_attempted_at ?? ""));
    if (attempted >= Date.parse(row.created_at) - ATTEMPT_CLOCK_MARGIN_MS) return { verdict: "reconciled" as const };
  } else if (!holdNeverSent) return { verdict: "unknown" as const };
  return { verdict: "never_sent" as const, row, hold, idem_key };
}
export async function linkedinLaunchHoldOutcome(tenantId: string, requestId: string): Promise<"landed" | "not_landed" | null> {
  const seen = await readInterruptedLinkedinLaunch(tenantId, requestId);
  return seen.verdict === "succeeded" ? "landed" : seen.verdict === "never_sent" ? "not_landed" : null;
}
export async function judgeInterruptedLinkedinLaunch(tenantId: string, requestId: string): Promise<InterruptedLinkedinLaunch> {
  const db = tenantClient(asTenantId(tenantId));
  const seen = await readInterruptedLinkedinLaunch(tenantId, requestId);
  if (seen.verdict !== "never_sent") return seen.verdict;
  const { row, hold, idem_key } = seen;
  if (hold?.status === "reserved") {
    await dropAdSpendHold({ status: "held", tenant_id: tenantId, idem_key, fresh: true }, { strict: true }).catch(() =>
      logEvent({
        level: "error",
        source: "ads-wallet",
        code: "ads_wallet.unsent_launch_hold_left",
        tenant_id: tenantId,
        message: "An interrupted LinkedIn launch never reached LinkedIn, but its monthly budget hold could not be given back. Approving the card again reuses it, and the hourly check resolves it.",
      }).catch(() => undefined),
    );
  }
  if (!row) return "not_sent";
  const reopened = await db.from("ads_campaign_operations").delete().eq("id", requestId).eq("status", "refused").select("id");
  return !reopened.error && ((reopened.data ?? []) as unknown[]).length === 1 ? "not_sent" : "not_reopened";
}
type UnresolvedOperation = { id: string; kind: string; status: string; created_at: string };
async function unresolvedOperation(tenantId: string, bindingId: string): Promise<UnresolvedOperation | null> {
  const r = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_operations")
    .select("id,kind,status,created_at")
    .eq("campaign_binding_id", bindingId)
    .in("status", ["pending", "uncertain"]);
  if (r.error || !Array.isArray(r.data) || r.data.length !== 1) return null;
  return r.data[0] as UnresolvedOperation;
}
async function settleUnclearLaunchOfPausedCampaign(
  tenantId: string,
  bindingId: string,
  earlier: UnresolvedOperation,
  requestId: string,
): Promise<boolean> {
  if (earlier.kind !== "activate" || earlier.status !== "uncertain" || earlier.id === requestId) return false;
  const key = adBudgetIdemKey(earlier.id, "resume");
  let committed = true;
  try {
    await commitAdSpend({ status: "held", tenant_id: tenantId, idem_key: key, fresh: false }, bindingId, { strict: true });
  } catch {
    committed = false;
  }
  if (!committed) {
    const left = await tenantClient(asTenantId(tenantId)).from("ad_budget_reservations").select("status").eq("idem_key", key).maybeSingle();
    if (left.error || (left.data as { status?: unknown } | null)?.status === "reserved") return false;
  }
  const settled = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_operations")
    .update({ status: "refused", updated_at: new Date().toISOString() })
    .eq("id", earlier.id)
    .eq("status", "uncertain")
    .select("id");
  if (settled.error || ((settled.data ?? []) as unknown[]).length !== 1) return false;
  await logEvent({
    level: "info",
    source: "ads-wallet",
    code: "ads_wallet.unclear_launch_settled",
    tenant_id: tenantId,
    message: "A LinkedIn launch with an unclear outcome was settled when the founder launched the campaign again: LinkedIn showed the campaign paused, so its budget hold was kept as spent and the new launch went ahead.",
  }).catch(() => undefined);
  return true;
}
export function linkedinBusyWords(earlier: Pick<UnresolvedOperation, "kind" | "status"> | null): string {
  if (earlier?.kind === "activate" && earlier.status === "uncertain")
    return "An earlier launch of this campaign did not get a clear answer from LinkedIn, and Zavi is still settling it, including the budget set aside for it. Nothing new was sent to LinkedIn. Check the campaign on your LinkedIn Ads page and try again in a few minutes.";
  if (earlier?.kind === "activate")
    return "Zavi is still finishing an earlier launch of this campaign. Nothing new was sent to LinkedIn. Check the campaign on your LinkedIn Ads page in a few minutes; if it is still paused then, review the launch again.";
  if (earlier?.kind === "pause")
    return "Zavi is still pausing this campaign from an earlier request. Nothing was sent to LinkedIn. Try again in a few minutes.";
  return "Another change to this campaign is still finishing. Nothing was sent to LinkedIn. Try again in a few minutes.";
}
export const LINKEDIN_PAUSED_DURING_LAUNCH =
  "The campaign was paused while it was launching, so Zavi stopped the launch. Check the campaign before you launch it again.";
export const LINKEDIN_LAUNCH_LIVE_RECORD_PENDING =
  "Your campaign is live on LinkedIn. Zavi is still finishing its own record of this launch, so the campaign may show as launching on your LinkedIn Ads page for a few minutes. There is nothing you need to do.";
const RECEIPT_ATTEMPTS = 3;
export async function launchLinkedinCampaign(
  tenantId: string,
  bindingId: string,
  value: unknown,
  beforeWrite: () => Promise<void> = async () => {},
  approval: { approved_by?: string | null; approved_by_source?: string | null; body?: unknown; approved_total_usd?: number; reviewed_units_per_usd?: number | null } = {},
) {
  const ask = linkedinLaunchInput.parse(value);
  if (!(await isLinkedInAdsWriteEnabled()))
    throw new ExpectedToolError("linkedin_ads_writes_off", `${LINKEDIN_ADS_WRITES_OFF_MESSAGE}, so Zavi cannot launch campaigns yet. Your campaign stays paused.`);
  const plan = await linkedinPlanState(tenantId);
  if (plan === "unread") return fail(`${LINKEDIN_PLAN_UNREAD} Your campaign stays paused.`);
  if (plan === "not_on_plan")
    return fail("LinkedIn launch is unavailable for this workspace.");
  if (await isChannelLockedStrict("linkedin_ads"))
    return fail(comingSoonMessage("LinkedIn Ads"));
  const seen = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_operations")
    .select("status")
    .eq("id", ask.request_id)
    .maybeSingle();
  if (!seen.error && typeof (seen.data as { status?: unknown } | null)?.status === "string") return { status: "already_requested" };
  const tree = await launchTree(tenantId, bindingId, true);
  if (tree.snapshot !== ask.snapshot)
    return failForGood("The campaign or its ads changed. Review the launch again.");
  const stateRefusal = launchStateRefusal(tree);
  if (stateRefusal === NOT_ONLY_PAUSED) return failForGood(stateRefusal);
  if (stateRefusal) return fail(stateRefusal);
  const endRefusal = linkedinEndTimeRefusal(ask.end_time, tree.campaign.runSchedule.start);
  if (endRefusal) return failForGood(endRefusal);
  const belowDaily = linkedinTotalBelowDailyRefusal(ask.total_budget_cents, moneyCents(tree.campaign.dailyBudget), tree.account.currency, tree.fx.units_per_usd);
  if (belowDaily) return failForGood(`${belowDaily} Nothing was sent to LinkedIn and nothing was held.`);
  const wallet = tree.binding.funding_source === "wallet";
  let observed = 0;
  if (wallet) {
    const walletRefusal = await linkedinWalletRefusal(tenantId, tree.binding.account_id);
    if (walletRefusal) return fail(walletRefusal);
    observed = await linkedinLifetimeSpend(tenantId, bindingId).then((spend) => spend.cents, spendUnread);
  } else {
    observed = await linkedinLifetimeSpend(tenantId, bindingId, { anyCurrency: true }).then((spend) => spend.cents, spendUnread);
  }
  if (ask.total_budget_cents <= observed)
    return failForGood(linkedinTotalNotAboveSpentWords(observed, tree.account.currency));
  const nowUsd = adsUsd(ask.total_budget_cents / 100, tree.fx);
  const approvedUsd =
    approval.approved_total_usd ??
    (approval.reviewed_units_per_usd === undefined
      ? undefined
      : approval.reviewed_units_per_usd === null
        ? tree.account.currency === "USD"
          ? nowUsd
          : fail("Zavi could not tell which exchange rate this launch was reviewed at. Nothing was sent to LinkedIn. Review the launch again.")
        : adsUsd(ask.total_budget_cents / 100, { ...tree.fx, units_per_usd: approval.reviewed_units_per_usd }));
  if (approvedUsd !== undefined) {
    const drift = linkedinUsdDrift(nowUsd, approvedUsd, tree.account.currency);
    if (drift) return failForGood(drift);
  }
  await beforeWrite();
  const claimOperation = () =>
    tenantRpc(asTenantId(tenantId), "ads_claim_campaign_operation", {
      p_id: ask.request_id,
      p_campaign_binding_id: bindingId,
      p_kind: "activate",
      p_payload: ask,
    });
  let claim = await claimOperation();
  if (claim.error) {
    const earlier = await unresolvedOperation(tenantId, bindingId);
    if (earlier && (await settleUnclearLaunchOfPausedCampaign(tenantId, bindingId, earlier, ask.request_id))) claim = await claimOperation();
    if (claim.error) return fail(linkedinBusyWords(earlier));
  }
  if (claim.data !== true) return { status: "already_requested" };
  let hold: AdSpendHold = { status: "no_budget" };
  let sent = false;
  let switchOnRefused = false;
  let priorReserved: number | null = null;
  const checkStop = async () => {
    await beforeWrite();
    const r = await tenantClient(asTenantId(tenantId))
      .from("ads_campaign_lifecycle")
      .select("stop_requested_at")
      .eq("campaign_binding_id", bindingId)
      .single();
    if (r.error)
      throw new ExpectedToolError(
        "ads_launch_unread",
        "Zavi could not check whether this campaign was paused while it was launching, so it stopped the launch. Nothing was sent to LinkedIn. Try again in a minute.",
      );
    if ((r.data as { stop_requested_at: string | null }).stop_requested_at !== tree.lifecycle.stop_requested_at)
      fail(LINKEDIN_PAUSED_DURING_LAUNCH);
  };
  const removeUnsentClaim = async (): Promise<boolean> => {
    const r = await tenantClient(asTenantId(tenantId))
      .from("ads_campaign_operations")
      .delete()
      .eq("id", ask.request_id)
      .eq("status", "pending")
      .select("id");
    return !r.error && ((r.data ?? []) as unknown[]).length === 1;
  };
  const releaseUnsentHolds = async () => {
    const held = await tenantClient(asTenantId(tenantId))
      .from("ad_budget_reservations")
      .select("idem_key")
      .eq("platform", "linkedin")
      .eq("object_id", bindingId)
      .eq("status", "reserved");
    const ids = (Array.isArray(held.data) ? (held.data as Array<{ idem_key: unknown }>) : [])
      .map((r) => /^([0-9a-f-]{36}):resume$/i.exec(String(r.idem_key))?.[1])
      .filter((v): v is string => !!v && v !== ask.request_id);
    if (held.error || ids.length === 0) return;
    const ops = await tenantClient(asTenantId(tenantId))
      .from("ads_campaign_operations")
      .select("id,status")
      .in("id", ids);
    if (ops.error || !Array.isArray(ops.data)) return;
    const claimed = new Set(
      (ops.data as Array<{ id: unknown; status: unknown }>).filter((r) => r.status !== "refused").map((r) => String(r.id)),
    );
    for (const id of ids.filter((v) => !claimed.has(v)))
      await dropAdSpendHold({ status: "held", tenant_id: tenantId, idem_key: adBudgetIdemKey(id, "resume"), fresh: true });
    for (const op of ops.data as Array<{ id: unknown; status: unknown }>)
      if (op.status === "succeeded")
        await commitAdSpend({ status: "held", tenant_id: tenantId, idem_key: adBudgetIdemKey(String(op.id), "resume"), fresh: false }, bindingId);
  };
  const releaseUnsentWallet = async () => {
    if (!wallet || tree.campaign.status === "ACTIVE") return;
    const earlier = await tenantClient(asTenantId(tenantId))
      .from("ads_campaign_operations")
      .select("id,status")
      .eq("campaign_binding_id", bindingId)
      .eq("kind", "activate");
    if (earlier.error || !Array.isArray(earlier.data)) return;
    const others = (earlier.data as Array<{ id: unknown; status: unknown }>).filter((o) => String(o.id) !== ask.request_id);
    if (others.length === 0 || !others.every((o) => o.status === "refused")) return;
    const holds = await tenantClient(asTenantId(tenantId))
      .from("ad_budget_reservations")
      .select("idem_key,status,reason")
      .eq("platform", "linkedin")
      .eq("object_id", bindingId);
    if (holds.error || !Array.isArray(holds.data)) return;
    const byKey = new Map((holds.data as Array<{ idem_key: unknown; status: unknown; reason: unknown }>).map((h) => [String(h.idem_key), h]));
    const neverSent = others.every((o) => {
      const h = byKey.get(adBudgetIdemKey(String(o.id), "resume"));
      return !h || h.status === "reserved" || h.status === "refused" || (h.status === "released" && (h.reason === "rejected" || h.reason === "not_landed"));
    });
    if (!neverSent) return;
    await tenantRpc(asTenantId(tenantId), "ads_release_unsent_linkedin_launch", {
      p_campaign_binding_id: bindingId,
      p_operation_id: ask.request_id,
      p_prior_reserved_cents: 0,
    }).then(
      () => undefined,
      () => undefined,
    );
  };
  const finish = async (status: "succeeded" | "uncertain" | "refused") => {
    const r = await tenantClient(asTenantId(tenantId))
      .from("ads_campaign_operations")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", ask.request_id);
    if (r.error)
      throw new Error("Campaign operation receipt could not be saved");
  };
  try {
    const budget = await readActiveAdBudget(tenantId);
    if (!budget)
      return fail(
        "Set a monthly ad budget before launching LinkedIn campaigns.",
      );
    const totalUsd = adsUsd(ask.total_budget_cents / 100, tree.fx);
    const minTotalUsd = linkedinMinTotalUsd();
    if (totalUsd < minTotalUsd)
      return failForGood(`The total budget must be at least $${minTotalUsd} (converted to USD).`);
    const spend = linkedinLaunchSpend({
      total_cents: ask.total_budget_cents,
      observed_cents: observed,
      end_time: ask.end_time,
      start_time: tree.campaign.runSchedule.start,
      now: Date.now(),
    });
    const remainingUsd = adsUsd(spend.spendable_cents / 100, tree.fx);
    const dailyBudgetCents = moneyCents(tree.campaign.dailyBudget);
    const dailyBudgetUsd = dailyBudgetCents === null ? null : adsUsd(dailyBudgetCents / 100, tree.fx);
    await releaseUnsentHolds();
    await releaseUnsentWallet();
    hold = await reserveAdSpend(
      {
        id: ask.request_id,
        tenant_id: tenantId,
        exec_source: "workspace",
        approved_by: approval.approved_by ?? null,
        approved_by_source: approval.approved_by_source ?? null,
        body: approval.body,
      },
      {
        platform: "linkedin",
        op: "resume",
        object_id: bindingId,
        daily_delta_usd: linkedinWorstDayUsd(remainingUsd, dailyBudgetUsd),
        currency: "USD",
        lifetime_usd: remainingUsd,
        observed_usd: adsUsd(observed / 100, tree.fx),
        ends_on: dailyHoldEndsOn(Math.ceil(ask.end_time / 1000)),
        refuse_over_cap: true,
      },
    );
    if (hold.status === "refused")
      return refuseBudget(
        hold.error,
        (hold.error === adBudgetRefusal("over_month") && (await linkedinOverMonthWords(tenantId, remainingUsd, (await linkedinLaunchOwnHoldUsd(tenantId, bindingId)) ?? 0))) ||
          (hold.error.startsWith(adBudgetRefusal("over_daily_limit")) && budget.daily_limit_usd != null
            ? linkedinOverDailyWords({ worstUsd: linkedinWorstDayUsd(remainingUsd, dailyBudgetUsd), limitUsd: budget.daily_limit_usd, hasDailyBudget: dailyBudgetUsd !== null })
            : undefined),
      );
    if (hold.status !== "held")
      return fail("Your monthly ad budget was turned off while this launch was being checked. Nothing was sent to LinkedIn. Set a monthly ad budget, then try again.");
    await beforeWrite();
    if (wallet) {
      const readCoverage = () =>
        tenantClient(asTenantId(tenantId))
          .from("ads_campaign_reservations")
          .select("reserved_cents,spent_cents")
          .eq("campaign_binding_id", bindingId)
          .maybeSingle();
      const before = await readCoverage();
      if (before.error)
        return fail("Zavi could not check your shared-wallet funds for this launch just now. Nothing was sent to LinkedIn and nothing was held. Try again in a minute.");
      const f = before.data as { reserved_cents: number | string; spent_cents: number | string } | null;
      const coverageBefore = f ? Math.max(0, Number(f.reserved_cents) - Math.max(0, observed - Number(f.spent_cents))) : 0;
      const r = await tenantRpc(
        asTenantId(tenantId),
        "ads_reserve_linkedin_launch",
        {
          p_campaign_binding_id: bindingId,
          p_lifetime_cents: ask.total_budget_cents,
          p_observed_spend_cents: observed,
        },
      );
      if (r.error) {
        if (/ads_balance_insufficient/.test(r.error.message ?? ""))
          return fail(linkedinWalletTooSmallWords(ask.total_budget_cents, observed, await linkedinWalletFunds(tenantId, bindingId, observed)));
        const seen = await readCoverage();
        const g = seen.data as { reserved_cents: number | string; spent_cents: number | string } | null;
        if (!seen.error && (Number(g?.reserved_cents ?? -1) !== Number(f?.reserved_cents ?? -1) || Number(g?.spent_cents ?? -1) !== Number(f?.spent_cents ?? -1)))
          priorReserved = coverageBefore;
        return fail("Zavi could not confirm the shared-wallet funds for this launch just now. Nothing was sent to LinkedIn. Try again in a minute.");
      }
      priorReserved = Number(r.data ?? coverageBefore);
      await requireSharedWalletConsent(tenantId);
    }
    if (!wallet) {
      const mark = await tenantClient(asTenantId(tenantId))
        .from("ads_campaign_lifecycle")
        .update({ activation_attempted_at: new Date().toISOString() })
        .eq("campaign_binding_id", bindingId);
      if (mark.error) throw new Error("Could not record launch attempt");
    }
    await checkStop();
    sent = true;
    try {
      await linkedinAdsPost(tree.token, tree.path, "PARTIAL_UPDATE", {
        patch: {
          $set: {
            totalBudget: {
              amount: (ask.total_budget_cents / 100).toFixed(2),
              currencyCode: tree.account.currency,
            },
            runSchedule: { ...tree.campaign.runSchedule, end: ask.end_time },
          },
        },
      });
    } catch (e) {
      if (!(e instanceof ExpectedToolError) || !LINKEDIN_CLEAN_REFUSALS.has(e.code)) throw e;
      sent = false;
      throw linkedinFirstWriteRefusal(managedWriteRefusal(e, wallet));
    }
    let partlyOn = false;
    const switchOn = async (path: string, set: Record<string, string>) => {
      try {
        await linkedinAdsPost(tree.token, path, "PARTIAL_UPDATE", { patch: { $set: set } });
      } catch (e) {
        if (!(e instanceof ExpectedToolError) || !LINKEDIN_CLEAN_REFUSALS.has(e.code)) throw e;
        sent = false;
        switchOnRefused = true;
        throw linkedinSwitchOnRefusal(managedWriteRefusal(e, wallet), partlyOn);
      }
      partlyOn = true;
    };
    for (const creative of tree.creatives) {
      await checkStop();
      await switchOn(linkedinCreativePath(tree.account.id, creative.rawId), { intendedStatus: "ACTIVE" });
    }
    await checkStop();
    if (tree.group.status !== "ACTIVE")
      await switchOn(`${tree.base}/adCampaignGroups/${tree.lifecycle.provider_group_id}`, { status: "ACTIVE" });
    await checkStop();
    await switchOn(tree.path, { status: "ACTIVE" });
    const after = await linkedinCampaign(tenantId, bindingId);
    const adsAfter = await Promise.all(
      tree.creatives.map((creative) =>
        linkedinAdsGet<{ intendedStatus?: string }>(tree.token, linkedinCreativePath(tree.account.id, creative.rawId)),
      ),
    );
    if (
      adsAfter.some((ad) => ad.intendedStatus !== "ACTIVE") ||
      after.campaign.status !== "ACTIVE" ||
      !after.campaign.totalBudget ||
      decimalCents(after.campaign.totalBudget.amount) !==
        ask.total_budget_cents ||
      after.campaign.runSchedule.end !== ask.end_time
    )
      throw new Error("Launch could not be confirmed");
    await checkStop();
    let clear = tenantClient(asTenantId(tenantId))
      .from("ads_campaign_lifecycle")
      .update({ stop_requested_at: null })
      .eq("campaign_binding_id", bindingId);
    clear =
      tree.lifecycle.stop_requested_at === null
        ? clear.is("stop_requested_at", null)
        : clear.eq("stop_requested_at", tree.lifecycle.stop_requested_at);
    const cleared = await clear.select("campaign_binding_id");
    if (cleared.error || !cleared.data?.length)
      throw new Error("Campaign stop intent changed");
    await unmarkLinkedinCampaignGone(tenantId, bindingId).catch(() =>
      logEvent({
        level: "error",
        source: "ads-wallet",
        code: "ads_wallet.gone_record_not_cleared",
        tenant_id: tenantId,
        message: "A relaunched LinkedIn campaign still has a record saying LinkedIn no longer has it. The next settle tick clears it for a wallet campaign.",
      }).catch(() => undefined),
    );
    if (wallet) {
      const trimmed = await tenantRpc(asTenantId(tenantId), "ads_release_unsent_linkedin_launch", {
        p_campaign_binding_id: bindingId,
        p_operation_id: ask.request_id,
        p_prior_reserved_cents: ask.total_budget_cents - observed,
      }).then(
        (r) => !r.error,
        () => false,
      );
      if (!trimmed)
        await logEvent({
          level: "error",
          source: "ads-wallet",
          code: "ads_wallet.relaunch_excess_kept",
          tenant_id: tenantId,
          message: "A relaunched LinkedIn campaign went live with a smaller total, but the larger shared-wallet hold from its earlier run could not be lowered. The extra stays held until the campaign settles.",
        }).catch(() => undefined);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await commitAdSpend(hold, bindingId, { strict: true });
        break;
      } catch {
        if (attempt < RECEIPT_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 200 * attempt));
          continue;
        }
        await logEvent({
          level: "error",
          source: "ads-wallet",
          code: "ads_wallet.launch_hold_uncommitted",
          tenant_id: tenantId,
          message: "A LinkedIn launch went live and LinkedIn confirmed it, but its monthly budget hold could not be marked as counted. The campaign was left running; the hourly hold check, or the next launch of this campaign, marks the hold counted because the launch record says it succeeded.",
        }).catch(() => undefined);
        break;
      }
    }
    for (let attempt = 1; attempt <= RECEIPT_ATTEMPTS; attempt++) {
      try {
        await finish("succeeded");
        return { status: "active" };
      } catch {
        if (attempt < RECEIPT_ATTEMPTS) await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
    await logEvent({
      level: "error",
      source: "ads-wallet",
      code: "ads_wallet.launch_receipt_unsaved",
      tenant_id: tenantId,
      message: "A LinkedIn launch went live and LinkedIn confirmed it, but its launch record could not be saved. The campaign was left running; the campaign operations sweep marks the record done because its budget hold is already counted and no pause was asked for.",
    }).catch(() => undefined);
    return { status: "active", record_pending: true, notice: LINKEDIN_LAUNCH_LIVE_RECORD_PENDING };
  } catch (e) {
    await logLinkedInRefusal(e, { tenantId, objectId: bindingId, stage: "launch" });
    let retryable = !sent;
    let walletKept = false;
    const sameRequest = hold.status === "refused" && hold.error.startsWith(adBudgetRefusal("unavailable"));
    if (!sent) {
      try {
        await dropAdSpendHold(hold.status === "held" ? { ...hold, fresh: true } : hold, { strict: true });
      } catch {
        await logEvent({
          level: "error",
          source: "ads-wallet",
          code: "ads_wallet.unsent_launch_hold_left",
          tenant_id: tenantId,
          message:
            "A LinkedIn launch stopped before reaching LinkedIn, but its monthly budget hold could not be given back. The next launch of this campaign gives it back first, and the hourly hold check gives it back after two hours.",
        }).catch(() => undefined);
      }
      if (priorReserved !== null) {
        const released = await tenantRpc(
          asTenantId(tenantId),
          "ads_release_unsent_linkedin_launch",
          {
            p_campaign_binding_id: bindingId,
            p_operation_id: ask.request_id,
            p_prior_reserved_cents: priorReserved,
          },
        ).then(
          (r) => !r.error,
          () => false,
        );
        if (!released) retryable = false;
        walletKept = !released;
        if (!released)
          await logEvent({
            level: "error",
            source: "ads-wallet",
            code: "ads_wallet.unsent_launch_release_failed",
            tenant_id: tenantId,
            message:
              "A LinkedIn launch stopped before reaching LinkedIn, but its wallet coverage could not be given back. The hold stays until the campaign settles.",
          }).catch(() => undefined);
      }
    } else {
      const stopNow = await tenantClient(asTenantId(tenantId))
        .from("ads_campaign_lifecycle")
        .select("stop_requested_at")
        .eq("campaign_binding_id", bindingId)
        .single()
        .then(
          (r) => (r.error ? undefined : (r.data as { stop_requested_at: string | null }).stop_requested_at),
          () => undefined,
        );
      const pausedMidLaunch = stopNow !== undefined && stopNow !== tree.lifecycle.stop_requested_at && hold.status === "held";
      let stopped: Awaited<ReturnType<typeof pauseLinkedinBoundCampaign>> | undefined;
      try {
        stopped = await pauseLinkedinBoundCampaign(tenantId, bindingId);
      } catch {
      }
      let settled = false;
      if (pausedMidLaunch && (stopped === "paused" || stopped === "already_paused" || stopped === "ended")) {
        try {
          await commitAdSpend(hold, bindingId, { strict: true });
          await finish("refused");
          settled = true;
        } catch {
          settled = false;
        }
      }
      if (settled)
        throw new ExpectedToolError("ads_launch_conflict", LINKEDIN_PAUSED_DURING_LAUNCH);
    }
    const reopened = retryable && (await removeUnsentClaim());
    if (!reopened) await finish(sent ? "uncertain" : "refused");
    if (!sent && !(sameRequest && reopened))
      throw new ExpectedToolError(
        !walletKept && e instanceof ExpectedToolError && LINKEDIN_RECONNECT_REFUSALS.has(e.code) ? e.code : "ads_launch_not_sent",
        walletKept
          ? `${switchOnRefused ? `${LINKEDIN_NOT_SWITCHED_ON} Zavi` : "Nothing was sent to LinkedIn, but Zavi"} could not give back the shared-wallet funds it set aside for this launch yet. They are reserved, not spent, and Zavi gives them back before this campaign's next launch.`
          : e instanceof ExpectedToolError
          ? e.message
          : "Nothing was sent to LinkedIn. Review the campaign and try again.",
        e instanceof ExpectedToolError ? e.meta : undefined,
      );
    if (sent && !(e instanceof ExpectedToolError && e.code === "ads_launch_conflict"))
      throw new ExpectedToolError("ads_launch_conflict", linkedinLaunchUnconfirmedWords(tree.binding.funding_source), { outcome_unknown: true });
    throw e;
  }
}
