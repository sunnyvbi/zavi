import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { getObject, listObjects } from "@/services/connectors/reddit-ads/adapter";
import { campaignReport, listAdAccounts, ZERO_SUMS } from "@/services/connectors/reddit-ads/composio-read";
import { redditId } from "@/services/connectors/reddit-ads/identifiers";
import { paidAnalyticsQuery } from "./paid-analytics";

const HIDDEN = new Set(["DELETED", "ARCHIVED"]);
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function redditAnalyticsRead(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { advertiser_id, campaign_id, ...rest } = req.query;
  const window = paidAnalyticsQuery.safeParse({ ...rest, campaign_id: "0" });
  const adAccount = redditId.safeParse(advertiser_id);
  const campaign = redditId.safeParse(campaign_id);
  if (!window.success || !adAccount.success || !campaign.success) {
    res.status(400).json({ error: { code: "analytics_invalid", message: "Choose a campaign and a valid reporting window." } });
    return;
  }
  const locked = await refuseIfChannelPlanLocked(auth.tenant_id, "reddit_ads");
  if (locked) { res.status(403).json(locked.body); return; }
  const { level, since, until } = window.data;
  try {
    const account = await resolveOwnedComposioAccount(auth.tenant_id, "reddit_ads");
    const saved = account ? (await listAdAccounts(account)).find((a) => a.id === adAccount.data) : undefined;
    if (!account || !saved) {
      res.status(404).json({ error: { code: "analytics_campaign_missing", message: "That campaign is not in this connected account." } });
      return;
    }
    const parent = await getObject(account, saved.id, "campaign", campaign.data).catch(() => null);
    if (!parent) {
      res.status(404).json({ error: { code: "analytics_campaign_missing", message: "That campaign is not in this connected account." } });
      return;
    }
    const kind = level === "groups" ? "ad_group" : "ad";
    const [objects, report] = await Promise.all([listObjects(account, saved.id, kind), campaignReport(account, saved.id, since, until, kind)]);
    const rows = objects.filter((o) => o.campaign_id === campaign.data && !HIDDEN.has(o.configured_status ?? "")).map((o) => {
      const s = report.get(o.id) ?? ZERO_SUMS;
      return {
        id: o.id,
        name: o.name ?? o.id,
        status: o.configured_status ?? null,
        spend: round2(s.spend),
        conversions: s.conversions,
        cpa: s.conversions > 0 ? round2(s.spend / s.conversions) : null,
        value: null,
        clicks: s.clicks,
        impressions: s.impressions,
      };
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ rows, currency: saved.currency ?? null, complete: true });
  } catch {
    res.status(502).json({ error: { code: "analytics_unavailable", message: "These results could not be read. Try Refresh again." } });
  }
}
