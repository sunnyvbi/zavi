
export type DashRange = { id: string; label: string; days: number };

export const DEFAULT_DASH_RANGES: readonly DashRange[] = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
];

const GEO_RANGES: readonly DashRange[] = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
];

const LATEST_READ: readonly DashRange[] = [{ id: "now", label: "Latest read", days: 30 }];

export type RangeControls = {
  ranges: readonly DashRange[];
  initial: DashRange;
  pickable: boolean;
};

function fromPayload(payload: unknown): DashRange[] | null {
  const ranges = (payload as { ranges?: unknown } | null)?.ranges;
  if (!Array.isArray(ranges)) return null;
  const ok = ranges.filter(
    (r): r is DashRange => !!r && typeof r.id === "string" && typeof r.label === "string" && typeof r.days === "number",
  );
  return ok.length ? ok : null;
}

export function rangeControls(slug: string, payload: unknown): RangeControls {
  let ranges: readonly DashRange[];
  if (slug === "geo") ranges = GEO_RANGES;
  else if (slug === "linkedin_organic" || slug === "instagram_organic" || slug === "tiktok_organic") ranges = LATEST_READ;
  else ranges = fromPayload(payload) ?? DEFAULT_DASH_RANGES;
  return { ranges, initial: ranges[ranges.length - 1], pickable: ranges.length > 1 };
}

export function pickRange(controls: RangeControls, id: string): DashRange {
  return controls.ranges.find((r) => r.id === id) ?? controls.initial;
}

export function windowQuery(days: number): string {
  return `days=${days}&window=last_${days}d`;
}

export function dashboardPath(slug: string, days: number, manual = false): string {
  return `/api/agents/${encodeURIComponent(slug)}/dashboard?${manual ? "refresh=1&meter=1&" : ""}${windowQuery(days)}`;
}
