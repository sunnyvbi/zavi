import { z } from "zod";
import { isFounderChatOrder, isHumanAuthoredCommand, isRulesSteered } from "@/services/agents/untrusted-context";
import { readLinkedInAdAnalytics } from "@/services/connectors/linkedin-ads/client";
import { readLinkedInRawCampaign } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_BUDGET_CLASS, minor, type LinkedInBudgetBody } from "../_change-bodies";
import { linkedinJudgedOn } from "../_objective";
import { readCampaignPauseSignal } from "../read_analytics";
import { readOwnCampaignTarget, requireChannelRun, emitLinkedInCard } from "./_own-target";

export const LINKEDIN_RAISE_STEP_PCT = 30;
export const LINKEDIN_RAISE_STEP_FLOOR = 10;
export const LINKEDIN_DAILY_MIN_USD = 10;

const numericId = (what: string) => z.string().regex(/^\d{1,20}$/, `${what} must be a bare numeric LinkedIn id`);

const inputSchema = z
  .object({
    campaign_id: numericId("campaign_id").describe("LinkedIn campaign id, from linkedin_ads_list_campaigns."),
    account_id: numericId("account_id").describe("The ad account the campaign belongs to."),
    proposed_amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "proposed_amount is a decimal string like 45 or 45.50").describe("The new budget in the campaign's currency, as a decimal string. Which budget (daily or total) is whichever the campaign has; pass kind when it has both."),
    kind: z.enum(["daily", "total"]).optional().describe("Which budget to change. Needed only when the campaign carries both a daily and a total budget."),
    funded_by_campaign_id: numericId("funded_by_campaign_id").optional().describe("For a raise paid for by cutting another campaign in the same account: that campaign's id. Propose its cut with this tool as a separate card."),
    rationale: z.string().min(1).max(500).describe("Why, citing the numbers you read (spend, results, cost per result, window)."),
  })
  .strict();

type Args = z.infer<typeof inputSchema>;

const label = (t: { name: string; id: string }) => (t.name !== t.id ? `"${t.name}"` : "This campaign");

export async function readLinkedInBudgetBody(tenant_id: string, args: Args): Promise<{ body: LinkedInBudgetBody; objective: string | null }> {
  const t = await readOwnCampaignTarget(tenant_id, args, "its budget is managed by Zavi, not by a card");
  if (t.status && ["CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"].includes(t.status))
    throw new ExpectedToolError("linkedin_ads_campaign_ended", `${label(t)} is ${t.status.toLowerCase()}, so its budget cannot be changed.`);
  const hasDaily = !!t.live.dailyBudget;
  const hasTotal = !!t.live.totalBudget;
  if (!hasDaily && !hasTotal) throw new ExpectedToolError("linkedin_ads_budget_unread", `LinkedIn returned no budget for ${label(t)}, so there is nothing to change from.`);
  if (hasDaily && hasTotal && !args.kind) throw new ExpectedToolError("linkedin_ads_budget_kind_required", `${label(t)} has both a daily and a total budget. Pass kind to say which one changes.`);
  const kind = args.kind ?? (hasDaily ? "daily" : "total");
  const current = kind === "daily" ? t.live.dailyBudget : t.live.totalBudget;
  if (!current) throw new ExpectedToolError("linkedin_ads_budget_kind_changed", `${label(t)} has no ${kind} budget in LinkedIn.`);
  if (!/^\d+(\.\d+)?$/.test(current.amount) || !/^[A-Z]{3}$/.test(current.currencyCode))
    throw new ExpectedToolError("linkedin_ads_budget_unread", `LinkedIn returned a ${kind} budget for ${label(t)} that Zavi cannot read, so nothing is proposed.`);
  const currentAmount = Number(current.amount).toFixed(2);
  if (minor(currentAmount) === 0)
    throw new ExpectedToolError("linkedin_ads_budget_unread", `LinkedIn returned a ${kind} budget of zero for ${label(t)}, so there is no step to measure a change against.`);
  if (minor(currentAmount) === minor(args.proposed_amount)) throw new ExpectedToolError("linkedin_ads_budget_unchanged", `The ${kind} budget of ${label(t)} is already ${current.currencyCode} ${currentAmount}.`);
  if (minor(args.proposed_amount) === 0) throw new ExpectedToolError("linkedin_ads_budget_zero", `A budget of zero is a pause. Use linkedin_ads_propose_pause_campaign for ${label(t)}.`);
  if (kind === "daily" && current.currencyCode === "USD" && minor(args.proposed_amount) < LINKEDIN_DAILY_MIN_USD * 100)
    throw new ExpectedToolError("linkedin_ads_budget_below_minimum", `LinkedIn's daily budget floor is USD ${LINKEDIN_DAILY_MIN_USD}; ${args.proposed_amount} would be refused. Lower it to ${LINKEDIN_DAILY_MIN_USD} or pause ${label(t)} instead.`);
  let funded_by: LinkedInBudgetBody["funded_by"] = null;
  if (args.funded_by_campaign_id) {
    if (args.funded_by_campaign_id === t.id) throw new ExpectedToolError("linkedin_ads_funded_by_self", "A campaign cannot fund its own raise.");
    const src = await readLinkedInRawCampaign(tenant_id, args.account_id, args.funded_by_campaign_id);
    if (!src) throw new ExpectedToolError("linkedin_ads_campaign_not_found", "The funding campaign is not in this LinkedIn Ads account.");
    funded_by = { campaign_id: args.funded_by_campaign_id, name: src.name ?? args.funded_by_campaign_id };
  }
  const step_pct = minor(currentAmount) > 0 ? Math.round(((minor(args.proposed_amount) - minor(currentAmount)) / minor(currentAmount)) * 1000) / 10 : null;
  const body: LinkedInBudgetBody = {
    campaign_id: t.id,
    account_id: args.account_id,
    name: t.name,
    kind,
    expected_current: { amount: currentAmount, currency: current.currencyCode },
    proposed: { amount: Number(args.proposed_amount).toFixed(2), currency: current.currencyCode },
    rationale: args.rationale,
    funded_by,
    step_pct,
  };
  return { body, objective: t.objective };
}

