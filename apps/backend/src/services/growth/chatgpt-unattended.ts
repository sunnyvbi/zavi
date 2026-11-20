import { withChatgptBudgetCampaign } from "@/services/ads-wallet/chatgpt-budget-identity";
import { founderSetBudgetReason } from "./founder-set-budget";
import { budgetTestReasons } from "./budget-test-shape";
import { currentBoundCampaign } from "@/services/ads-wallet/campaign-context";
import { previewChatgptAccount } from "@/services/ads-wallet/chatgpt-account-preview";
import { campaignActionRequestId } from "@/services/connectors/chatgpt-ads/action-execution";
import { ownedCampaign, CHATGPT_MIN_DAILY_MICROS } from "@/services/connectors/chatgpt-ads/workspace";
import { adsFx, adsUsd } from "@/services/ads-wallet/fx";
import type { UnattendedAction, UnattendedVerdict } from "./unattended-policy";
import {
  CHATGPT_GROWTH_CLASSES,
  parseGrowthAction,
  growthCampaignBudget,
} from "@/services/connectors/chatgpt-ads/growth-actions";
import { readCampaignTree } from "@/services/connectors/chatgpt-ads/workspace";
import {
  launchSnapshot,
  readLaunchSummary,
} from "@/services/connectors/chatgpt-ads/launch";
import { assertServingReady } from "@/services/connectors/chatgpt-ads/serving";
import { checkAgentTier } from "@/services/agents/entitlement";
import { isChannelLockedStrict } from "@/services/channels/lock";
import { CGO_MAX_RAISE_STEP } from "./cgo-spend-authority";

