
import { z } from "zod";
import { listPinterestCampaigns } from "@/services/connectors/pinterest-ads/client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\d{1,18}$/, "account_id must be a numeric Pinterest ad-account id")
    .describe("Pinterest Ads account id, from pinterest_ads_list_accounts."),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export const pinterestAdsListCampaignsTool: ToolSpec = {
  name: "pinterest_ads_list_campaigns",
  effect: "read",
  description:
    "List campaigns in one Pinterest Ads ad account with status, objective and budget. Read-only — never " +
    "edits or spends. Get account_id from pinterest_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, limit } = inputSchema.parse(input);
    const campaigns = await listPinterestCampaigns(ctx.tenant_id, account_id, limit);
    return { account_id, count: campaigns.length, campaigns };
  },
};
