import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { round2 } from "@/services/connectors/core/ad-metrics";
import { assertBudgetOrder, money, xDaily, xName, xTotal, type ExactRow, type XUpdateBody } from "@/services/connectors/x-ads/schema";
import { X_UPDATE_CAMPAIGN_CLASS } from "./_exec-action";
import { accountIdField, campaignIdField, liveCampaign, rationaleField, requireEmit } from "./_shared";

const inputSchema = z.object({
  account_id: accountIdField,
  campaign_id: campaignIdField,
  name: xName.optional().describe("New campaign name."),
  daily_budget: xDaily.optional().describe("New daily budget in the account's currency units (not micros)."),
  total_budget: xTotal.optional().describe("New total (lifetime) budget in the account's currency units."),
  rationale: rationaleField,
});

const EDITABLE = new Set(["ACTIVE", "PAUSED", "DRAFT"]);

export const xAdsProposeUpdateCampaignTool: ToolSpec = {
  name: "x_ads_propose_update_campaign",
  effect: "write",
  description:
    "Propose changing one X Ads campaign: its name, daily budget and/or total budget (account currency units). " +
    "Give at least one change. Files an approval card; nothing changes until a person approves it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = requireEmit(ctx.emit_decision);
    const args = inputSchema.parse(input);
    const c = await liveCampaign(ctx.tenant_id, args.account_id, args.campaign_id);
    if (!EDITABLE.has(c.status)) throw new ExpectedToolError("x_ads_campaign_not_editable", `Campaign "${c.name}" is ${c.status}, so Zavi cannot change it.`);

    const changes: XUpdateBody["changes"] = {};
    const rows: ExactRow[] = [];
    if (args.name !== undefined && args.name !== c.name) {
      changes.name = args.name;
      rows.push({ item: "Name", before: c.name, after: args.name });
    }
    for (const [key, item] of [["daily_budget", "Daily budget"], ["total_budget", "Total budget"]] as const) {
      const next = args[key] === undefined ? undefined : round2(args[key]);
      if (next === undefined || next === c[key]) continue;
      changes[key] = next;
      rows.push({ item, before: money(c[key], c.currency), after: money(next, c.currency) });
    }
    if (rows.length === 0) throw new ExpectedToolError("x_ads_no_change", `Campaign "${c.name}" already has those settings, so there is nothing to propose.`);
    assertBudgetOrder(changes.daily_budget ?? c.daily_budget, changes.total_budget ?? c.total_budget);

    const body: XUpdateBody = {
      account_id: args.account_id,
      campaign_id: c.campaign_id,
      name: c.name,
      currency: c.currency,
      changes,
      before: { name: c.name, daily_budget: c.daily_budget, total_budget: c.total_budget },
      rationale: args.rationale,
      summary: `Zavi changes "${c.name}" in X Ads: ${rows.map((r) => `${r.item.toLowerCase()} ${r.before} → ${r.after}`).join(", ")}.`,
      exact_change: { rows },
    };
    const action_id = await emit(X_UPDATE_CAMPAIGN_CLASS, body);
    return { action_id, status: "waiting_for_founder", campaign: { id: c.campaign_id, name: c.name }, changes };
  },
};
