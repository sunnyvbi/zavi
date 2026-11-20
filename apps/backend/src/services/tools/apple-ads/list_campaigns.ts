
import { z } from "zod";
import { listAppleCampaigns } from "@/services/connectors/apple-ads/client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\d+$/, "account_id must be a numeric Apple Ads ad-account id")
    .describe("Apple Ads account id, from apple_ads_list_accounts."),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export const appleAdsListCampaignsTool: ToolSpec = {
  name: "apple_ads_list_campaigns",
  effect: "read",
  description:
    "List campaigns in one Apple Ads ad account with status, objective and budget. Read-only — never " +
    "edits or spends. Get account_id from apple_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, limit } = inputSchema.parse(input);
    const campaigns = await listAppleCampaigns(ctx.tenant_id, account_id, limit);
    return { account_id, count: campaigns.length, campaigns };
  },
};
