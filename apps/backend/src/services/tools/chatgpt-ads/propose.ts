import { adsFx, adsUsd } from "@/services/ads-wallet/fx";
import { previewChatgptAccount } from "@/services/ads-wallet/chatgpt-account-preview";
import { readFundingContext } from "@/services/ads-wallet/funding-context";
import { campaignFundingPreview, walletDailyPlan } from "@/services/channels/chatgpt-ads/proposal-readiness";
import { remainingWalletRequest } from "@/services/channels/chatgpt-ads/wallet-request";
import type { ToolContext, ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import {
  resolveChannelExecEmit,
  type ExecEmitCtx,
} from "@/services/channels/exec-emit";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import {
  CHATGPT_CREATE,
  CHATGPT_BUDGET,
  CHATGPT_STATUS,
  CHATGPT_GROWTH_CLASSES,
  parseGrowthAction,
  growthBundle,
  growthBundleInput,
  growthCreateBody,
  growthBudgetInput,
  growthStatusInput,
} from "@/services/connectors/chatgpt-ads/growth-actions";
import { readCampaignTree } from "@/services/connectors/chatgpt-ads/workspace";
import { launchSnapshot } from "@/services/connectors/chatgpt-ads/launch";
import { withChatgptBudgetCampaign } from "@/services/ads-wallet/chatgpt-budget-identity";
import { checkGeneratedAdImage, generatedAdImagePath } from "@/services/connectors/chatgpt-ads/generated-image";
import { checkOwnImageForVendor } from "@/services/chat-images/sign-own-image";
import { adsNoFrictionEnabled } from "@/services/growth/ads-no-friction-flag";
import { flightEndMs, utcStamp, type AdPlan } from "@/services/growth/ad-plan-shape";
import { founderAskFor } from "@/services/approvals/approval-envelope";

export async function resolveChatgptAdsEmit(ctx: ExecEmitCtx) {
  return resolveChannelExecEmit(new Set(["chatgpt_ads"]), ctx, async (a) => {
    if (!CHATGPT_GROWTH_CLASSES.has(a.decision_class))
      throw new ExpectedToolError(
        "channel_action_class_unknown",
        "Unknown ChatGPT action; nothing was proposed.",
      );
    const parsed = parseGrowthAction(a.decision_class, a.body);
    const rows: Array<{ item: string; before: string; after: string }> =
      parsed.kind === "create"
        ? [
            {
              item: "Campaign",
              before: "Not created",
              after: `${parsed.value.bundle.campaign.name} · create and launch`,
            },
            {
              item: createBudget(parsed.value).item,
              before: "None",
              after: createBudget(parsed.value).after,
            },
            {
              item: "Schedule (UTC)",
              before: "None",
              after: `${new Date(parsed.value.bundle.campaign.start_time * 1000).toISOString()} → ${new Date(parsed.value.bundle.campaign.end_time * 1000).toISOString()}`,
            },
            {
              item: "Targeting",
              before: "None",
              after: JSON.stringify(parsed.value.bundle.campaign.targeting),
            },
            {
              item: "Ad group and bidding",
              before: "None",
              after: JSON.stringify(parsed.value.bundle.group),
            },
            ...parsed.value.bundle.ads.map((ad, i) => ({
              item: `Ad ${i + 1}`,
              before: "None",
              after: JSON.stringify(ad),
            })),
          ]
        : parsed.kind === "budget"
          ? [
              {
                item: "Daily budget",
                before: `$${parsed.value.expected_current_daily_budget_usd}/day`,
                after: `$${parsed.value.daily_budget_usd}/day`,
              },
            ]
          : [
              {
                item: "Campaign status",
                before: "Current version captured",
                after: parsed.value.status,
              },
              ...(parsed.value.status === "ACTIVE" && parsed.value.preview
                ? (({
                    daily_budget_usd: d,
                    lifetime_budget_usd: l,
                    start_time: s,
                    end_time: e,
                    groups_to_activate: g,
                    ads_to_activate: n,
                  }) => [
                    {
                      item: "Budget",
                      before: "Unchanged",
                      after:
                        d !== null
                          ? `$${d}/day`
                          : l !== null
                            ? `$${l} lifetime`
                            : "None set",
                    },
                    {
                      item: "Schedule (UTC)",
                      before: "Unchanged",
                      after: `${s !== null ? new Date(s * 1000).toISOString() : "now"} → ${e !== null ? new Date(e * 1000).toISOString() : "no end"}`,
                    },
                    {
                      item: "Also turned on",
                      before: "Off",
                      after: `${g} ad group(s), ${n} ad(s)`,
                    },
                  ])(parsed.value.preview)
                : []),
            ];
    const changeSentence =
      parsed.kind === "create"
        ? `Create and launch ${parsed.value.name} at ${createBudget(parsed.value).after}, from ${new Date(parsed.value.bundle.campaign.start_time * 1000).toISOString()} to ${new Date(parsed.value.bundle.campaign.end_time * 1000).toISOString()} (UTC).`
        : parsed.kind === "budget"
          ? `Change ${parsed.value.name} from $${parsed.value.expected_current_daily_budget_usd}/day to $${parsed.value.daily_budget_usd}/day.`
          : `${parsed.value.status === "ACTIVE" ? "Launch" : "Pause"} ${parsed.value.name}.`;
    const creating = a.decision_class === CHATGPT_CREATE;
    const title =
      `${creating ? "Create and launch" : a.decision_class === CHATGPT_BUDGET ? "Change daily budget for" : a.body.status === "ACTIVE" ? "Launch" : "Pause"} ${String(a.body.name)}`.slice(
        0,
        300,
      );
    const bundle = a.body.bundle as
      | { summary?: string; rationale?: string }
      | undefined;
    const shown = parsed.kind === "create" ? parsed.value.bundle.ads.find((ad) => ad.image_artifact_id) : undefined;
    const media = shown?.image_artifact_id
      ? { kind: "image", artifact_id: shown.image_artifact_id, storage_path: await generatedAdImagePath(a.tenant_id, shown.image_artifact_id), bucket: "agent-artifacts", alt: shown.title }
      : null;
    const { id, kept } = await recordChannelExecAction({
      tenantId: a.tenant_id,
      runId: a.run_id,
      channelSlug: a.channel_slug,
      execClass: a.decision_class,
      execPayload: a.body,
      actionType: creating
        ? "create_ad"
        : a.body.status === "PAUSED"
          ? "pause_ad"
          : "update_ad",
      title,
      body: {
        step: {
          title,
          body: creating ? changeSentence : `${changeSentence}\n\n${bundle?.summary ?? a.body.summary}\n\n${bundle?.rationale ?? a.body.rationale}`,
          responsibility: "client",
          blocking: false,
          effort: "minutes",
          evidence: [],
        },
        change_sentence: changeSentence,
        exact_change: {
          rows: [
            ...rows,
            {
              item: "Currency",
              before: "",
              after:
                "USD budget estimates; non-USD account amounts converted using ExchangeRate-API daily rates (https://www.exchangerate-api.com). Provider billing uses the account currency.",
            },
          ],
        },
        link: "/channels/chatgpt_ads",
        ...(media ? { media } : {}),
      },
    });
    if (kept && a.body.top_up_authorized === false)
      throw new ExpectedToolError("chatgpt_ads_conflict", "An open card for this campaign already exists, so no wallet-only card was filed and nothing was charged. Open that card and use Edit ad to change its schedule, then review the updated funding before approval.");
    return id;
  });
}
async function emit(ctx: ToolContext, cls: string, body: unknown) {
  if (!ctx.emit_decision)
    throw new ExpectedToolError(
      "proposal_unavailable",
      "Campaign proposals are unavailable in this run. Nothing changed.",
    );
  return {
    action_id: await ctx.emit_decision(cls, body),
    status: "proposed",
    message:
      "Proposed only. Approval and fresh Growth, wallet and platform checks are required before execution.",
  };
}
const origin = (ctx: ToolContext, kind: "budget" | "status") =>
  isHumanAuthoredCommand(ctx, kind) ? "user_initiated_chat" : "agent";
function createBudget(v: { daily_budget_usd?: number; lifetime_budget_usd?: number; currency: string; bundle: { campaign: { daily_budget_micros?: number; lifetime_budget_micros?: number } } }) {
  const fx = v.currency !== "USD" ? ` USD (converted from ${v.currency})` : "";
  const c = v.bundle.campaign;
  if (c.lifetime_budget_micros != null)
    return { item: "Lifetime budget", after: `$${v.lifetime_budget_usd ?? c.lifetime_budget_micros / 1e6} total${fx}` };
  return { item: "Daily budget", after: `$${v.daily_budget_usd ?? c.daily_budget_micros! / 1e6}/day${fx}` };
}
export const chatgptAdsProposeNewCampaign: ToolSpec = {
  name: "chatgpt_ads_propose_new_campaign",
  effect: "write",
  input_schema: growthBundleInput,
  description:
    'When the founder asked for this ad directly (founder_direct_ask) on a USD account, omit campaign budget, start_time and end_time: the server sets them from the ask and never spends more; supply the copy, image, link, targeting and group only. On a non-USD account, or if this tool says so, send the complete campaign with its budget and dates. Otherwise propose a campaign (a daily budget or one lifetime total), group and 1–2 image ads or a verified catalog template. Automatic bidding: set group.strategy="maximize_clicks" for campaign.bidding_type="clicks", or "maximize_conversions" for "conversions"; omit group.max_bid_micros. Fixed bidding (the default) requires group.max_bid_micros. Target countries via campaign.targeting.locations.countries (string array). Each image ad uses name, title, body, target_url and exactly one image_artifact_id (from report.generate_image/render_social_image), image_path (private workspace path) or image_url (public HTTPS). Reuse generated artifacts without hosting them. Requires start/end times (at most 90 days) and either a lifetime total or at least $25/day; a lifetime total needs fixed bidding. Proposes only; approval, Growth capacity, funding and serving checks still apply. Never refills a wallet.',
  async execute(ctx, input) {
    const ask = await founderAskFor(ctx, "chatgpt_ads");
    const early = ask?.plan ? null : growthBundle.parse(input);
    const { account, fundingSource } = await previewChatgptAccount(ctx.tenant_id);
    const fx = await adsFx(account.currency_code!);
    let founderLine: string | undefined = ask?.line;
    let bundle: ReturnType<typeof growthBundle.parse>;
    if (early) bundle = early;
    else if (ask?.plan && fx.currency === "USD") {
      bundle = shapeChatgptBundle(input, ask.plan, Date.now());
      founderLine = `${ask.line} It stops ${utcStamp(bundle.campaign.end_time * 1000)}.`;
    } else {
      founderLine = "Your ChatGPT ad account is not in USD, so this is a card for you to approve.";
      const full = growthBundle.safeParse(input);
      if (!full.success)
        throw new ExpectedToolError(
          "chatgpt_ads_conflict",
          `This ChatGPT account is not in USD, so the founder's dollar ask cannot set the budget and dates. Nothing was filed. Propose again with a complete campaign: a budget (daily_budget_micros or lifetime_budget_micros, in the account's currency), start_time and end_time, sized to the founder's ask. ${full.error.issues.map((i) => `${i.path.join(".") || "bundle"}: ${i.message}`).join("; ")}`,
        );
      bundle = full.data;
    }
    if (bundle.campaign.lifetime_budget_micros != null && !(await adsNoFrictionEnabled()))
      throw new ExpectedToolError("chatgpt_ads_conflict", "Lifetime ChatGPT campaigns are turned off. Propose a daily budget.");
    for (const ad of bundle.ads) {
      if (ad.image_artifact_id) await checkGeneratedAdImage(ctx.tenant_id, ad.image_artifact_id);
      if (ad.image_path) await checkOwnImageForVendor(ctx.tenant_id, ad.image_path);
    }
    const estimatedAt = Date.now();
    const wallet = fundingSource === "wallet" ? await readFundingContext(ctx.tenant_id) : null;
    let walletOnly: boolean;
    try {
      walletOnly = await remainingWalletRequest(ctx);
    } catch {
      throw new ExpectedToolError("chatgpt_ads_conflict", "Could not verify the original request's wallet constraint. Nothing was proposed. Try again.");
    }
    if (walletOnly) {
      if (fundingSource !== "wallet" || fx.currency !== "USD" || wallet?.status !== "read")
        throw new ExpectedToolError("chatgpt_ads_conflict", "The available USD wallet balance could not be verified for this account. Nothing was proposed.");
      const before = campaignFundingPreview(bundle.campaign, { fundingSource, currency: fx.currency }, wallet, estimatedAt);
      if (before.status !== "covered") {
        if (bundle.campaign.lifetime_budget_micros != null && before.status === "insufficient" && wallet.available_cents >= 100) {
          bundle = growthBundle.parse({ ...bundle, campaign: { ...bundle.campaign, lifetime_budget_micros: wallet.available_cents * 10_000 } });
        } else {
          const plan = walletDailyPlan(wallet, estimatedAt, bundle.campaign.daily_budget_micros, bundle.campaign)
            ?? walletDailyPlan(wallet, estimatedAt, undefined, bundle.campaign);
          if (bundle.campaign.lifetime_budget_micros != null || !plan)
            throw new ExpectedToolError("chatgpt_ads_conflict", "No covered campaign fits the original schedule and available wallet. This keeps the wallet-only limit the founder asked for earlier in this conversation. Reduce its total or daily budget, choose new dates, or ask for a new campaign to plan without that limit; no top-up was authorized.");
          bundle = growthBundle.parse({ ...bundle, campaign: { ...bundle.campaign, daily_budget_micros: plan.daily_budget_micros, start_time: plan.start_time, end_time: plan.end_time } });
        }
      }
      const campaign = bundle.campaign;
      const walletBudget = campaign.lifetime_budget_micros != null
        ? `$${(campaign.lifetime_budget_micros / 1e6).toFixed(2)} total`
        : `$${(campaign.daily_budget_micros! / 1e6).toFixed(2)}/day for the proposed schedule (not a lifetime spend cap)`;
      founderLine = ask?.plan
        ? `Your request approves launching this campaign at ${walletBudget} from your existing wallet, with no card charge or wallet top-up. It is being submitted for launch; the execution result will confirm whether it starts.`
        : "The proposal fits the available wallet coverage at this check. Review its budget and schedule. A daily budget is not a lifetime spend cap. Approval and fresh funding checks are still required. No wallet top-up is authorized by this request.";
    }
    const fundingPreview = campaignFundingPreview(bundle.campaign, { fundingSource, currency: fx.currency }, wallet, estimatedAt);
    const proposal = await emit(ctx, CHATGPT_CREATE, dispatchReadyBody({
      bundle,
      name: bundle.campaign.name,
      origin: origin(ctx, "budget"),
      currency: fx.currency,
      ...(walletOnly ? { top_up_authorized: false } : {}),
      ...(bundle.campaign.lifetime_budget_micros != null
        ? { lifetime_budget_usd: adsUsd(bundle.campaign.lifetime_budget_micros / 1e6, fx) }
        : { daily_budget_usd: adsUsd(bundle.campaign.daily_budget_micros! / 1e6, fx) }),
    }));
    if (ask?.plan && ask.source === "ask") {
      const { directAskSay } = await import("@/services/approvals/envelope-door");
      founderLine = await directAskSay(ctx.tenant_id, proposal.action_id, founderLine, "ChatGPT");
    }
    return { ...proposal, funding_preview: fundingPreview, ...(founderLine ? { say_to_founder: founderLine } : {}) };
  },
};

export function dispatchReadyBody<T extends Record<string, unknown>>(body: T): T {
  const checked = growthCreateBody.safeParse(body);
  if (!checked.success)
    throw new ExpectedToolError(
      "chatgpt_ads_conflict",
      `This proposal would be refused when it runs, so nothing was filed. Fix and propose again: ${checked.error.issues.map((i) => `${i.path.join(".") || "bundle"}: ${i.message}`).join("; ")}`,
    );
  return body;
}

export function shapeChatgptBundle(input: unknown, plan: AdPlan, nowMs: number): ReturnType<typeof growthBundle.parse> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const start = Math.max(Math.floor(nowMs / 1000) + 600, Date.parse(`${plan.start}T00:00:00Z`) / 1000);
  const end = Math.floor(flightEndMs(plan, start * 1000) / 1000);
  const { daily_budget_micros: _d, lifetime_budget_micros: _l, start_time: _s, end_time: _e, ...rest } = (raw.campaign ?? {}) as Record<string, unknown>;
  const campaign = plan.budget_type === "lifetime"
    ? { ...rest, lifetime_budget_micros: Math.round(plan.total_usd * 1e6), start_time: start, end_time: end }
    : { ...rest, daily_budget_micros: Math.round(plan.daily_usd! * 1e6), start_time: start, end_time: end };
  const parsed = growthBundle.safeParse({ ...raw, campaign });
  if (!parsed.success) {
    const auto = raw.group?.strategy && raw.group.strategy !== "fixed_bid";
    throw new ExpectedToolError(
      "chatgpt_ads_conflict",
      plan.budget_type === "lifetime" && auto
        ? `The founder asked for one total ($${plan.total_usd.toFixed(2)}). A lifetime total needs fixed bidding: set group.strategy "fixed_bid" with group.max_bid_micros, and propose again.`
        : `The founder's ask could not be built. Fix these and propose again (leave the budget and dates out): ${parsed.error.issues.map((i) => `${i.path.join(".") || "bundle"}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}
export const chatgptAdsProposeBudgetChange: ToolSpec = {
  name: "chatgpt_ads_propose_budget_change",
  effect: "write",
  input_schema: growthBudgetInput,
  description:
    "Propose changing an owned ChatGPT campaign's daily budget. Reads its current amount/version; execution refuses drift. Lifetime campaigns require manual review. Never adds wallet funds.",
  async execute(ctx, input) {
    const value = growthBudgetInput.parse(input),
      { campaign, binding, providerCurrency } = await withChatgptBudgetCampaign(
        ctx.tenant_id,
        value.campaign_id,
        (id) => readCampaignTree(ctx.tenant_id, id),
      );
    const daily = campaign.budget?.daily_spend_limit_micros;
    if (
      !Number.isSafeInteger(daily) ||
      daily < 25e6 ||
      !Number.isSafeInteger(campaign.updated_at)
    )
      throw new ExpectedToolError(
        "chatgpt_ads_conflict",
        "An owned daily-budget campaign with a current version is required.",
      );
    return emit(ctx, CHATGPT_BUDGET, {
      ...value,
      campaign_id:
        binding?.funding_source === "provider" ? binding.id : value.campaign_id,
      name: campaign.name,
      origin: origin(ctx, "budget"),
      expected_updated_at: campaign.updated_at,
      expected_current_daily_budget_usd: adsUsd(
        daily / 1e6,
        await adsFx(providerCurrency ?? "USD"),
      ),
    });
  },
};
export const chatgptAdsProposeStatus: ToolSpec = {
  name: "chatgpt_ads_propose_status",
  effect: "write",
  input_schema: growthStatusInput,
  description:
    "Propose launching/resuming or pausing an owned ChatGPT campaign. Captures the exact campaign, ad group and creative settings. Pauses and founder-paused campaigns require founder approval. Does not execute or refill the wallet.",
  async execute(ctx, input) {
    const value = growthStatusInput.parse(input),
      tree = await withChatgptBudgetCampaign(
        ctx.tenant_id,
        value.campaign_id,
        (id) => readCampaignTree(ctx.tenant_id, id),
      );
    const fx =
      value.status === "PAUSED"
        ? null
        : await adsFx(tree.providerCurrency ?? "USD");
    const c = tree.campaign,
      usd = (v: unknown) =>
        typeof v === "number" && fx ? adsUsd(v / 1e6, fx) : null,
      at = (v: unknown) => (typeof v === "number" ? v : null);
    const preview = {
      currency: tree.providerCurrency ?? "USD",
      daily_budget_usd: usd(c.budget?.daily_spend_limit_micros),
      lifetime_budget_usd: usd(c.budget?.lifetime_spend_limit_micros),
      start_time: at(c.start_time),
      end_time: at(c.end_time),
      groups_to_activate: tree.groups.filter((g) => g.status !== "active")
        .length,
      ads_to_activate: tree.ads.filter(
        (a) =>
          a.status !== "active" &&
          !/reject|disapprov|denied/i.test(String(a.review_status ?? "")),
      ).length,
    };
    return emit(ctx, CHATGPT_STATUS, {
      ...value,
      campaign_id:
        tree.binding?.funding_source === "provider"
          ? tree.binding.id
          : value.campaign_id,
      name: c.name,
      origin: origin(ctx, "status"),
      expected_updated_at: c.updated_at,
      snapshot: launchSnapshot(tree),
      preview,
    });
  },
};
