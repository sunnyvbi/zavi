import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { ensureAdAccounts } from "@/services/connectors/tiktok-ads/ad-accounts";
import { tiktokAdsAccount, viewsReport } from "@/services/connectors/tiktok-ads/composio-read";
import { listTiktokAdGroups, listTiktokAds } from "@/services/connectors/tiktok-ads/objects";
import { paidAnalyticsQuery } from "./paid-analytics";

const advertiser = z.string().regex(/^\d{1,32}$/);
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function tiktokAnalyticsRead(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { advertiser_id, ...rest } = req.query;
  const parsed = paidAnalyticsQuery.safeParse(rest);
  const adv = advertiser.safeParse(advertiser_id);
  if (!parsed.success || !adv.success) {
    res.status(400).json({ error: { code: "analytics_invalid", message: "Choose a campaign and a valid reporting window." } });
    return;
  }
  const locked = await refuseIfChannelPlanLocked(auth.tenant_id, "tiktok_ads");
  if (locked) { res.status(403).json(locked.body); return; }
  const { campaign_id, level, since, until } = parsed.data;
  try {
    const saved = (await ensureAdAccounts(auth.tenant_id)).accounts.find((a) => a.advertiser_id === adv.data);
    if (!saved) {
      res.status(404).json({ error: { code: "analytics_campaign_missing", message: "That campaign is not in this connected account." } });
      return;
    }
    const account = await tiktokAdsAccount(auth.tenant_id);
    const groups = level === "groups";
    const [objects, report] = await Promise.all([
      groups ? listTiktokAdGroups(account, saved.advertiser_id, [campaign_id]) : listTiktokAds(account, saved.advertiser_id, [campaign_id]),
      viewsReport(account, saved.advertiser_id, groups ? "ad_group" : "ad", since, until),
    ]);
    const rows = objects.filter((o) => o.campaign_id === campaign_id && o.status !== "DELETED").map((o) => {
      const s = report.get(o.id) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, conv_value: 0, views: 0 };
      return {
        id: o.id,
        name: o.name,
        status: o.status,
        spend: round2(s.spend),
        conversions: s.conversions,
        cpa: s.conversions > 0 ? round2(s.spend / s.conversions) : null,
        value: round2(s.conv_value),
        views: s.views,
        clicks: s.clicks,
        impressions: s.impressions,
      };
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ rows, currency: saved.currency?.trim().toUpperCase() || null, complete: true });
  } catch {
    res.status(502).json({ error: { code: "analytics_unavailable", message: "These results could not be read. Try Refresh again." } });
  }
}
