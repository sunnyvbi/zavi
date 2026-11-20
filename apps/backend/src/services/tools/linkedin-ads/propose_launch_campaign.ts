import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import {
  LINKEDIN_LAUNCH,
  linkedinLaunchProposal,
} from "@/services/ads-wallet/linkedin-growth";
import { accountMoney, linkedinLaunchFilingRefusal, linkedinLaunchSummary, linkedinRelaunchSpentCents } from "@/services/ads-wallet/linkedin-launch";
import { adsUsd } from "@/services/ads-wallet/fx";
import { campaignDelivery, type CampaignDelivery } from "@/services/connectors/linkedin-ads/ad-delivery";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { isFounderChatOrder, isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { FIT_VERDICTS } from "@/agents/lib/channel-recipe-step";
import { mapLimit } from "@/services/provisioning/export-to-own-github";
type BoundRow = { id: string; provider_campaign_id: string; account_binding_id: string; funding_source: string };
async function boundLinkedinRows(tenantId: string): Promise<BoundRow[]> {
  const r = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_binding_details")
    .select("id,provider_campaign_id,account_binding_id,funding_source")
    .eq("platform", "linkedin")
    .order("id")
    .range(0, 999);
  if (r.error || !r.data || r.data.length === 1000)
    throw new Error("Campaign inventory is incomplete");
  const { linkedinBindingsInUse } = await import("@/services/connectors/linkedin-ads/own-accounts");
  const inUse = (await linkedinBindingsInUse(tenantId)).bindingIds;
  return (r.data as BoundRow[]).filter((c) => inUse.has(c.account_binding_id));
}
type LaunchCandidate = {
  id: string;
  provider_campaign_id: string;
  funding_source: string;
  name: string | null;
  status: string | null;
  launch_blocker: string | null;
  daily_budget_cents: number | null;
  currency: string | null;
  unread: boolean;
} & CampaignDelivery;
const LAUNCH_READ_LIMIT = 25;
const LAUNCH_READ_CONCURRENCY = 4;
async function launchCandidates(tenantId: string, rows: BoundRow[]): Promise<LaunchCandidate[]> {
  const base = (c: BoundRow) => ({ id: c.id, provider_campaign_id: c.provider_campaign_id, funding_source: c.funding_source });
  const read = await mapLimit(rows.slice(0, LAUNCH_READ_LIMIT), LAUNCH_READ_CONCURRENCY, async (c): Promise<LaunchCandidate> => {
    try {
      const s = await linkedinLaunchSummary(tenantId, c.id);
      return { ...base(c), name: s.name, status: s.status, launch_blocker: s.launch_blocker, daily_budget_cents: s.daily_budget_cents, currency: s.currency, unread: false, delivery: s.delivery, delivery_note: s.delivery_note };
    } catch (e) {
      const known = e instanceof ExpectedToolError && e.code === "ads_launch_conflict";
      return { ...base(c), name: null, status: null, launch_blocker: known ? e.message : null, daily_budget_cents: null, currency: null, unread: !known, ...campaignDelivery(null, null) };
    }
  });
  const skipped = rows.slice(LAUNCH_READ_LIMIT).map((c) => ({ ...base(c), name: null, status: null, launch_blocker: null, daily_budget_cents: null, currency: null, unread: true, ...campaignDelivery(null, null) }));
  return [...read, ...skipped];
}
const launchable = (c: LaunchCandidate) => !c.unread && c.status === "PAUSED" && !c.launch_blocker;
const UNREAD_IDS_SHOWN = 25;
export function whichCampaignQuestion(text: string, candidates: LaunchCandidate[], chosenId: string): string | null {
  const open = candidates.filter(launchable);
  const unread = candidates.filter((c) => c.unread);
  if (open.length + unread.length < 2) return null;
  const said = text.toLowerCase();
  const byId = [...open, ...unread].filter((c) => said.includes(c.provider_campaign_id));
  const byName = open.filter((c) => c.name && said.includes(c.name.toLowerCase()));
  const named = byId.length === 1 ? byId : byName;
  if (named.length === 1 && named[0].id === chosenId) return null;
  const list = open
    .map((c) => {
      const daily = c.daily_budget_cents === null || !c.currency ? "daily budget unknown" : `${accountMoney(c.daily_budget_cents, c.currency)} a day`;
      const funding = c.funding_source === "wallet" ? "paid from your Zavi wallet" : "billed by LinkedIn directly";
      return `${c.name ? `"${c.name}"` : "An unnamed campaign"} (ID ${c.provider_campaign_id}, ${daily}, ${funding})`;
    })
    .join("; ");
  const listed = open.length
    ? `You have ${open.length} paused LinkedIn campaign${open.length === 1 ? "" : "s"} Zavi could launch: ${list}.`
    : "Zavi found no paused LinkedIn campaign it could confirm is ready to launch.";
  const shown = unread.slice(0, UNREAD_IDS_SHOWN).map((c) => c.provider_campaign_id).join(", ");
  const more = unread.length > UNREAD_IDS_SHOWN ? ` and ${unread.length - UNREAD_IDS_SHOWN} more` : "";
  const notRead = unread.length
    ? ` Zavi could not read ${unread.length} other LinkedIn campaign${unread.length === 1 ? "" : "s"} just now, so it cannot tell whether ${unread.length === 1 ? "it is" : "they are"} paused or ready (ID${unread.length === 1 ? "" : "s"} ${shown}${more}).`
    : "";
  return `Which campaign should run this? ${listed}${notRead} Nothing was launched. Tell me the ID of the one you want.`;
}
export function pacingWords(totalCents: number, dailyCents: number | null, days: number): string {
  if (dailyCents === null || dailyCents <= 0 || !(days > 0)) return "";
  const usd = (c: number) => accountMoney(c, "USD");
  const daily = usd(dailyCents);
  const lastsDays = Math.floor(totalCents / dailyCents);
  if (lastsDays < days)
    return ` Zavi does not change the campaign's own ${daily} daily budget in LinkedIn, so it can use up the ${usd(totalCents)} in about ${Math.max(1, lastsDays)} day${lastsDays === 1 ? "" : "s"} and stop before the ${days} days are over.`;
  const most = dailyCents * days;
  if (most < totalCents)
    return ` Zavi does not change the campaign's own ${daily} daily budget in LinkedIn, so over ${days} days it can spend about ${usd(most)} at most, not the full ${usd(totalCents)}.`;
  return "";
}
export const linkedinAdsBoundCampaigns: ToolSpec = {
  name: "linkedin_ads_bound_campaigns",
  effect: "read",
  input_schema: z.object({}).strict(),
  description:
    "List this tenant's bound LinkedIn campaigns, including the shared Zavi advertiser, with each one's name, status, launch_blocker, daily budget, delivery and delivery_note. ACTIVE only means switched on: say spending only as delivery_note allows. Use internal binding IDs for launch review; never enumerate another tenant's campaigns.",
  async execute(ctx) {
    const db = tenantClient(asTenantId(ctx.tenant_id));
    const rows = await boundLinkedinRows(ctx.tenant_id);
    const bindingIds = [...new Set(rows.map((c) => c.account_binding_id))];
    const accounts = new Map<string, string | null>();
    if (bindingIds.length) {
      const a = await db
        .from("ads_account_binding_details")
        .select("id,provider_account_id")
        .in("id", bindingIds);
      if (a.error || !a.data) throw new Error("Campaign inventory is incomplete");
      for (const row of a.data as Array<{ id: string; provider_account_id: string | null }>)
        accounts.set(row.id, row.provider_account_id);
    }
    const candidates = await launchCandidates(ctx.tenant_id, rows);
    const notRead = Math.max(0, rows.length - LAUNCH_READ_LIMIT);
    return {
      ...(notRead ? { not_read_note: `Only the first ${LAUNCH_READ_LIMIT} of ${rows.length} campaigns were read from LinkedIn. The other ${notRead} show no name or status, not because they cannot run: any of them may be launchable. Use linkedin_ads_launch_review on one before saying anything about it.` } : {}),
      campaigns: rows.map((c, i) => ({
        id: c.id,
        provider_campaign_id: c.provider_campaign_id,
        provider_account_id: accounts.get(c.account_binding_id) ?? null,
        funding_source: c.funding_source,
        name: candidates[i].name,
        status: candidates[i].status,
        launch_blocker: candidates[i].launch_blocker,
        daily_budget_cents: candidates[i].daily_budget_cents,
        delivery: candidates[i].delivery,
        delivery_note: candidates[i].delivery_note,
      })),
    };
  },
};
export const linkedinAdsLaunchReview: ToolSpec = {
  name: "linkedin_ads_launch_review",
  effect: "read",
  input_schema: z.object({ campaign_binding_id: z.string().uuid() }).strict(),
  description:
    "Read the original account, currency, campaign and creative launch snapshot for one bound LinkedIn campaign.",
  async execute(ctx, input) {
    return linkedinLaunchSummary(
      ctx.tenant_id,
      (input as { campaign_binding_id: string }).campaign_binding_id,
    );
  },
};
export const linkedinLaunchProposeInput = linkedinLaunchProposal.extend({
  fit_verdict: z.enum(FIT_VERDICTS).optional(),
});
export const LINKEDIN_LAUNCH_NOT_GO =
  "Nothing was proposed: Zavi files a LinkedIn launch only on a go verdict (fit_verdict \"here\"). On not yet or unsure, hand over the audiences and what flips the verdict instead.";
export const LINKEDIN_LAUNCH_NOT_PAUSED =
  "Nothing was proposed: only a paused bound LinkedIn campaign can be launched, and this one is not paused.";
const LAUNCH_WORDS = /\b(launch|relaunch|start|run|go live|spend|turn on|activate|resume|use)\b/i;
const NOT_AN_ORDER = /\?|\b(don'?t|do not|never|not yet|hold off|should|would|could)\b/i;
async function showLaunchCardInChat(tenantId: string, runId: string, cardId: string): Promise<void> {
  const { attachCardToChat } = await import("@/services/approvals/chat-card-attach");
  const shown = await attachCardToChat({ tenant_id: tenantId, run_id: runId, card_id: cardId, table: "channel_actions" }).catch(() => null);
  if (shown?.shown || (shown && shown.reason !== "not_chat")) return;
  const { tellFounderAboutCard } = await import("@/services/approvals/chat-card-delivery");
  await tellFounderAboutCard(tenantId, cardId, "channel_actions");
}
export const linkedinAdsProposeLaunch: ToolSpec = {
  name: "linkedin_ads_propose_launch_campaign",
  effect: "write",
  input_schema: linkedinLaunchProposeInput,
  description:
    "Propose launch of a paused bound LinkedIn campaign with a lifetime cap in the advertiser's currency (hundredths) and end time in milliseconds within one year. Pass this run's fit_verdict; an agent's own proposal is refused unless it is \"here\". Owner/admin approval or Autopilot with paid permission and monthly budget is required. Does not launch or refill a wallet.",
  async execute(ctx, input) {
    const { fit_verdict, ...proposal } = linkedinLaunchProposeInput.parse(input);
    let ask = linkedinLaunchProposal.parse(proposal);
    const founderOrdered = isHumanAuthoredCommand(ctx, "budget") || isFounderChatOrder(ctx);
    const { founderAskFor, founderOrderWordsFor } = await import("@/services/approvals/approval-envelope");
    const founder = await founderAskFor(ctx, "linkedin_ads");
    const words = await founderOrderWordsFor(ctx, "linkedin_ads").catch(() => null);
    const plan = founder?.plan ?? words?.plan ?? null;
    const saidLaunch = !!words && LAUNCH_WORDS.test(words.text) && !NOT_AN_ORDER.test(words.text);
    const explicitOrder = founderOrdered && ctx.founder_order_unverified !== true && (ctx.top_action_run === true || !!plan || saidLaunch);
    if (!explicitOrder && fit_verdict !== "here")
      throw new ExpectedToolError("linkedin_ads_launch_not_go", LINKEDIN_LAUNCH_NOT_GO);
    if (!ctx.emit_decision)
      throw new ExpectedToolError(
        "proposal_unavailable",
        "Launch proposals require a LinkedIn channel run.",
      );
    const cannotRun = founder?.refuse ? founder.line : words?.refuse;
    if (cannotRun) throw new ExpectedToolError("linkedin_ads_launch_would_be_refused", `Nothing was proposed: ${cannotRun}`);
    if (explicitOrder && words) {
      const question = whichCampaignQuestion(words.text, await launchCandidates(ctx.tenant_id, await boundLinkedinRows(ctx.tenant_id)), ask.campaign_binding_id);
      if (question) throw new ExpectedToolError("linkedin_ads_launch_which_campaign", question);
    }
    const s = await linkedinLaunchSummary(
      ctx.tenant_id,
      ask.campaign_binding_id,
    );
    if (s.status !== "PAUSED")
      throw new ExpectedToolError("linkedin_ads_launch_not_paused", LINKEDIN_LAUNCH_NOT_PAUSED);
    let line = founder?.line || words?.line || undefined;
    if (plan) {
      if (s.currency !== "USD")
        throw new ExpectedToolError("linkedin_ads_ask_not_usd", "This LinkedIn account is not in USD, so Zavi cannot run the founder's dollar ask as asked. Tell them to approve a card in the account's currency instead.");
      const askedDailyUsd = founder?.plan ? (founder.asked_daily_usd ?? null) : (words?.asked_daily_usd ?? null);
      const campaignDailyCents = s.daily_budget_cents ?? null;
      if (askedDailyUsd !== null && (campaignDailyCents === null || campaignDailyCents > Math.round(askedDailyUsd * 100)))
        throw new ExpectedToolError("linkedin_ads_launch_would_be_refused", `Nothing was proposed: Zavi launches a LinkedIn campaign with a total and an end date and cannot change its daily budget, which is ${campaignDailyCents === null ? "not set" : `$${(campaignDailyCents / 100).toFixed(2)}`} in LinkedIn, so it could spend more than $${askedDailyUsd} a day. Change the daily budget in LinkedIn Campaign Manager, or ask for a total instead.`);
      const { flightEndMs, utcStamp } = await import("@/services/growth/ad-plan-shape");
      const endMs = flightEndMs({ ...plan, budget_type: "lifetime" }, Date.now());
      ask = { ...ask, total_budget_cents: Math.round(plan.total_usd * 100), end_time: endMs };
      const lower = askedDailyUsd !== null && campaignDailyCents !== null && campaignDailyCents < Math.round(askedDailyUsd * 100);
      line = `${line ?? ""}${line ? " " : ""}It stops ${utcStamp(endMs)}.${lower ? ` The campaign keeps its own $${(campaignDailyCents / 100).toFixed(2)} daily budget in LinkedIn, so it can spend less than you asked.` : askedDailyUsd === null ? pacingWords(ask.total_budget_cents, campaignDailyCents, plan.days) : ""}`;
    }
    const spent = await linkedinRelaunchSpentCents(ctx.tenant_id, s);
    const refusal = await linkedinLaunchFilingRefusal(ctx.tenant_id, s, { ...ask, spent_cents: spent });
    if (refusal) throw new ExpectedToolError("linkedin_ads_launch_would_be_refused", `Nothing was proposed: ${refusal}`);
    const id = await ctx.emit_decision(LINKEDIN_LAUNCH, {
      ...ask,
      snapshot: s.snapshot,
      name: s.name,
      currency: s.currency,
      total_budget_usd: adsUsd(ask.total_budget_cents / 100, s.fx),
      origin: founderOrdered
        ? "user_initiated_chat"
        : "agent",
      daily_budget_cents: s.daily_budget_cents ?? null,
      ...(s.funding_source ? { funding_source: s.funding_source } : {}),
      ...(spent ? { spent_so_far_cents: spent } : {}),
      ...(explicitOrder ? { explicit_order: true as const } : {}),
    });
    if (founderOrdered && typeof id === "string" && ctx.run_id) await showLaunchCardInChat(ctx.tenant_id, ctx.run_id, id);
    return { action_id: id, status: "proposed", ...(line ? { say_to_founder: founder?.plan && founder.source === "ask" ? await (await import("@/services/approvals/envelope-door")).directAskSay(ctx.tenant_id, id, line, "LinkedIn") : line } : {}) };
  },
};
