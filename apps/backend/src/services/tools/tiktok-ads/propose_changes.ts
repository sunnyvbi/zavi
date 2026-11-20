
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { tiktokAdsAccount } from "@/services/connectors/tiktok-ads/composio-read";
import { ensureAdAccounts } from "@/services/connectors/tiktok-ads/ad-accounts";
import { isDailyMode, readTiktokObject } from "@/services/connectors/tiktok-ads/objects";
import { readTiktokResumePlan, resumeDailyBudget } from "@/services/connectors/tiktok-ads/status-budget";
import {
  aboveFloor,
  TIKTOK_MAX_DAILY_USD,
  TIKTOK_MIN_DAILY_USD,
  TIKTOK_SET_STATUS_CLASS,
  TIKTOK_UPDATE_BUDGET_CLASS,
  tiktokBudgetBody,
  tiktokLevel,
  tiktokStatusBody,
  tiktokStatusLevel,
} from "@/services/connectors/tiktok-ads/held-schema";

const numericId = (what: string) => z.string().min(1).max(32).regex(/^[0-9]+$/, `${what} must be a numeric TikTok id`);

const target = {
  advertiser_id: numericId("advertiser_id")
    .optional()
    .describe("TikTok ad account, from tiktok_ads_list_accounts. Left out: the account the founder chose."),
  object_id: numericId("object_id").describe("The campaign, ad group or ad id."),
  rationale: z.string().min(1).max(1000).describe("Why, citing the numbers you read (spend, results, window)."),
};

const budgetInput = z.object({
  ...target,
  level: tiktokLevel.describe("campaign or ad_group."),
  daily_budget_usd: z.number().positive().max(TIKTOK_MAX_DAILY_USD).describe("The new daily budget in USD. It must be ABOVE TikTok's floors: more than $50 for a campaign, more than $20 for an ad group."),
});
const statusInput = z.object({
  ...target,
  level: tiktokStatusLevel.describe("campaign, ad_group or ad."),
  status: z.enum(["PAUSED", "ACTIVE"]).describe("PAUSED stops spend; ACTIVE turns it back on at its daily budget."),
});

const PICK =
  "Ask the founder to choose their TikTok ad account on the TikTok Ads channel page (Ad account card), then try again. No card was filed.";

export async function savedAdvertiser(tenantId: string, supplied: string | undefined): Promise<{ advertiser_id: string; name: string; currency: string | null }> {
  const state = await ensureAdAccounts(tenantId);
  if (!state.connected) throw new ExpectedToolError("tiktok_ads_not_connected", "TikTok Ads is not connected for this workspace.");
  const id = supplied ?? state.selected_id;
  if (!id) throw new ExpectedToolError("tiktok_ads_account_not_chosen", PICK);
  const saved = state.accounts.find((a) => a.advertiser_id === id);
  if (!saved) {
    const list = state.accounts.map((a) => `${a.name} (${a.advertiser_id})`).join(", ") || "none saved yet";
    throw new ExpectedToolError("tiktok_ads_unknown_account", `${id} is not one of the founder's TikTok ad accounts: ${list}. No card was filed.`);
  }
  return { advertiser_id: saved.advertiser_id, name: saved.name, currency: saved.currency };
}

export function requireTiktokEmit(ctx: { emit_decision?: unknown }): (c: string, b: unknown) => Promise<string> {
  if (typeof ctx.emit_decision !== "function") {
    throw new ExpectedToolError(
      "tiktok_ads_propose_unavailable",
      "This run cannot file an approval card, so nothing was proposed. Ask in a chat with the founder or on a TikTok Ads channel run.",
    );
  }
  return ctx.emit_decision as (c: string, b: unknown) => Promise<string>;
}

async function prepare(ctx: { tenant_id: string; emit_decision?: unknown }, input: { advertiser_id?: string; level: "campaign" | "ad_group" | "ad"; object_id: string }) {
  requireTiktokEmit(ctx);
  const adv = await savedAdvertiser(ctx.tenant_id, input.advertiser_id);
  const account = await tiktokAdsAccount(ctx.tenant_id);
  const live = await readTiktokObject(account, adv.advertiser_id, input.level, input.object_id);
  if (!live || live.status === "DELETED") {
    throw new ExpectedToolError("tiktok_ads_object_not_found", `No ${input.level === "ad_group" ? "ad group" : input.level} ${input.object_id} in TikTok ad account ${adv.name} (${adv.advertiser_id}).`);
  }
  if (input.level === "ad" && !live.ad_group_id) throw new ExpectedToolError("tiktok_ads_object_not_found", `TikTok did not say which ad group ad ${input.object_id} is in.`);
  const ids =
    input.level === "campaign"
      ? { object_id: live.id, campaign_id: live.id }
      : input.level === "ad_group"
        ? { object_id: live.id, campaign_id: live.campaign_id, ad_group_id: live.id }
        : { object_id: live.id, campaign_id: live.campaign_id, ad_group_id: live.ad_group_id!, ad_id: live.id };
  return { adv, live, ids, account };
}

