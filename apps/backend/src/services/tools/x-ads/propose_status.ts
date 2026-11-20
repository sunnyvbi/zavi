import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { money, type XStatusBody } from "@/services/connectors/x-ads/schema";
import { X_SET_STATUS_CLASS } from "./_exec-action";
import { accountIdField, campaignIdField, liveCampaign, rationaleField, requireEmit } from "./_shared";

const inputSchema = z.object({ account_id: accountIdField, campaign_id: campaignIdField, rationale: rationaleField });

function statusTool(target: "PAUSED" | "ACTIVE", description: string): Omit<ToolSpec, "name"> {
  const pause = target === "PAUSED";
  return {
    effect: "write",
    description,
    input_schema: inputSchema,
    async execute(ctx, input) {
      const emit = requireEmit(ctx.emit_decision);
      const args = inputSchema.parse(input);
      const c = await liveCampaign(ctx.tenant_id, args.account_id, args.campaign_id);
      if (c.status === target) {
        throw new ExpectedToolError("x_ads_campaign_already", `Campaign "${c.name}" is already ${pause ? "paused" : "on"}, so there is nothing to propose.`);
      }
      if (c.status !== (pause ? "ACTIVE" : "PAUSED")) {
        throw new ExpectedToolError(
          pause ? "x_ads_campaign_not_active" : "x_ads_campaign_not_paused",
          `Campaign "${c.name}" is ${c.status}, so Zavi cannot ${pause ? "pause" : "resume"} it.`,
        );
      }
      const cap = c.daily_budget !== null ? `${money(c.daily_budget, c.currency)} a day` : "its total budget";
      const body: XStatusBody = {
        account_id: args.account_id,
        campaign_id: c.campaign_id,
        name: c.name,
        status: target,
        currency: c.currency,
        daily_budget: c.daily_budget,
        total_budget: c.total_budget,
        rationale: args.rationale,
        summary: pause
          ? `Zavi pauses "${c.name}" in X Ads. It stops spending until someone turns it back on.`
          : `Zavi turns "${c.name}" back on in X Ads. It starts spending again, up to ${cap}.`,
        exact_change: {
          rows: [
            { item: `Campaign "${c.name}"`, before: pause ? "Active" : "Paused", after: pause ? "Paused" : "Active" },
            ...(pause ? [] : [{ item: "Daily budget", before: cap, after: cap }]),
          ],
        },
      };
      const action_id = await emit(X_SET_STATUS_CLASS, body);
      return { action_id, status: "waiting_for_founder", campaign: { id: c.campaign_id, name: c.name } };
    },
  };
}

export const xAdsProposePauseCampaignTool: ToolSpec = {
  name: "x_ads_propose_pause_campaign",
  ...statusTool("PAUSED", "Propose pausing one ACTIVE X Ads campaign. Files an approval card; nothing changes until a person approves it. Use it for a campaign spending without results."),
};

export const xAdsProposeResumeCampaignTool: ToolSpec = {
  name: "x_ads_propose_resume_campaign",
  ...statusTool(
    "ACTIVE",
    "Propose turning one PAUSED X Ads campaign back on. It starts spending again up to its daily budget, so the rationale must say why from the numbers. Files an approval card; nothing changes until a person approves it.",
  ),
};
