import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { fbGet, getAdAccountCurrency, metaAdsCreds } from "@/services/tools/meta-ads/_client";
import { metaListAdSetsTool } from "@/services/tools/meta-ads/list_ad_sets";
import { metaListAdsTool } from "@/services/tools/meta-ads/list_ads";
import { listAdGroupsTool } from "@/services/tools/google-ads/list_ad_groups";
import { listAdsTool } from "@/services/tools/google-ads/list_ads";
import { gadsSearch } from "@/services/tools/google-ads/_client";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
});
export const paidAnalyticsQuery = z.object({
  campaign_id: z.string().regex(/^\d{1,40}$/),
  level: z.enum(["groups", "ads"]),
  since: day,
  until: day,
}).strict().refine(v => {
  const days = (Date.parse(v.until) - Date.parse(v.since)) / 86400000;
  return days >= 0 && days < 31;
});

type Row = Record<string, unknown>;
const finite = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
export function analyticsRows(result: Row, channel: "meta_ads" | "google_ads", level: "groups" | "ads") {
  const raw = result[level === "ads" ? "ads" : channel === "meta_ads" ? "ad_sets" : "ad_groups"];
  if (!Array.isArray(raw)) throw new Error("Missing provider rows");
  return raw.map((row: Row) => ({
    id: String(row.ad_id ?? row.ad_set_id ?? row.ad_group_id ?? ""),
    name: String(row.ad_name ?? row.ad_set_name ?? row.ad_group_name ?? row.ad_id ?? "Unnamed"),
    status: typeof row.status === "string" ? row.status : null,
    spend: finite(row.spend_usd),
    conversions: finite(row.conversions),
    cpa: finite(row.cpa_usd),
    value: finite(channel === "meta_ads" ? row.purchase_value_usd : row.conversions_value_usd),
  }));
}

export async function paidAnalyticsRead(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const requested = req.params.channel;
  const parsed = paidAnalyticsQuery.safeParse(req.query);
  const channel = requested === "youtube_ads" ? "google_ads" : requested;
  if ((channel !== "meta_ads" && channel !== "google_ads") || !parsed.success) {
    res.status(400).json({ error: { code: "analytics_invalid", message: "Choose a campaign and a valid reporting window." } });
    return;
  }
  for (const slug of new Set([requested, channel])) {
    const locked = await refuseIfChannelPlanLocked(auth.tenant_id, slug);
    if (locked) { res.status(403).json(locked.body); return; }
  }
  const { campaign_id, level, since, until } = parsed.data;
  try {
    let currency: string | null = null;
    if (channel === "meta_ads") {
      const creds = await metaAdsCreds(auth.tenant_id);
      const campaign = await fbGet(auth.tenant_id, campaign_id, { fields: "id,account_id" }) as { account_id?: string };
      if (String(campaign.account_id ?? "").replace(/^act_/, "") !== creds.ad_account_id.replace(/^act_/, "")) {
        res.status(404).json({ error: { code: "analytics_campaign_missing", message: "That campaign is not in this connected account." } });
        return;
      }
      currency = await getAdAccountCurrency(auth.tenant_id);
    } else {
      const rows = await gadsSearch(auth.tenant_id, "SELECT customer.currency_code FROM customer LIMIT 1") as Array<{ customer?: { currencyCode?: string } }>;
      currency = rows[0]?.customer?.currencyCode ?? null;
    }
    const tool = channel === "meta_ads"
      ? level === "groups" ? metaListAdSetsTool : metaListAdsTool
      : level === "groups" ? listAdGroupsTool : listAdsTool;
    const result = await tool.execute({ tenant_id: auth.tenant_id, log: () => {} }, {
      campaign_id,
      ...(channel === "meta_ads" ? { time_range: { since, until } } : { custom_range: { since, until } }),
    }) as Row;
    const totals = result.totals as { complete?: boolean } | undefined;
    res.json({ rows: analyticsRows(result, channel, level), currency, complete: totals?.complete === true });
  } catch {
    res.status(502).json({ error: { code: "analytics_unavailable", message: "These results could not be read. Try Refresh again." } });
  }
}
