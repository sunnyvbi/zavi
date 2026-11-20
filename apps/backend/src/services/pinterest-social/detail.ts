import { dataOf, errOf, type PinterestExec } from "@/services/tools/pinterest-insights/read";

export const PIN_WINDOWS = [7, 14, 30] as const;
export const DAILY_DAYS = 60;
const TOP_PINS = 50;
const PIN_PAGE = 250;
const PIN_METRICS = ["IMPRESSION", "ENGAGEMENT", "OUTBOUND_CLICK", "SAVE"] as const;

export type PinFormat = "image" | "video";

export type DailyRow = { date: string; impressions: number; engagements: number; clicks: number; saves: number };

export type PinRow = {
  id: string;
  title: string;
  format: PinFormat | null;
  image: string | null;
  url: string;
  impressions: number;
  engagements: number;
  clicks: number;
  saves: number;
};

export type PinterestDetail = {
  daily: DailyRow[] | null;
  daily_error: string | null;
  pins: Record<string, PinRow[]> | null;
  pins_error: string | null;
};

type PinInfo = { title: string; format: PinFormat; image: string | null };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);

function body(d: Record<string, any>): Record<string, any> {
  return obj(d.response_data) ?? obj(d.data) ?? d;
}

function span(days: number, now: Date): { start_date: string; end_date: string } {
  const end = new Date(now.getTime() - 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { start_date: ymd(start), end_date: ymd(end) };
}

export function dailyRowsOf(d: Record<string, any>): DailyRow[] | null {
  const b = body(d);
  const list = obj(b.analytics)?.all?.daily_metrics ?? obj(b.all)?.daily_metrics;
  if (!Array.isArray(list)) return null;
  return list
    .map((row: unknown) => {
      const r = obj(row);
      const date = text(r?.date);
      const m = obj(r?.metrics) ?? {};
      return date ? { date: date.slice(0, 10), impressions: n(m.IMPRESSION), engagements: n(m.ENGAGEMENT), clicks: n(m.OUTBOUND_CLICK), saves: n(m.SAVE) } : null;
    })
    .filter((r): r is DailyRow => r !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function imageOf(media: Record<string, any> | null): string | null {
  if (!media) return null;
  const images = obj(media.images);
  const sized = images ? ["150x150", "400x300", "600x", "1200x"].map((k) => text(obj(images[k])?.url)).find(Boolean) : null;
  if (sized) return sized;
  const items = Array.isArray(media.items) ? media.items : [];
  const first = obj(items[0]);
  const nested = first ? imageOf(first) ?? text(first.cover_image_url) : null;
  return nested ?? text(media.cover_image_url);
}

export function pinInfoOf(d: Record<string, any>): Map<string, PinInfo> {
  const b = body(d);
  const items = Array.isArray(b.items) ? b.items : Array.isArray(b.pins) ? b.pins : [];
  const out = new Map<string, PinInfo>();
  for (const raw of items) {
    const p = obj(raw);
    const id = p ? text(String(p.id ?? "")) : null;
    if (!p || !id) continue;
    const media = obj(p.media);
    const kind = text(media?.media_type)?.toLowerCase() ?? "";
    const firstLine = text(p.description)?.split(/\r?\n/)[0] ?? null;
    out.set(id, {
      title: text(p.title) ?? (firstLine ? firstLine.slice(0, 100) : "Untitled pin"),
      format: kind.includes("video") ? "video" : "image",
      image: imageOf(media),
    });
  }
  return out;
}

export function pinRowsOf(d: Record<string, any>, info: Map<string, PinInfo>): PinRow[] | null {
  const b = body(d);
  if (!Array.isArray(b.pins)) return null;
  return b.pins
    .map((raw: unknown) => {
      const p = obj(raw);
      const id = p ? text(String(p.pin_id ?? p.id ?? "")) : null;
      if (!p || !id) return null;
      const m = obj(p.metrics) ?? {};
      const known = info.get(id);
      return {
        id,
        title: known?.title ?? "Pin",
        format: known?.format ?? null,
        image: known?.image ?? null,
        url: `https://www.pinterest.com/pin/${id}/`,
        impressions: n(m.IMPRESSION),
        engagements: n(m.ENGAGEMENT),
        clicks: n(m.OUTBOUND_CLICK),
        saves: n(m.SAVE),
      };
    })
    .filter((r: PinRow | null): r is PinRow => r !== null);
}

export async function readPinterestDetail(exec: PinterestExec, now: Date = new Date()): Promise<PinterestDetail> {
  const metric_types = [...PIN_METRICS];
  const [dailyR, listR, ...topRs] = await Promise.all([
    exec("PINTEREST_GET_ACCOUNT_ANALYTICS", { ...span(DAILY_DAYS, now), metric_types }),
    exec("PINTEREST_LIST_PINS", { page_size: PIN_PAGE }),
    ...PIN_WINDOWS.map((days) => exec("PINTEREST_GET_TOP_PINS", { ...span(days, now), sort_by: "IMPRESSION", num_pins: TOP_PINS, metric_types })),
  ]);
  const daily = dailyR.ok ? dailyRowsOf(dataOf(dailyR)) : null;
  const info = listR.ok ? pinInfoOf(dataOf(listR)) : new Map<string, PinInfo>();
  const pins: Record<string, PinRow[]> = {};
  let pinsError: string | null = null;
  PIN_WINDOWS.forEach((days, i) => {
    const r = topRs[i];
    const rows = r.ok ? pinRowsOf(dataOf(r), info) : null;
    if (rows) pins[String(days)] = rows;
    else pinsError ??= r.ok ? "unexpected response shape" : errOf(r);
  });
  return {
    daily,
    daily_error: dailyR.ok ? (daily ? null : "unexpected response shape") : errOf(dailyR),
    pins: Object.keys(pins).length > 0 ? pins : null,
    pins_error: pinsError,
  };
}
