
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import {
  createCampaignBodySchema,
  deleteCampaignBodySchema,
  metaBidStrategySchema,
  metaCampaignObjectiveSchema,
  metaSpecialAdCategorySchema,
  updateCampaignBodySchema,
} from "./_decision-bodies";
import { readTenantCapAndToday } from "./cap-reader";
import { formatMoney } from "./_currency";
import { getAdAccountCurrency } from "../_client";
import { liveSpendCap, readOwnCampaign } from "./campaign_writes";
import { unitsPerUsd } from "./_fx-rate";

type Emit = (decision_class: string, body: unknown) => Promise<string>;

async function preflight(ctx: ToolContext): Promise<Emit> {
  if (!(await isMetaAdsWriteEnabled())) {
    throw new ExpectedToolError("meta_ads_write_disabled", "Meta Ads write is disabled at the platform level.");
  }
  if (typeof ctx.emit_decision !== "function") {
    throw new ExpectedToolError("meta_ads_propose_no_emit", "Cannot emit a decision in this context (no emit_decision plumbed).");
  }
  return ctx.emit_decision;
}

function originOf(ctx: ToolContext): { origin: "user_initiated_chat" } | Record<string, never> {
  return isHumanAuthoredCommand(ctx, "budget") ? { origin: "user_initiated_chat" } : {};
}

function parsedOrThrow<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ExpectedToolError("meta_ads_invalid_campaign_body", `This ${what} cannot be made as specified: ${r.error.issues.map((i) => i.message).join(" | ")}`);
  }
  return r.data;
}

const MIN_SPEND_CAP_USD = 100;

const newCampaignInput = z.object({
  name: z.string().min(1).max(200),
  objective: metaCampaignObjectiveSchema,
  special_ad_categories: z
    .array(metaSpecialAdCategorySchema)
    .optional()
    .describe("Only when the ads are about jobs, housing, credit/financial products or politics. Needs special_ad_category_country."),
  special_ad_category_country: z.array(z.string()).optional().describe("2-letter country codes the special category applies in."),
  daily_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("Give it to have the CAMPAIGN hold the budget (Advantage campaign budget), in the ad account's currency. Omit when each ad set will hold its own."),
  bid_strategy: metaBidStrategySchema.optional().describe("Only with daily_budget_usd. Default lowest cost."),
  about: z.string().optional().describe("ONE plain sentence on what this campaign is for. Shown on the card."),
  rationale: rationaleInput(),
});

export const metaProposeNewCampaignTool: ToolSpec = {
  name: "meta_ads_propose_new_campaign",
  effect: "money",
  description:
    "Propose a new Meta campaign. It is created PAUSED and spends nothing until its ad sets and ads exist and something is switched on. A card the founder, or cgo on Autopilot with an ad budget, approves.",
  input_schema: newCampaignInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const a = newCampaignInput.parse(input);
    const { cap, currency } = await readTenantCapAndToday(ctx.tenant_id);
    if (a.daily_budget_usd !== undefined && cap?.enabled && cap.max_daily_budget_usd != null && a.daily_budget_usd > cap.max_daily_budget_usd) {
      throw new ExpectedToolError(
        "meta_ads_proposal_over_absolute_cap",
        `Proposed daily budget ${formatMoney(a.daily_budget_usd, currency)} exceeds the tenant ceiling ${formatMoney(cap.max_daily_budget_usd, currency)}.`,
      );
    }
    const body = parsedOrThrow(createCampaignBodySchema, { ...a, currency, ...originOf(ctx) }, "campaign");
    const decision_id = await emit("meta_ads.create_campaign", body);
    return { decision_id, decision_class: "meta_ads.create_campaign", notice: "Sent to approvals. Once approved it is created PAUSED." };
  },
};

const updateCampaignInput = z.object({
  campaign_id: z.string().min(1).describe("Ids only from list_campaigns this turn."),
  new_name: z.string().min(1).max(200).optional(),
  spend_cap_usd: z
    .number()
    .positive()
    .optional()
    .describe("A lifetime ceiling the campaign can never spend past, in the account's currency (Meta's minimum is about $100)."),
  remove_spend_cap: z.boolean().optional().describe("true removes the campaign's spend cap."),
  bid_strategy: metaBidStrategySchema.optional().describe("Only on a campaign that holds its own budget."),
  special_ad_categories: z.array(metaSpecialAdCategorySchema).optional().describe("The full new list ([] for none)."),
  special_ad_category_country: z.array(z.string()).optional(),
  name: z.string().optional().describe("The campaign's current name, for the card."),
  about: z.string().optional(),
  rationale: rationaleInput(),
});

export const metaProposeCampaignUpdateTool: ToolSpec = {
  name: "meta_ads_propose_campaign_update",
  effect: "money",
  description:
    "Propose changing a Meta campaign's name, spend cap, bid strategy or special ad categories. Budget and on/off have their own tools; end dates live on ad sets. A card the founder, or cgo on Autopilot with an ad budget, approves.",
  input_schema: updateCampaignInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const { remove_spend_cap, ...a } = updateCampaignInput.parse(input);
    if (remove_spend_cap && a.spend_cap_usd !== undefined) {
      throw new ExpectedToolError("meta_ads_invalid_campaign_body", "Give spend_cap_usd or remove_spend_cap, not both.");
    }
    const spend_cap_usd: number | null | undefined = remove_spend_cap ? null : a.spend_cap_usd;
    const live = await readOwnCampaign(ctx.tenant_id, a.campaign_id);
    const currency = await getAdAccountCurrency(ctx.tenant_id);
    if (spend_cap_usd != null && spend_cap_usd < MIN_SPEND_CAP_USD * (await unitsPerUsd(currency))) {
      throw new ExpectedToolError(
        "meta_ads_invalid_campaign_body",
        `Meta's smallest spend cap is about ${formatMoney(MIN_SPEND_CAP_USD, "USD")} (or the local equivalent).`,
      );
    }
    const body = parsedOrThrow(
      updateCampaignBodySchema,
      {
        ...a,
        currency,
        name: a.name ?? live.name,
        ...(spend_cap_usd !== undefined ? { spend_cap_usd, expected_current_spend_cap_usd: liveSpendCap(live, currency) } : {}),
        ...(a.bid_strategy !== undefined ? { expected_current_bid_strategy: live.bid_strategy ?? null } : {}),
        ...originOf(ctx),
      },
      "campaign change",
    );
    const decision_id = await emit("meta_ads.update_campaign", body);
    return { decision_id, decision_class: "meta_ads.update_campaign", notice: "Sent to approvals." };
  },
};

const deleteCampaignInput = z.object({
  campaign_id: z.string().min(1).describe("Ids only from list_campaigns this turn."),
  about: z.string().optional(),
  rationale: rationaleInput(),
});

export const metaProposeCampaignDeleteTool: ToolSpec = {
  name: "meta_ads_propose_campaign_delete",
  effect: "money",
  description:
    "Propose DELETING a Meta campaign with its ad sets and ads. It cannot be undone; prefer a pause unless the founder asked to delete. Only the founder can approve it.",
  input_schema: deleteCampaignInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const a = deleteCampaignInput.parse(input);
    const live = await readOwnCampaign(ctx.tenant_id, a.campaign_id);
    const body = parsedOrThrow(deleteCampaignBodySchema, { ...a, name: live.name, ...originOf(ctx) }, "delete");
    const decision_id = await emit("meta_ads.delete_campaign", body);
    return { decision_id, decision_class: "meta_ads.delete_campaign", notice: "Sent to approvals. Only the founder can approve a delete." };
  },
};
