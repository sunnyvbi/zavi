import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { listXAdAccountsRaw, listXCampaignRows, xAdsTenantToken, xCampaignStats, xLinkClicksUnread } from "@/services/connectors/x-ads/client";
import { listXResources, type XLineItem, type XPromotedAd } from "@/services/connectors/x-ads/resources";
import { X_ID_RE } from "@/services/connectors/x-ads/schema";
import { costPer, round2, ZERO_AD_SUMS } from "@/services/connectors/core/ad-metrics";
import { paidAnalyticsQuery } from "./paid-analytics";

const xId = z.string().regex(X_ID_RE);
const LINE_ITEMS_PER_CALL = 200;

export async function xAnalyticsRead(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { advertiser_id, campaign_id, ...rest } = req.query;
  const window = paidAnalyticsQuery.safeParse({ ...rest, campaign_id: "0" });
  const account = xId.safeParse(advertiser_id);
  const campaign = xId.safeParse(campaign_id);
  if (!window.success || !account.success || !campaign.success) {
    res.status(400).json({ error: { code: "analytics_invalid", message: "Choose a campaign and a valid reporting window." } });
    return;
  }
  const locked = await refuseIfChannelPlanLocked(auth.tenant_id, "x_ads");
  if (locked) { res.status(403).json(locked.body); return; }
  const { level, since, until } = window.data;
  try {
    const token = await xAdsTenantToken(auth.tenant_id);
    const owned = (await listXAdAccountsRaw(token)).some((a) => a.id === account.data);
    const parent = owned ? (await listXCampaignRows(token, account.data)).find((c) => c.campaign_id === campaign.data && c.status !== "DELETED") : undefined;
    if (!parent) {
      res.status(404).json({ error: { code: "analytics_campaign_missing", message: "That campaign is not in this connected account." } });
      return;
    }
    const groups = (await listXResources<XLineItem>(token, account.data, "line_items", { campaign_ids: campaign.data })).filter((g) => !g.deleted && g.campaign_id === campaign.data);
    const ads = level === "groups" || groups.length === 0 ? [] : (await Promise.all(
      Array.from({ length: Math.ceil(groups.length / LINE_ITEMS_PER_CALL) }, (_, i) =>
        listXResources<XPromotedAd>(token, account.data, "promoted_tweets", { line_item_ids: groups.slice(i * LINE_ITEMS_PER_CALL, (i + 1) * LINE_ITEMS_PER_CALL).map((g) => g.id).join(",") })),
    )).flat().filter((a) => !a.deleted);
    const objects = level === "groups"
      ? groups.map((g) => ({ id: g.id, name: g.name || `Ad group ${g.id}`, status: g.entity_status }))
      : ads.map((a) => ({ id: a.id, name: `Post ${a.tweet_id}`, status: a.entity_status }));
    const stats = await xCampaignStats(token, account.data, objects.map((o) => o.id), since, until, level === "groups" ? "LINE_ITEM" : "PROMOTED_TWEET");
    const rows = objects.map((o) => {
      const s = stats.get(o.id) ?? ZERO_AD_SUMS;
      return {
        ...o,
        spend: round2(s.spend),
        conversions: stats.conversionsRead ? s.conversions : null,
        cpa: stats.conversionsRead ? costPer(s.spend, s.conversions) : null,
        value: null,
        clicks: xLinkClicksUnread(stats, o.id) ? null : s.clicks,
        impressions: s.impressions,
        engagements: stats.engagements.get(o.id) ?? 0,
      };
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ rows, currency: parent.currency, complete: true });
  } catch {
    res.status(502).json({ error: { code: "analytics_unavailable", message: "These results could not be read. Try Refresh again." } });
  }
}
