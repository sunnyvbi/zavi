import type { LiveUpcar } from "@/lib/marketing/liveUpcar";
import { usd } from "./format";
import { publishedDay, runDayCount } from "./publishedDay";

export type DayShareCard = { n: number; of: number; headline: string; stats: { label: string; value: string }[] };

export function dayShareCard(data: LiveUpcar, raw: string): DayShareCard | null {
  const page = publishedDay(data, raw);
  if (!page) return null;
  const f = page.figures;
  const stats: DayShareCard["stats"] = [];
  if (f.spent_usd !== null) stats.push({ label: "Ad spend that day", value: usd(f.spent_usd) });
  if (f.bookings !== null) stats.push({ label: "Bookings", value: `+${f.bookings}` });
  return { n: page.n, of: runDayCount(data.clock), headline: page.entry.headline, stats };
}
