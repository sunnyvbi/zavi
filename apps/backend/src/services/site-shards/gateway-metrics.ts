
import type { GatewayMetricsSource, GatewayReading } from "./metrics";

export const GATEWAY_METRICS_DATASET_DEFAULT = "zavi_site_gateway_shards";
export const GATEWAY_WINDOW_S = 300;
const REF_RE = /^[a-z0-9]{8,40}$/;
const DATASET_RE = /^[a-z][a-z0-9_]{0,63}$/;

export type GatewayMetricsConfig =
  | { ok: true; accountId: string; token: string; dataset: string }
  | { ok: false; missing: string[]; invalid: string[] };

export function gatewayMetricsConfig(env: Record<string, string | undefined> = process.env): GatewayMetricsConfig {
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (env.CLOUDFLARE_ANALYTICS_API_TOKEN ?? "").trim();
  const dataset = (env.SITE_GATEWAY_METRICS_DATASET ?? "").trim() || GATEWAY_METRICS_DATASET_DEFAULT;
  const missing = [...(accountId ? [] : ["CLOUDFLARE_ACCOUNT_ID"]), ...(token ? [] : ["CLOUDFLARE_ANALYTICS_API_TOKEN"])];
  const invalid: string[] = [];
  if (!DATASET_RE.test(dataset)) invalid.push("SITE_GATEWAY_METRICS_DATASET (invalid name)");
  if (accountId && !/^[a-f0-9]{32}$/.test(accountId)) invalid.push("CLOUDFLARE_ACCOUNT_ID (invalid)");
  if (invalid.length) return { ok: false, missing, invalid };
  return missing.length ? { ok: false, missing, invalid } : { ok: true, accountId, token, dataset };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export function gatewayQueries(dataset: string, refs: string[], windowS = GATEWAY_WINDOW_S) {
  if (!DATASET_RE.test(dataset)) throw new Error("gateway metrics: invalid dataset name");
  for (const r of refs) if (!REF_RE.test(r)) throw new Error("gateway metrics: invalid shard ref");
  const minutes = Math.max(1, Math.round(windowS / 60));
  const where = `timestamp > NOW() - INTERVAL '${minutes}' MINUTE AND index1 IN (${refs.map((r) => `'${r}'`).join(", ")})`;
  return {
    counts: `SELECT index1 AS ref, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${where} GROUP BY index1 FORMAT JSON`,
    errors: `SELECT index1 AS ref, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${where} AND blob2 = '5xx' GROUP BY index1 FORMAT JSON`,
    p95: `SELECT index1 AS ref, quantileWeighted(0.95, double2, _sample_interval) AS p95 FROM ${dataset} WHERE ${where} AND double3 > 0 GROUP BY index1 FORMAT JSON`,
  };
}

export function createGatewayMetricsSource(deps: { config: Extract<GatewayMetricsConfig, { ok: true }>; fetchFn?: Fetch; now?: () => number; windowS?: number }): GatewayMetricsSource {
  const fetchFn: Fetch = deps.fetchFn ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<Fetch>);
  const now = deps.now ?? Date.now;
  const windowS = deps.windowS ?? GATEWAY_WINDOW_S;
  const url = `https://api.cloudflare.com/client/v4/accounts/${deps.config.accountId}/analytics_engine/sql`;

  async function run(sql: string): Promise<Array<Record<string, unknown>>> {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.config.token}`, "Content-Type": "text/plain" },
      body: sql,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => "");
    if (res.status < 200 || res.status >= 300) throw new Error(`analytics engine sql failed (${res.status})`);
    let d: unknown;
    try {
      d = JSON.parse(text);
    } catch {
      throw new Error("analytics engine sql: not JSON");
    }
    const data = (d as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new Error("analytics engine sql: no data array");
    return data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  }

  return {
    async read(refs) {
      const valid = [...new Set(refs.filter((r) => REF_RE.test(r)))];
      const measured_at = new Date(now()).toISOString();
      const byRef = new Map<string, GatewayReading>();
      if (!valid.length) return { measured_at, byRef };
      const q = gatewayQueries(deps.config.dataset, valid, windowS);
      const [counts, errors, p95] = await Promise.all([run(q.counts), run(q.errors), run(q.p95)]);
      const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
      const perMin = windowS / 60;
      for (const r of valid) byRef.set(r, { requests_per_min: 0, p95_ms: null, errors_5xx_per_min: 0 });
      for (const row of counts) {
        const g = byRef.get(String(row.ref));
        if (g) g.requests_per_min = n(row.n) / perMin;
      }
      for (const row of errors) {
        const g = byRef.get(String(row.ref));
        if (g) g.errors_5xx_per_min = n(row.n) / perMin;
      }
      for (const row of p95) {
        const g = byRef.get(String(row.ref));
        if (g && Number.isFinite(Number(row.p95))) g.p95_ms = Math.max(0, Number(row.p95));
      }
      return { measured_at, byRef };
    },
  };
}
