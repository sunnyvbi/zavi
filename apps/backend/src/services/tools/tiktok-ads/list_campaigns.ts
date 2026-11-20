
import { z } from "zod";
import {
  campaignReport,
  listCampaigns,
  tiktokAdsAccount,
  tiktokCampaignsUrl,
  ZERO_SUMS,
} from "@/services/connectors/tiktok-ads/composio-read";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  advertiser_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9]+$/, "advertiser_id must be a numeric TikTok advertiser id")
    .describe("TikTok advertiser id, from tiktok_ads_list_accounts."),
  days: z.number().int().min(1).max(90).optional().default(30).describe("Spend window ending yesterday (UTC)."),
  include_deleted: z.boolean().optional().default(false),
});

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

export const tiktokAdsListCampaignsTool: ToolSpec = {
  name: "tiktok_ads_list_campaigns",
  effect: "read",
  description:
    "List campaigns in one TikTok advertiser account with status (ACTIVE / PAUSED), objective, budget, and " +
    "spend, impressions, clicks, conversions and cost per conversion over the last `days` days. Read-only — " +
    "never edits or spends. Get advertiser_id from tiktok_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { advertiser_id, days, include_deleted } = inputSchema.parse(input);
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const start = new Date(end.getTime() - (days - 1) * 86_400_000);
    const account = await tiktokAdsAccount(ctx.tenant_id);
    const [rows, report] = await Promise.all([
      listCampaigns(account, advertiser_id),
      campaignReport(account, advertiser_id, ymd(start), ymd(end)),
    ]);
    const campaigns = rows
      .filter((c) => include_deleted || c.status !== "DELETED")
      .map((c) => {
        const s = report.get(c.campaign_id) ?? ZERO_SUMS;
        return {
          ...c,
          spend: round2(s.spend),
          impressions: s.impressions,
          clicks: s.clicks,
          conversions: s.conversions,
          conversion_value: round2(s.conv_value),
          cost_per_conversion: s.conversions > 0 ? round2(s.spend / s.conversions) : null,
        };
      });
    return {
      advertiser_id,
      window: { from: ymd(start), to: ymd(end) },
      count: campaigns.length,
      campaigns,
      ads_manager_url: tiktokCampaignsUrl(advertiser_id),
    };
  },
};
