
import { z } from "zod";
import {
  campaignReport,
  listCampaigns,
  redditAdsAccount,
  redditCampaignsUrl,
  ZERO_SUMS,
} from "@/services/connectors/reddit-ads/composio-read";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "account_id must be a bare Reddit ad-account id")
    .describe("Reddit ad account id, from reddit_ads_list_accounts."),
  days: z.number().int().min(1).max(90).optional().default(30).describe("Spend window ending yesterday (UTC)."),
  include_archived: z.boolean().optional().default(false),
});

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

export const redditAdsListCampaignsTool: ToolSpec = {
  name: "reddit_ads_list_campaigns",
  effect: "read",
  description:
    "List campaigns in one Reddit ad account with status (ACTIVE / PAUSED), effective status, objective, " +
    "and spend, impressions, clicks, conversions and cost per conversion over the last `days` days. " +
    "Read-only — never edits or spends. Get account_id from reddit_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, days, include_archived } = inputSchema.parse(input);
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const start = new Date(end.getTime() - (days - 1) * 86_400_000);
    const account = await redditAdsAccount(ctx.tenant_id);
    const [rows, report] = await Promise.all([
      listCampaigns(account, account_id),
      campaignReport(account, account_id, ymd(start), ymd(end)),
    ]);
    const campaigns = rows
      .filter((c) => include_archived || (c.status !== "ARCHIVED" && c.status !== "DELETED"))
      .map((c) => {
        const s = report.get(c.campaign_id) ?? ZERO_SUMS;
        return {
          ...c,
          spend: round2(s.spend),
          impressions: s.impressions,
          clicks: s.clicks,
          conversions: s.conversions,
          cost_per_conversion: s.conversions > 0 ? round2(s.spend / s.conversions) : null,
        };
      });
    return {
      account_id,
      window: { from: ymd(start), to: ymd(end) },
      count: campaigns.length,
      campaigns,
      ads_manager_url: redditCampaignsUrl(account_id),
    };
  },
};
