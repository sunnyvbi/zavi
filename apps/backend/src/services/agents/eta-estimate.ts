
import { serviceClient } from "@/services/supabase";

export type EtaBasis = "tenant" | "fleet_default";

export type RunEta = {
  p50_ms: number;
  p95_ms: number;
  basis: EtaBasis;
  n: number;
};

export const MIN_TENANT_SAMPLES = 5;
const LOOKBACK_DAYS = 60;
const MAX_ROWS = 300;

export const FLEET_DEFAULTS_MS: Record<string, { p50: number; p95: number }> = {
  operator: { p50: 26_300, p95: 132_800 },
  "chief-of-staff": { p50: 31_700, p95: 383_500 },
  engineer: { p50: 60_400, p95: 866_800 },
  "performance-marketer": { p50: 55_100, p95: 183_000 },
  "growth-lead": { p50: 94_500, p95: 1_113_200 },
  "dispute-response": { p50: 41_600, p95: 121_500 },
  "support-lead": { p50: 44_400, p95: 145_100 },
  pm: { p50: 70_000, p95: 548_300 },
  qa: { p50: 19_900, p95: 153_800 },
  research: { p50: 180_600, p95: 646_100 },
  advisor: { p50: 90_100, p95: 180_100 },
};

const GENERIC_DEFAULT = { p50: 45_000, p95: 180_000 };

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

export function computeEta(slug: string, durationsMs: number[]): RunEta {
  const clean = durationsMs
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  if (clean.length >= MIN_TENANT_SAMPLES) {
    return {
      p50_ms: Math.round(percentile(clean, 50)),
      p95_ms: Math.round(percentile(clean, 95)),
      basis: "tenant",
      n: clean.length,
    };
  }
  const d = FLEET_DEFAULTS_MS[slug] ?? GENERIC_DEFAULT;
  return { p50_ms: d.p50, p95_ms: d.p95, basis: "fleet_default", n: clean.length };
}

export const ETA_CACHE_TTL_MS = 5 * 60 * 1000;
const ETA_CACHE_MAX = 1000;
const etaCache = new Map<string, { at: number; eta: Promise<RunEta | null> }>();

export function clearRunEtaCache(): void {
  etaCache.clear();
}

export async function estimateRunEta(
  tenant_id: string,
  slug: string,
): Promise<RunEta> {
  const key = `${tenant_id}:${slug}`;
  const now = Date.now();
  const hit = etaCache.get(key);
  if (hit && now - hit.at < ETA_CACHE_TTL_MS) {
    const cached = await hit.eta;
    if (cached) return cached;
  }
  if (etaCache.size >= ETA_CACHE_MAX) etaCache.clear();
  const eta = readRunEta(tenant_id, slug);
  etaCache.set(key, { at: now, eta });
  void eta.then((v) => {
    if (!v && etaCache.get(key)?.eta === eta) etaCache.delete(key);
  });
  return (await eta) ?? computeEta(slug, []);
}

async function readRunEta(tenant_id: string, slug: string): Promise<RunEta | null> {
  try {
    const since = new Date(
      Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("started_at, finished_at")
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", slug)
      .eq("status", "success")
      .not("finished_at", "is", null)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(MAX_ROWS);
    if (error || !data) return null;
    const durations = data
      .filter(
        (r): r is { started_at: string; finished_at: string } =>
          !!r.started_at && !!r.finished_at,
      )
      .map(
        (r) =>
          new Date(r.finished_at).getTime() - new Date(r.started_at).getTime(),
      );
    return computeEta(slug, durations);
  } catch {
    return null;
  }
}