export type ChatgptUnattendedFacts = { reasons: string[] };
export function evaluateChatgptUnattended(
  f?: ChatgptUnattendedFacts,
): UnattendedVerdict {
  const reasons = f?.reasons ?? ["chatgpt_facts_unavailable"];
  return { verdict: reasons.length ? "ask_founder" : "allow", reasons };
}
async function loadBoundChatgptUnattended(
  tenantId: string,
  action: Extract<UnattendedAction, { kind: "ad" }>,
  now: Date,
): Promise<ChatgptUnattendedFacts> {
  const reasons: string[] = [];
  if (!CHATGPT_GROWTH_CLASSES.has(action.exec_class))
    return { reasons: ["class_not_on_unattended_list"] };
  const parsed = parseGrowthAction(action.exec_class, action.payload);
  const {
    readChannelAutorun,
    loadOpenAdviceForAd,
    loadPausedByFounder,
    loadFounderSetBudget,
    loadZaviRaisedRecently,
  } = await import("./unattended-policy");
  const { cgoAdBudget } = await import("./cgo-ads");
  if (!(await readChannelAutorun(tenantId, "chatgpt_ads")))
    reasons.push("chatgpt_paid_consent_required");
  if (!(await cgoAdBudget(tenantId, now)))
    reasons.push("active_growth_budget_and_autopilot_required");
  if (
    !(await checkAgentTier(tenantId, "chatgpt_ads")).allowed ||
    (await isChannelLockedStrict("chatgpt_ads"))
  )
    reasons.push("channel_unavailable");
  if (parsed.value.origin !== "agent") reasons.push("founder_requested_change");
  const advice = await loadOpenAdviceForAd(tenantId, action);
  if (!advice.refsResolved || advice.openAdvice !== "clear")
    reasons.push("open_advice_unresolved");
  if (parsed.kind === "status" && parsed.value.status === "PAUSED")
    reasons.push("pause_needs_founder");
  if (
    parsed.kind === "budget" &&
    parsed.value.daily_budget_usd <=
      parsed.value.expected_current_daily_budget_usd
  )
    reasons.push("budget_cut_needs_founder");
  if (reasons.length) return { reasons };

  if (parsed.kind === "create") {
    const { fundingLimit, validateSchedule } =
      await import("@/services/connectors/chatgpt-ads/campaign-settings");
    const { readChatgptFundingContext } =
      await import("@/services/channels/chatgpt-ads/funding-context");
    const account = await previewChatgptAccount(
      tenantId,
      campaignActionRequestId(action.source.id, "growth-campaign"),
    );
    await assertServingReady(account.key, account.fundingSource);
    await adsFx(account.account.currency_code!);
    const campaign = parsed.value.bundle.campaign;
    const planned = {
      ...campaign,
      budget: growthCampaignBudget(campaign),
      created_at: now.getTime() / 1000,
    };
    validateSchedule(planned, now.getTime() / 1000);
    if (account.fundingSource === "wallet") {
      const wallet = await readChatgptFundingContext(tenantId);
      if (wallet.status !== "read") reasons.push("chatgpt_wallet_unknown");
      else if (
        wallet.available_cents < Math.ceil(fundingLimit(planned) / 10000)
      )
        reasons.push("chatgpt_wallet_insufficient");
    }
  }
  if (parsed.kind !== "create") {
    const p = parsed.value;
    const providerId =
      currentBoundCampaign()?.provider_campaign_id ?? p.campaign_id;
    const tree = await readCampaignTree(tenantId, providerId);
    const owned = await ownedCampaign(tenantId, providerId);
    await assertServingReady(owned.key, owned.binding.funding_source);
    const fx = await adsFx(tree.providerCurrency ?? "USD");
    const c = tree.campaign;
    if (c.updated_at !== p.expected_updated_at)
      reasons.push("campaign_changed");
    if (
      !Number.isSafeInteger(c.budget?.daily_spend_limit_micros) ||
      c.budget.daily_spend_limit_micros < CHATGPT_MIN_DAILY_MICROS
    )
      reasons.push("daily_budget_required");
    if (
      c.status === "archived" ||
      !Number.isFinite(c.end_time) ||
      c.end_time <= now.getTime() / 1000
    )
      reasons.push("campaign_ended_or_archived");
    if (parsed.kind === "status") {
      if (parsed.value.status === "ACTIVE") {
        const summary = await readLaunchSummary(tenantId, providerId);
        if (summary.snapshot !== parsed.value.snapshot)
          reasons.push("campaign_changed");
        if (
          summary.funding_source !== "provider" &&
          (!summary.wallet?.funding_enabled || summary.shortfall_cents == null)
        )
          reasons.push("chatgpt_wallet_unknown");
        else if ((summary.shortfall_cents ?? 0) > 0)
          reasons.push("chatgpt_wallet_insufficient");
      }
      if (launchSnapshot(tree) !== parsed.value.snapshot)
        reasons.push("campaign_changed");
      let ownPausedCreate = false;
      if (c.status !== "active") {
        const owner = await loadPausedByFounder(
          tenantId,
          "chatgpt",
          p.campaign_id,
        );
        if (
          owner.pausedByFounder !== false ||
          (owner.firstOwnEnable &&
            (!Number.isFinite(c.created_at) ||
              !Number.isFinite(c.updated_at) ||
              c.updated_at > c.created_at + 60))
        )
          reasons.push("founder_pause_or_unknown");
        else
          ownPausedCreate =
            owner.firstOwnEnable &&
            [...tree.groups, ...tree.ads].every(
              (x) =>
                Number.isFinite(x.created_at) &&
                Number.isFinite(x.updated_at) &&
                x.updated_at <= x.created_at + 60,
            );
      }
      const childOff =
        tree.groups.some((g) => g.status !== "active") ||
        tree.ads.some(
          (a) =>
            !/reject|disapprov|denied/i.test(String(a.review_status ?? "")) &&
            a.status !== "active",
        );
      if (parsed.value.status === "ACTIVE" && childOff && !ownPausedCreate)
        reasons.push("founder_pause_or_unknown");
    } else {
      if (
        c.status !== "active" ||
        adsUsd(c.budget.daily_spend_limit_micros / 1e6, fx) !==
          parsed.value.expected_current_daily_budget_usd
      )
        reasons.push("campaign_changed");
      if (
        parsed.value.daily_budget_usd >
        parsed.value.expected_current_daily_budget_usd *
          (1 + CGO_MAX_RAISE_STEP)
      )
        reasons.push("raise_step_too_large");
      if (
        await loadZaviRaisedRecently(
          tenantId,
          "chatgpt",
          p.campaign_id,
          action.source,
          now,
        )
      )
        reasons.push("raised_recently");
      const direction =
        parsed.value.daily_budget_usd > parsed.value.expected_current_daily_budget_usd
          ? "up"
          : parsed.value.daily_budget_usd < parsed.value.expected_current_daily_budget_usd
            ? "down"
            : "same";
      const founderSet = await loadFounderSetBudget(tenantId, "chatgpt", p.campaign_id, now, direction);
      if (founderSet) reasons.push(founderSetBudgetReason(founderSet, "chatgpt"));
      const { loadBudgetTestFact } = await import("./budget-tests");
      reasons.push(...budgetTestReasons(await loadBudgetTestFact(tenantId, "chatgpt", p.campaign_id, action.source.run_id, now)));
    }
  }
  return { reasons };
}

export async function loadChatgptUnattended(
  tenantId: string,
  action: Extract<UnattendedAction, { kind: "ad" }>,
  now: Date,
): Promise<ChatgptUnattendedFacts> {
  const parsed = parseGrowthAction(action.exec_class, action.payload);
  return parsed.kind === "create"
    ? loadBoundChatgptUnattended(tenantId, action, now)
    : withChatgptBudgetCampaign(tenantId, parsed.value.campaign_id, () =>
        loadBoundChatgptUnattended(tenantId, action, now),
      );
}
