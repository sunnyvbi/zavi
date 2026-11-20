
import { z } from "zod";
import { listMicrosoftCampaigns } from "@/services/connectors/microsoft-ads/client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\d+$/, "account_id must be a numeric Microsoft Advertising account id")
    .describe("Microsoft Ads account id, from microsoft_ads_list_accounts."),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export const microsoftAdsListCampaignsTool: ToolSpec = {
  name: "microsoft_ads_list_campaigns",
  effect: "read",
  description:
    "List campaigns in one Microsoft Ads ad account with status, objective and budget. Read-only — never " +
    "edits or spends. Get account_id from microsoft_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, limit } = inputSchema.parse(input);
    const campaigns = await listMicrosoftCampaigns(ctx.tenant_id, account_id, limit);
    return { account_id, count: campaigns.length, campaigns };
  },
};
