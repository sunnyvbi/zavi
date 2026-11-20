
import { alert } from "@/services/logging/alert";
import { globalClient, vendorUsageRpc } from "@/services/tenant-client";
import { actorKey } from "./usage";

const API = "https://api.apify.com/v2";
const PAGE = 500;
const MAX_RUNS_PER_DAY = 20_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ReconcileDeps = {
  fetchFn?: FetchLike;
  token?: string;
  recordedActors?: (day: string) => Promise<string[]>;
  reconcile?: (day: string, workload: string, realUsd: number) => Promise<string>;
};

type ApifyRunItem = { actId?: string; startedAt?: string; usageTotalUsd?: number | null };

async function apifyGet<T>(fetchFn: FetchLike, token: string, path: string): Promise<T> {
  const res = await fetchFn(`${API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`apify ${path.split("?")[0]} HTTP ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

export function previousUtcDay(now: Date = new Date()): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export async function apifyDollarsByActor(day: string, fetchFn: FetchLike, token: string): Promise<Map<string, number>> {
  const from = `${day}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const byActId = new Map<string, number>();
  for (let offset = 0; offset < MAX_RUNS_PER_DAY; offset += PAGE) {
    const page = await apifyGet<{ items: ApifyRunItem[] }>(fetchFn, token, `actor-runs?desc=1&limit=${PAGE}&offset=${offset}`);
    let pastDay = false;
    for (const r of page.items) {
      const started = r.startedAt ?? "";
      if (started >= to) continue;
      if (started < from) {
        pastDay = true;
        continue;
      }
      if (!r.actId) continue;
      byActId.set(r.actId, (byActId.get(r.actId) ?? 0) + (Number(r.usageTotalUsd) || 0));
    }
    if (pastDay || page.items.length < PAGE) break;
    if (offset + PAGE >= MAX_RUNS_PER_DAY) {
      throw new Error(`apify reconcile: more than ${MAX_RUNS_PER_DAY} runs listed before ${day} ended; not reconciling`);
    }
  }
  const byActor = new Map<string, number>();
  for (const [actId, usd] of byActId) {
    const act = await apifyGet<{ username?: string; name?: string }>(fetchFn, token, `acts/${actId}`);
    if (!act?.username || !act?.name) throw new Error(`apify reconcile: actor ${actId} has no name`);
    const key = actorKey(`${act.username}/${act.name}`);
    byActor.set(key, (byActor.get(key) ?? 0) + usd);
  }
  return byActor;
}

async function defaultRecordedActors(day: string): Promise<string[]> {
  const { data, error } = await vendorUsageRpc("vendor_usage_apify_workloads", { p_day: day });
  if (error) throw new Error(`vendor_usage_apify_workloads failed: ${error.message}`);
  return ((data as unknown[] | null) ?? []).map((r) =>
    typeof r === "string" ? r : String((r as Record<string, unknown>).vendor_usage_apify_workloads ?? ""),
  ).filter(Boolean);
}

async function defaultReconcile(day: string, workload: string, realUsd: number): Promise<string> {
  const { data, error } = await vendorUsageRpc("reconcile_vendor_usage_day", {
    p_day: day,
    p_workload: workload,
    p_real_usd: Math.round(realUsd * 1e6) / 1e6,
  });
  if (error) throw new Error(`reconcile_vendor_usage_day failed: ${error.message}`);
  return String(data);
}

export type ReconcileResult = { day: string; actors: number; real_usd: number; outcomes: Record<string, string> };

export async function reconcileApifyDay(day: string, deps: ReconcileDeps = {}): Promise<ReconcileResult> {
  const token = deps.token ?? process.env.APIFY_TOKEN;
  if (!token) return { day, actors: 0, real_usd: 0, outcomes: {} };
  const fetchFn = deps.fetchFn ?? ((u, i) => fetch(u, i));
  const real = await apifyDollarsByActor(day, fetchFn, token);
  const recorded = await (deps.recordedActors ?? defaultRecordedActors)(day);
  const reconcile = deps.reconcile ?? defaultReconcile;
  const actors = new Set([...real.keys(), ...recorded]);
  const outcomes: Record<string, string> = {};
  let total = 0;
  for (const a of actors) {
    const usd = real.get(a) ?? 0;
    total += usd;
    outcomes[a] = await reconcile(day, a, usd);
  }
  return { day, actors: actors.size, real_usd: Math.round(total * 1e4) / 1e4, outcomes };
}

export const APIFY_ALERT_THRESHOLDS = [0.5, 0.8] as const;

async function claimAlertKey(key: string): Promise<boolean> {
  const { data, error } = await globalClient()
    .from("vendor_usage_alerts")
    .upsert({ key }, { onConflict: "key", ignoreDuplicates: true })
    .select("key");
  if (error) throw new Error(`vendor_usage_alerts claim failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function releaseAlertKey(key: string): Promise<void> {
  const { error } = await globalClient().from("vendor_usage_alerts").delete().eq("key", key);
  if (error) throw new Error(`vendor_usage_alerts release failed: ${error.message}`);
}

type Limits = {
  monthlyUsageCycle?: { startAt?: string };
  limits?: { maxMonthlyUsageUsd?: number };
  current?: { monthlyUsageUsd?: number };
};

export async function checkApifyUsage(
  deps: {
    fetchFn?: FetchLike;
    token?: string;
    page?: typeof alert;
    claim?: (key: string) => Promise<boolean>;
    release?: (key: string) => Promise<void>;
  } = {},
): Promise<number[]> {
  const token = deps.token ?? process.env.APIFY_TOKEN;
  if (!token) return [];
  const fetchFn = deps.fetchFn ?? ((u, i) => fetch(u, i));
  const l = await apifyGet<Limits>(fetchFn, token, "users/me/limits");
  const limit = Number(l.limits?.maxMonthlyUsageUsd);
  const used = Number(l.current?.monthlyUsageUsd);
  if (!(limit > 0) || !Number.isFinite(used)) return [];
  const cycle = (l.monthlyUsageCycle?.startAt ?? "").slice(0, 10);
  const share = used / limit;
  const paged: number[] = [];
  for (const t of APIFY_ALERT_THRESHOLDS) {
    if (share < t) continue;
    const key = `apify_usage_${Math.round(t * 100)}:${cycle}`;
    if (!(await (deps.claim ?? claimAlertKey)(key))) continue;
    try {
      await (deps.page ?? alert)({
      source: "vendors.apify-usage",
      code: `apify_usage_${Math.round(t * 100)}`,
      msg:
        `Apify has used $${used.toFixed(2)} of its $${limit.toFixed(0)} monthly limit (${Math.round(share * 100)}%), cycle from ${cycle}. ` +
        `At 100% every Reddit, TikTok, Instagram and rendered-page read stops until the cycle resets. Raise the limit in the Apify console or check vendor_usage for who is spending.`,
        email: { dedupeKey: key, subjectDetail: `Apify at ${Math.round(t * 100)}% of monthly limit`, required: true },
      });
      paged.push(t);
    } catch {
      await (deps.release ?? releaseAlertKey)(key).catch(() => {});
    }
  }
  return paged;
}
