import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { listLinkedInAdAccounts, readLinkedInAdAnalytics } from "@/services/connectors/linkedin-ads/client";
import { ownLinkedinAccountSet } from "@/services/connectors/linkedin-ads/own-accounts";
import { paidAnalyticsQuery } from "./paid-analytics";

const parts = (ymd: string) => ({ year: Number(ymd.slice(0, 4)), month: Number(ymd.slice(5, 7)), day: Number(ymd.slice(8, 10)) });
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function linkedinAdAnalyticsRead(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const window = paidAnalyticsQuery.safeParse({ ...req.query, campaign_id: "0", level: "ads" });
  if (!window.success) {
    res.status(400).json({ error: { code: "analytics_invalid", message: "Choose a valid reporting window." } });
    return;
  }
  const locked = await refuseIfChannelPlanLocked(auth.tenant_id, "linkedin_ads");
  if (locked) { res.status(403).json(locked.body); return; }
  const range = { start: parts(window.data.since), end: parts(window.data.until) };
  try {
    const listed = await listLinkedInAdAccounts(auth.tenant_id);
    const { accounts } = listed.length > 0 ? await ownLinkedinAccountSet(auth.tenant_id, listed) : { accounts: [] };
    const reads = await Promise.all(accounts.map(async (a) => ({ currency: a.currency ?? null, stats: await readLinkedInAdAnalytics(auth.tenant_id, a.id, { pivot: "CREATIVE", ...range }) })));
    const rows = reads.flatMap(({ currency, stats }) => stats.flatMap((r) => {
      const id = r.pivot?.split(":").pop();
      return id ? [{ id, impressions: r.impressions, clicks: r.clicks, spend: round2(r.spend), leads: r.leads, currency }] : [];
    }));
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ rows });
  } catch {
    res.status(502).json({ error: { code: "analytics_unavailable", message: "These results could not be read. Try Refresh again." } });
  }
}
