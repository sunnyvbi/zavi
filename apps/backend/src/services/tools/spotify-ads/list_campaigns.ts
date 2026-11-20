
import { z } from "zod";
import { listSpotifyCampaigns } from "@/services/connectors/spotify-ads/client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "account_id must be a Spotify ad-account id")
    .describe("Spotify Ads account id, from spotify_ads_list_accounts."),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export const spotifyAdsListCampaignsTool: ToolSpec = {
  name: "spotify_ads_list_campaigns",
  effect: "read",
  description:
    "List campaigns in one Spotify Ads ad account with status, objective and budget. Read-only — never " +
    "edits or spends. Get account_id from spotify_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, limit } = inputSchema.parse(input);
    const campaigns = await listSpotifyCampaigns(ctx.tenant_id, account_id, limit);
    return { account_id, count: campaigns.length, campaigns };
  },
};
