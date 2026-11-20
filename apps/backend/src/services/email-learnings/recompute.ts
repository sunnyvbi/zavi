
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { providerGroup } from "@/services/email-results/start";
import { computeTopics, type Observation, type Route, type Topic } from "./splits";

export type ResultRow = {
  id: string;
  route: Route;
  provider_ref: string;
  account_ref: Record<string, unknown> | null;
  list_id: string | null;
  list_name: string | null;
  subject: string;
  started_at: string;
  finished_at: string;
  shared_tag: boolean;
  verdict: string | null;
  d7: Record<string, unknown> | null;
};
export type ObservationRow = {
  account_key: string;
  route: Exclude<Route, "zavi_list">;
  campaign_id: string;
  list_id: string | null;
  list_name: string | null;
  subject: string;
  sent_at: string;
  delivered: number | null;
  clicks: number | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export function fromResult(tenantId: string, r: ResultRow): Observation[] {
  if (r.verdict !== "beat" && r.verdict !== "below") return [];
  const d7 = r.d7 ?? {};
  const carried = new Set(Array.isArray(d7.from_h1) ? d7.from_h1.filter((k): k is string => typeof k === "string") : []);
  if (carried.has("delivered")) return [];
  const delivered = num(d7.delivered);
  if (delivered === null || delivered <= 0) return [];
  const base = {
    account_key: providerGroup(r.route, tenantId, r.account_ref),
    route: r.route,
    list_id: r.list_id,
    list_name: r.list_name,
    window: "d7" as const,
    subject: r.subject ?? "",
    sent_at: r.finished_at,
    exact_time: Date.parse(r.started_at) !== Date.parse(r.finished_at),
    delivered,
  };
  const out: Observation[] = [];
  const visitors = num(d7.visitors);
  if (visitors !== null && d7.ga_status === "ok" && !r.shared_tag) out.push({ ...base, key: `${r.id}:visitors`, metric: "visitors", hits: visitors });
  const clicks = num(d7.clicks);
  if (clicks !== null && !carried.has("clicks") && (r.route === "zavi_list" || d7.provider_status === "ok")) out.push({ ...base, key: `${r.id}:clicks`, metric: "clicks", hits: clicks });
  return out;
}

export function fromObservations(rows: ObservationRow[], zaviCampaigns: ReadonlySet<string>): Observation[] {
  const out: Observation[] = [];
  for (const o of rows) {
    if (zaviCampaigns.has(`${o.account_key}|${o.route}|${o.campaign_id}`)) continue;
    const delivered = num(o.delivered);
    const clicks = num(o.clicks);
    if (delivered === null || delivered <= 0 || clicks === null) continue;
    out.push({
      key: `obs:${o.route}:${o.campaign_id}`,
      account_key: o.account_key,
      route: o.route,
      list_id: o.list_id,
      list_name: o.list_name,
      window: "lifetime",
      metric: "clicks",
      subject: o.subject ?? "",
      sent_at: o.sent_at,
      exact_time: true,
      delivered,
      hits: clicks,
    });
  }
  return out;
}

export type RecomputeDeps = {
  inputs: (tenantId: string) => Promise<{ results: ResultRow[]; observations: ObservationRow[] }>;
  timeZone: (tenantId: string) => Promise<string>;
  connected: (tenantId: string) => Promise<string[] | null>;
  apply: (tenantId: string, topics: Topic[], connected: string[] | null) => Promise<Record<string, unknown>>;
};

export const LOOKBACK_DAYS = 180;
export const RESULTS_PER_STRATUM = 30;
export const OBSERVATIONS_PER_ACCOUNT = 20;

export function newestPer<T>(rows: T[], key: (r: T) => string, at: (r: T) => string, n: number): T[] {
  const sorted = [...rows].sort((a, b) => at(b).localeCompare(at(a)));
  const seen = new Map<string, number>();
  return sorted.filter((r) => {
    const k = key(r);
    const c = seen.get(k) ?? 0;
    seen.set(k, c + 1);
    return c < n;
  });
}

export async function recomputeLearnings(tenantId: string, deps: RecomputeDeps = LIVE): Promise<{ topics: number; applied: Record<string, unknown> }> {
  const [{ results, observations }, timeZone, connected] = await Promise.all([deps.inputs(tenantId), deps.timeZone(tenantId), deps.connected(tenantId)]);
  const zavi = new Set(results.filter((r) => r.route !== "zavi_list").map((r) => `${providerGroup(r.route, tenantId, r.account_ref)}|${r.route}|${r.provider_ref}`));
  const fromZavi = newestPer(
    results.flatMap((r) => fromResult(tenantId, r)),
    (o) => [o.account_key, o.route, o.list_id ?? "", o.metric].join("|"),
    (o) => o.sent_at,
    RESULTS_PER_STRATUM,
  );
  const fromSeed = fromObservations(
    newestPer(observations, (o) => `${o.account_key}|${o.route}`, (o) => o.sent_at, OBSERVATIONS_PER_ACCOUNT),
    zavi,
  );
  const rows = [...fromZavi, ...fromSeed];
  const topics = computeTopics(rows, timeZone);
  const applied = await deps.apply(tenantId, topics, connected);
  return { topics: topics.length, applied };
}

const LIVE: RecomputeDeps = {
  inputs: async (tenantId) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "email_learn_inputs", {});
    if (error) throw new Error("email_learn_inputs failed");
    const d = (data ?? {}) as { results?: ResultRow[]; observations?: ObservationRow[] };
    return { results: Array.isArray(d.results) ? d.results : [], observations: Array.isArray(d.observations) ? d.observations : [] };
  },
  timeZone: async (tenantId) => {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("tenants").select("timezone").maybeSingle();
    if (error) throw new Error("tenants.timezone read failed");
    const tz = (data as { timezone?: string | null } | null)?.timezone;
    return typeof tz === "string" && tz ? tz : "UTC";
  },
  connected: async (tenantId) => {
    const { connectedAccountKeys } = await import("./seed");
    return connectedAccountKeys(tenantId).catch(() => null);
  },
  apply: async (tenantId, topics, connected) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "apply_email_learn_recompute", {
      p_topics: topics,
      p_connected: connected,
    });
    if (error) throw new Error("apply_email_learn_recompute failed");
    return (data ?? {}) as Record<string, unknown>;
  },
};
