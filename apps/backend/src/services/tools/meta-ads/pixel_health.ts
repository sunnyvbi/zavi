
import { z } from "zod";
import { fbGet, metaAdsCreds } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  lookback_days: z.number().int().min(1).max(30).default(7),
});

type PixelRow = {
  id?: string;
  name?: string;
  last_fired_time?: string;
};

type StatsRow = {
  value?: Record<string, unknown> | string;
  count?: number;
  data?: Array<{ value?: unknown; count?: number }>;
};

export const metaPixelHealthTool: ToolSpec = {
  name: "meta_ads_pixel_health",
  effect: "read",
  description:
    "Conversion-tracking hygiene check for the tenant's Meta Pixel(s). Call this BEFORE trusting ROAS / conversion numbers. Returns per-pixel: last_fired_time, event coverage (which events are firing + counts), the web-vs-server (CAPI) split, and match_keys (which match parameters — email, phone, fbp, external_id — are present on events). NOTE: Event Match Quality (EMQ) is NOT available via Meta's Graph API (Events-Manager-UI-only); this tool never fabricates an EMQ score, and match_keys is a coverage signal (which parameters are SENT), never a match-rate. IMPORTANT: overall_status keys off event VOLUME and recency only — a pixel with thousands of events and no Purchase event still returns `healthy`, so check event_coverage for the specific event a campaign optimises for. Returns meta_ads_not_connected when Meta is absent.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { lookback_days } = inputSchema.parse(input);
    const creds = await metaAdsCreds(ctx.tenant_id);

    const pixelsResp = (await fbGet(ctx.tenant_id, `${creds.ad_account_id}/adspixels`, {
      fields: "id,name,last_fired_time",
      limit: 50,
    })) as { data?: PixelRow[] };
    const pixels = pixelsResp.data ?? [];

    if (pixels.length === 0) {
      return {
        connected: true,
        pixels_found: 0,
        overall_status: "no_pixel",
        message:
          "Meta is connected but this ad account has no pixel/dataset. Conversion + ROAS numbers cannot be trusted — there is no first-party tracking source. Recommend the operator install a pixel + Conversions API before optimizing on ROAS.",
        limitation:
          "Event Match Quality (EMQ) is not exposed via the Graph API; this tool reports event coverage + web/server split as the available proxies.",
      };
    }

    const startUnix = Math.floor(Date.now() / 1000) - lookback_days * 86400;
    const endUnix = Math.floor(Date.now() / 1000);

    const pixelHealth = [];
    for (const px of pixels) {
      if (!px.id) continue;
      const eventCoverage = await readStats(ctx.tenant_id, px.id, "event_total_counts", startUnix, endUnix);
      const sourceSplit = await readStats(ctx.tenant_id, px.id, "event_source", startUnix, endUnix);
      const matchKeys = await readStats(ctx.tenant_id, px.id, "match_keys", startUnix, endUnix);

      const totalEvents = sumCounts(eventCoverage);
      const serverEvents = sumServerCounts(sourceSplit);
      const lastFiredAgeDays = px.last_fired_time
        ? daysSince(px.last_fired_time)
        : null;

      let status: "healthy" | "degraded" | "web_only" = "healthy";
      if (totalEvents === 0 || (lastFiredAgeDays != null && lastFiredAgeDays > lookback_days)) {
        status = "degraded";
      } else if (serverEvents === 0) {
        status = "web_only";
      }

      pixelHealth.push({
        pixel_id: px.id,
        name: px.name ?? null,
        last_fired_time: px.last_fired_time ?? null,
        last_fired_age_days: lastFiredAgeDays,
        total_events_in_window: totalEvents,
        server_events_in_window: serverEvents,
        event_coverage: aggregateEventCounts(eventCoverage),
        source_split: { web: Math.max(0, totalEvents - serverEvents), server: serverEvents },
        match_keys: projectMatchKeys(matchKeys),
        status,
      });
    }

    const anyDegraded = pixelHealth.some((p) => p.status === "degraded");
    const anyWebOnly = pixelHealth.some((p) => p.status === "web_only");
    const overall_status = anyDegraded ? "degraded" : anyWebOnly ? "web_only" : "healthy";

    orderByEvidence(pixelHealth);

    const confusable = confusableNames(pixelHealth);

    return {
      connected: true,
      pixels_found: pixels.length,
      pixels_reported: pixelHealth.length,
      pixel_ids: pixelHealth.map((p) => p.pixel_id),
      ...(confusable.length > 0 ? { confusable_names: confusable } : {}),
      overall_status,
      lookback_days,
      pixels: pixelHealth,
      limitation:
        "Event Match Quality (EMQ) is not exposed via Meta's Graph API (Events-Manager-UI-only). This tool reports event coverage, last-fired recency, the web-vs-server (CAPI) split and which match_keys are present as the available programmatic proxies — it does not return an EMQ score, and match_keys is NOT an EMQ substitute: it says which parameters are being sent, never how well they matched. overall_status is driven by event VOLUME and recency only, so a pixel firing thousands of events with NO Purchase event still reports `healthy` — read event_coverage yourself before trusting any ROAS.",
    };
  },
};

