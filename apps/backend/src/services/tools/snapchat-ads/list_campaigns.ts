
import { z } from "zod";
import { listSnapchatCampaigns } from "@/services/connectors/snapchat-ads/client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "account_id must be a Snapchat ad-account id")
    .describe("Snapchat Ads account id, from snapchat_ads_list_accounts."),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export const snapchatAdsListCampaignsTool: ToolSpec = {
  name: "snapchat_ads_list_campaigns",
  effect: "read",
  description:
    "List campaigns in one Snapchat Ads ad account with status, objective and budget. Read-only — never " +
    "edits or spends. Get account_id from snapchat_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, limit } = inputSchema.parse(input);
    const campaigns = await listSnapchatCampaigns(ctx.tenant_id, account_id, limit);
    return { account_id, count: campaigns.length, campaigns };
  },
};
