import { chatgptAdsGet } from "./http";
import type { ChatgptAdsDashboard } from "@zavi/shared";

export function purchaseWindow(days: number, timezone: string, now = new Date()) {
  if (!timezone) throw new Error("Ad account timezone is unavailable");
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Invalid purchase window");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name: string) => Number(parts.find(p => p.type === name)?.value);
  const today = Date.UTC(part("year"), part("month") - 1, part("day"));
  const date = (value: number) => new Date(value).toISOString().slice(0, 10);
  return { from: date(today - days * 86400000), to: date(today - 86400000), timezone, days };
}

export async function readOwnedPurchaseReturn(key: string, ownedIds: string[], days: number, timezone: string): Promise<ChatgptAdsDashboard["purchase_return"]> {
  const period = purchaseWindow(days, timezone);
  if (!ownedIds.length) return { ...period, roas: null };
  const rows: Array<{ campaign_id?: string; spend?: number; order_created_attributed_sales?: number }> = [];
  for (let i = 0; i < ownedIds.length; i += 5) {
    const batch = await Promise.all(ownedIds.slice(i, i + 5).map(async id => {
      const result = await chatgptAdsGet<{ data: typeof rows; has_more?: boolean }>(key, `/campaigns/${encodeURIComponent(id)}/insights`, {
        aggregation_level: "campaign", time_granularity: "none",
        time_ranges: [JSON.stringify({ type: "date_range", since: period.from, until: period.to, timezone })],
        includes: ["zero_impression_items"],
        fields: ["campaign.id", "campaign.spend", "campaign.order_created_attributed_sales", "campaign.order_created_roas"],
      });
      if (result.has_more || !Array.isArray(result.data) || result.data.length !== 1 || result.data[0].campaign_id !== id) throw new Error("Purchase reporting is incomplete");
      return result.data[0];
    }));
    rows.push(...batch);
  }
  if (rows.some(r => typeof r.spend !== "number" || !Number.isFinite(r.spend) || r.spend < 0 || typeof r.order_created_attributed_sales !== "number" || !Number.isFinite(r.order_created_attributed_sales) || r.order_created_attributed_sales < 0)) return { ...period, roas: null };
  const spend = rows.reduce((sum, r) => sum + r.spend!, 0);
  const sales = rows.reduce((sum, r) => sum + r.order_created_attributed_sales!, 0);
  return { ...period, roas: spend > 0 ? sales / spend : null };
}