const RESULTS_UNREAD = "Zavi could not re-read this campaign's results when filing this card. Check its results in LinkedIn Campaign Manager before approving.";

export async function guardOwnProposal(tenant_id: string, body: LinkedInBudgetBody, objective: string | null): Promise<string> {
  const raise = minor(body.proposed.amount) > minor(body.expected_current.amount);
  if (raise) {
    const delta = (minor(body.proposed.amount) - minor(body.expected_current.amount)) / 100;
    const overCap = minor(body.proposed.amount) * 100 > minor(body.expected_current.amount) * (100 + LINKEDIN_RAISE_STEP_PCT);
    if (overCap && delta > LINKEDIN_RAISE_STEP_FLOOR)
      throw new ExpectedToolError(
        "linkedin_ads_budget_step_too_big",
        `No card filed: a raise of ${body.step_pct}% in one step re-enters LinkedIn's learning and throws away what the campaign has tuned. Propose at most +${LINKEDIN_RAISE_STEP_PCT}% (${body.expected_current.currency} ${((minor(body.expected_current.amount) * (1 + LINKEDIN_RAISE_STEP_PCT / 100)) / 100).toFixed(2)}) now and step again after 48 hours of results.`,
        { step_pct: body.step_pct },
      );
    return body.rationale;
  }
  if (linkedinJudgedOn(objective) === "reach_and_clicks") return body.rationale;
  const check = await readCampaignPauseSignal((o) => readLinkedInAdAnalytics(tenant_id, body.account_id, o), body.campaign_id).catch(() => null);
  if (!check) return `${body.rationale}\n\n${RESULTS_UNREAD}`;
  if (check.signal === "pause_candidate") return body.rationale;
  throw new ExpectedToolError("linkedin_ads_cut_not_candidate", `No budget cut filed. ${check.note} The founder can still lower it by asking for it.`, { pause_signal: check.signal });
}

export const linkedinAdsProposeBudgetChangeTool: ToolSpec = {
  name: "linkedin_ads_propose_budget_change",
  effect: "write",
  description:
    "Propose a new daily or total budget for one LinkedIn Ads campaign in the founder's own ad account. Files a card on the LinkedIn Ads channel's Actions tab; a raise is approved by the founder, or cgo on Autopilot with an ad budget. To move money from a loser to a winner, file two cards: the cut (funded_by_campaign_id left empty) and the raise with funded_by_campaign_id naming the cut campaign. Your own raise is capped at +30% per step; your own cut needs the campaign's results to read as a pause_candidate. The founder's direct order is not gated. Campaigns in Zavi's shared account are refused: Zavi manages their budgets. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const { body, objective } = await readLinkedInBudgetBody(ctx.tenant_id, args);
    const founderOrder = isFounderChatOrder(ctx) && ctx.founder_order_unverified !== true && !isRulesSteered(ctx, "budget");
    const rationale = founderOrder || isHumanAuthoredCommand(ctx, "budget") ? body.rationale : await guardOwnProposal(ctx.tenant_id, body, objective);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_BUDGET_CLASS, { ...body, rationale });
    const raise = minor(body.proposed.amount) > minor(body.expected_current.amount);
    return { action_id, status: raise ? "waiting_for_owner" : "waiting_for_founder", campaign: { id: body.campaign_id, name: body.name }, change: { kind: body.kind, from: body.expected_current, to: body.proposed, step_pct: body.step_pct, funded_by: body.funded_by } };
  },
};