export function aggregateEventCounts(rows: StatsRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (name: unknown, count: unknown) => {
    const key = typeof name === "string" ? name : null;
    const n = typeof count === "number" ? count : 0;
    if (!key || n === 0) return;
    out[key] = (out[key] ?? 0) + n;
  };
  for (const r of rows) {
    if (Array.isArray(r.data)) {
      for (const d of r.data) add(d.value, d.count);
      continue;
    }
    if (r.value && typeof r.value === "object") {
      for (const [k, v] of Object.entries(r.value)) add(k, v);
      continue;
    }
    add(r.value, r.count);
  }
  return out;
}

type PixelOrderable = {
  pixel_id: string;
  name: string | null;
  total_events_in_window: number;
  server_events_in_window: number;
  last_fired_age_days: number | null;
};

export function orderByEvidence<T extends PixelOrderable>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    if (b.total_events_in_window !== a.total_events_in_window) {
      return b.total_events_in_window - a.total_events_in_window;
    }
    if (b.server_events_in_window !== a.server_events_in_window) {
      return b.server_events_in_window - a.server_events_in_window;
    }
    const aAge = a.last_fired_age_days ?? Number.POSITIVE_INFINITY;
    const bAge = b.last_fired_age_days ?? Number.POSITIVE_INFINITY;
    return aAge - bAge;
  });
}

export function confusableNames<T extends PixelOrderable>(rows: T[]): string[] {
  const ids = new Set(rows.map((p) => p.pixel_id));
  return rows
    .filter((p) => !!p.name && p.name !== p.pixel_id && ids.has(p.name))
    .map((p) => `pixel ${p.pixel_id} is NAMED "${p.name}", which is a different pixel's id`);
}

const KNOWN_MATCH_KEYS = new Set([
  "em", "ph", "fn", "ln", "ge", "db", "ct", "st", "zp", "country",
  "external_id", "fbp", "fbc", "subscription_id", "lead_id",
  "client_ip_address", "client_user_agent", "anon_id", "madid",
]);

export function projectMatchKeys(
  rows: StatsRow[],
): { present: Array<{ key: string; count: number }>; unrecognised: number } {
  const totals = new Map<string, number>();
  let unrecognised = 0;
  const consider = (v: unknown, count: unknown) => {
    const n = typeof count === "number" && Number.isFinite(count) ? count : 0;
    if (typeof v === "string" && KNOWN_MATCH_KEYS.has(v)) {
      totals.set(v, (totals.get(v) ?? 0) + n);
    } else {
      unrecognised += 1;
    }
  };
  for (const r of rows ?? []) {
    if (typeof r?.value === "string" || r?.count != null) consider(r?.value, r?.count);
    for (const d of r?.data ?? []) consider(d?.value, d?.count);
  }
  return { present: [...totals].map(([key, count]) => ({ key, count })), unrecognised };
}

async function readStats(
  tenant_id: string,
  pixel_id: string,
  aggregation: string,
  startUnix: number,
  endUnix: number,
): Promise<StatsRow[]> {
  try {
    const resp = (await fbGet(tenant_id, `${pixel_id}/stats`, {
      aggregation,
      start_time: startUnix,
      end_time: endUnix,
    })) as { data?: StatsRow[] };
    return resp.data ?? [];
  } catch {
    return [];
  }
}

function sumCounts(rows: StatsRow[]): number {
  let total = 0;
  for (const r of rows) {
    if (typeof r.count === "number") total += r.count;
    if (Array.isArray(r.data)) {
      for (const d of r.data) if (typeof d.count === "number") total += d.count;
    }
  }
  return total;
}

function sumServerCounts(rows: StatsRow[]): number {
  let server = 0;
  const isServer = (v: unknown): boolean => {
    const s = String(v ?? "").toLowerCase();
    return s.includes("server") || s.includes("capi") || s.includes("api");
  };
  for (const r of rows) {
    if (isServer(r.value) && typeof r.count === "number") server += r.count;
    if (Array.isArray(r.data)) {
      for (const d of r.data) if (isServer(d.value) && typeof d.count === "number") server += d.count;
    }
  }
  return server;
}

function daysSince(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round((Date.now() - t) / 86400000);
}