function requireUsd(adv: { name: string; currency: string | null }): void {
  if (adv.currency !== "USD") throw new ExpectedToolError("tiktok_ads_currency_unsupported", `Ad account ${adv.name} bills in ${adv.currency ?? "an unknown currency"}; Zavi changes TikTok budgets and resumes delivery on USD accounts only. No card was filed.`);
}

export const tiktokAdsProposeBudgetChangeTool: ToolSpec = {
  name: "tiktok_ads_propose_budget_change",
  effect: "write",
  description:
    "Propose a new DAILY budget for one TikTok campaign or ad group. Files an approval card (in this chat, or on the TikTok Ads channel's Actions tab); " +
    "nothing changes until it is approved. An increase is checked against the shared monthly ad budget first. " +
    "Only objects with a daily budget of their own. Never creates or deletes anything.",
  input_schema: budgetInput,
  async execute(ctx, input) {
    const args = budgetInput.parse(input);
    const { adv, live, ids } = await prepare(ctx, args);
    requireUsd(adv);
    if (!isDailyMode(live.budget_mode) || live.budget === null) {
      throw new ExpectedToolError("tiktok_ads_budget_mode_unsupported", `"${live.name}" has no daily budget of its own (it is ${live.budget_mode ?? "unset"}). Zavi changes daily budgets only.`);
    }
    if (!aboveFloor(args.daily_budget_usd, args.level)) {
      throw new ExpectedToolError("tiktok_ads_budget_below_floor", `TikTok requires a daily budget above $${TIKTOK_MIN_DAILY_USD[args.level]} for a ${args.level === "ad_group" ? "ad group" : "campaign"}.`);
    }
    if (Math.round(args.daily_budget_usd * 100) === Math.round(live.budget * 100)) {
      throw new ExpectedToolError("tiktok_ads_no_change", `"${live.name}" already has a $${live.budget.toFixed(2)} daily budget.`);
    }
    const body = tiktokBudgetBody.parse({
      advertiser_id: adv.advertiser_id,
      advertiser_name: adv.name,
      level: args.level,
      ...ids,
      name: live.name,
      rationale: args.rationale,
      expected_current_daily_budget_usd: live.budget,
      expected_current_status: live.status,
      expected_current_budget_mode: live.budget_mode,
      daily_budget_usd: args.daily_budget_usd,
    });
    const action_id = await (ctx.emit_decision as (c: string, b: unknown) => Promise<string>)(TIKTOK_UPDATE_BUDGET_CLASS, body);
    return { action_id, status: "waiting_for_approval", object: { id: live.id, name: live.name, from_usd: live.budget, to_usd: args.daily_budget_usd } };
  },
};

export const tiktokAdsProposeStatusChangeTool: ToolSpec = {
  name: "tiktok_ads_propose_status_change",
  effect: "write",
  description:
    "Propose pausing (PAUSED) or turning back on (ACTIVE) one TikTok campaign, ad group or ad. Files an approval card " +
    "(in this chat, or on the TikTok Ads channel's Actions tab); nothing changes until it is approved. Turning on is checked against the shared monthly ad budget " +
    "and needs readable daily budgets on the campaign or ad groups funding it. Never deletes anything.",
  input_schema: statusInput,
  async execute(ctx, input) {
    const args = statusInput.parse(input);
    const { adv, live, ids, account } = await prepare(ctx, args);
    if (args.status === "ACTIVE") requireUsd(adv);
    if (live.status !== "ACTIVE" && live.status !== "PAUSED") {
      throw new ExpectedToolError("tiktok_ads_status_unsupported", `"${live.name}" is ${live.status}; Zavi only pauses or turns back on.`);
    }
    if (live.status === args.status) {
      throw new ExpectedToolError("tiktok_ads_no_change", `"${live.name}" is already ${args.status === "PAUSED" ? "paused" : "on"}.`);
    }
    const plan = args.status === "ACTIVE" ? await readTiktokResumePlan(account, adv.advertiser_id, live) : undefined;
    const daily = plan ? resumeDailyBudget(plan) : adv.currency === "USD" && isDailyMode(live.budget_mode) ? live.budget : null;
    const body = tiktokStatusBody.parse({
      advertiser_id: adv.advertiser_id,
      advertiser_name: adv.name,
      level: args.level,
      ...ids,
      name: live.name,
      rationale: args.rationale,
      status: args.status,
      expected_current_status: live.status,
      daily_budget_usd: daily,
      ...(plan ? { resume_plan: plan } : {}),
    });
    const action_id = await (ctx.emit_decision as (c: string, b: unknown) => Promise<string>)(TIKTOK_SET_STATUS_CLASS, body);
    return { action_id, status: "waiting_for_approval", object: { id: live.id, name: live.name, from: live.status, to: args.status } };
  },
};
