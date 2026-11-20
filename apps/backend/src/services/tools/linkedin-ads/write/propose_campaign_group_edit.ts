import { z } from "zod";
import { listLinkedInAdAccounts } from "@/services/connectors/linkedin-ads/client";
import { linkedinAccountInUse } from "@/services/connectors/linkedin-ads/own-accounts";
import { readLinkedInRawCampaignGroup, type LiRawCampaignGroup } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_GROUP_EDIT_CLASS, type LinkedInGroupEditBody } from "../_change-bodies";
import { LINKEDIN_ACCOUNT_NOT_IN_USE } from "../_wallet";
import { requireChannelRun, emitLinkedInCard } from "./_own-target";
import { endDateChange } from "./propose_campaign_edit";

const ENDED = new Set(["CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"]);
const numericId = z.string().regex(/^\d{1,20}$/);
const amount = z.string().regex(/^\d+(\.\d{1,2})?$/, "an amount like 1200 or 1200.50");

const inputSchema = z
  .object({
    group_id: numericId.describe("LinkedIn campaign group id, from linkedin_ads_list_campaign_groups."),
    account_id: numericId.describe("The ad account the group belongs to."),
    rationale: z.string().min(1).max(500).describe("Why, citing the numbers you read."),
    new_name: z.string().trim().min(1).max(255).optional().describe("A new group name."),
    status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Switch the whole group on or off."),
    run_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("New end date (UTC, YYYY-MM-DD, after today)."),
    clear_end_date: z.boolean().optional().describe("True to remove the group's end date."),
    total_budget: amount.optional().describe("New lifetime budget for the group, in the account currency."),
    clear_total_budget: z.boolean().optional().describe("True to remove the group's lifetime budget."),
  })
  .strict()
  .refine((v) => !(v.run_until && v.clear_end_date), { message: "Pass run_until or clear_end_date, not both." })
  .refine((v) => !(v.total_budget !== undefined && v.clear_total_budget), { message: "Pass total_budget or clear_total_budget, not both." })
  .refine((v) => v.new_name !== undefined || v.status !== undefined || v.run_until !== undefined || v.clear_end_date === true || v.total_budget !== undefined || v.clear_total_budget === true, { message: "Pass at least one change." });

export type GroupEditArgs = z.infer<typeof inputSchema>;
const money = (amt: string, currency: string) => ({ amount: Number(amt).toFixed(2), currency });

async function accountCurrency(tenant_id: string, account_id: string): Promise<string | null> {
  const accounts = await listLinkedInAdAccounts(tenant_id);
  return accounts.find((a) => a.id === account_id)?.currency ?? null;
}

export async function readLinkedInGroupEditBody(tenant_id: string, args: GroupEditArgs, now = new Date()): Promise<LinkedInGroupEditBody> {
  if (!(await linkedinAccountInUse(tenant_id, args.account_id))) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
  const live: LiRawCampaignGroup | null = await readLinkedInRawCampaignGroup(tenant_id, args.account_id, args.group_id);
  if (!live) throw new ExpectedToolError("linkedin_ads_group_not_found", "This campaign group is not in this LinkedIn Ads account. Refresh the group list, then try again.");
  const id = String(live.id);
  const name = live.name ?? id;
  const label = `The campaign group "${name}"`;
  if (live.backfilled) throw new ExpectedToolError("linkedin_ads_default_group", `${label} is the account's default group, which LinkedIn does not let anyone edit.`);
  if (live.status && ENDED.has(live.status)) throw new ExpectedToolError("linkedin_ads_group_ended", `${label} is ${live.status.toLowerCase()}, so it cannot be edited.`);
  const changes: LinkedInGroupEditBody["changes"] = {};
  if (args.new_name !== undefined && args.new_name !== name) changes.name = { before: name, after: args.new_name };
  if (args.status !== undefined && live.status !== args.status) {
    if (live.status !== "ACTIVE" && live.status !== "PAUSED") throw new ExpectedToolError("linkedin_ads_group_status_unsupported", `${label} is ${live.status ? live.status.toLowerCase() : "in an unknown state"}; Zavi only switches a group between active and paused.`);
    changes.status = { before: live.status, after: args.status };
  }
  const end = endDateChange(live, args, now);
  if (end) changes.run_end_at = end;
  const before = live.totalBudget ? money(live.totalBudget.amount, live.totalBudget.currencyCode) : null;
  if (args.clear_total_budget && before) changes.total_budget = { before, after: null };
  if (args.total_budget !== undefined) {
    if (!(Number(args.total_budget) > 0)) throw new ExpectedToolError("linkedin_ads_budget_zero", "A total budget of 0 is not a budget. Pass clear_total_budget to remove it, or an amount.");
    const currency = live.totalBudget?.currencyCode ?? (await accountCurrency(tenant_id, args.account_id));
    if (!currency) throw new ExpectedToolError("linkedin_ads_currency_unknown", `LinkedIn did not say which currency this account bills in, so Zavi cannot set a budget on ${label.toLowerCase()}.`);
    const after = money(args.total_budget, currency);
    if (!before || before.amount !== after.amount || before.currency !== after.currency) changes.total_budget = { before, after };
  }
  if (!Object.keys(changes).length) throw new ExpectedToolError("linkedin_ads_change_empty", `${label} already has every setting you asked for, so there is nothing to change.`);
  return {
    group_id: id,
    account_id: args.account_id,
    name,
    rationale: args.rationale,
    last_modified_at: typeof live.changeAuditStamps?.lastModified?.time === "number" ? new Date(live.changeAuditStamps.lastModified.time).toISOString() : null,
    changes,
  };
}

export const linkedinAdsProposeCampaignGroupEditTool: ToolSpec = {
  name: "linkedin_ads_propose_campaign_group_edit",
  effect: "write",
  description:
    "Propose editing one LinkedIn Ads campaign group in the founder's own ad account: its name, status (on or off), end date, or lifetime budget. Files a card on the LinkedIn Ads channel's Actions tab for the founder, or cgo on Autopilot with an ad budget, to approve (status: the founder only); if the group is edited in LinkedIn before approval the card does nothing. Every 'before' on the card is what LinkedIn shows now. The account's default group cannot be edited. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInGroupEditBody(ctx.tenant_id, args);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_GROUP_EDIT_CLASS, body);
    return { action_id, status: "waiting_for_owner", group: { id: body.group_id, name: body.name }, changes: body.changes };
  },
};
