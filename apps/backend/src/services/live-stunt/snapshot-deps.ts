import { asTenantId, tenantClient } from "@/services/tenant-client";
import { resolveAttachedDb } from "@/services/tools/operator-db/resolve-attached";
import type { LiveStuntConfig } from "./config";
import type { SnapshotDeps } from "./snapshot";

type RangeFn = (f: { since: string; until: string; match?: Record<string, string | number | boolean> }, cfg: unknown) =>
  Promise<{ ok?: boolean; data?: { available?: boolean; count?: number } }>;

async function countRange(tenant_id: string, kind: "users" | "bookings", since: string, until: string, match?: LiveStuntConfig["host_match"]): Promise<number | null> {
  try {
    const { driver, cfg, close } = await resolveAttachedDb({ tenant_id, caller: { kind: "background", feature: "Live run snapshot" } });
    try {
      const fn = (kind === "users" ? driver.query_new_users_in_range : driver.query_new_bookings_in_range) as RangeFn | undefined;
      if (typeof fn !== "function") return null;
      const res = await fn.call(driver, { since, until, ...(match ? { match } : {}) }, cfg);
      if (!res?.ok || !res.data?.available) return null;
      const n = Number(res.data.count);
      return Number.isFinite(n) ? n : null;
    } finally {
      await close();
    }
  } catch {
    return null;
  }
}

const HOUR_MS = 3_600_000;
export const PUSH_STALE_MS = 2 * HOUR_MS;

type Push = { covered_from: string; covered_to: string; metrics: string[]; pushed_at: string };

export async function pushedCount(
  tenant_id: string, metric: string, since: string, until: string,
  now: Date = new Date(), push?: Push | null,
): Promise<number | null> {
  if (!push) return null;
  if (!(push.metrics ?? []).includes(metric)) return null;
  if (now.getTime() - Date.parse(push.pushed_at) > PUSH_STALE_MS) return null;
  const from = Math.floor(Date.parse(since) / HOUR_MS) * HOUR_MS;
  if (from < Date.parse(push.covered_from) || Date.parse(until) > Date.parse(push.covered_to)) return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("live_source_hourly")
    .select("value")
    .eq("metric", metric)
    .gte("hour", new Date(from).toISOString())
    .lt("hour", until);
  if (error) throw new Error("live_source_hourly_read_failed");
  return ((data ?? []) as { value: number }[]).reduce((s, r) => s + Number(r.value ?? 0), 0);
}

async function readPush(tenant_id: string): Promise<Push | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("live_source_push").select("covered_from, covered_to, metrics, pushed_at").limit(1);
  if (error) throw new Error("live_source_push_read_failed");
  return ((data ?? []) as Push[])[0] ?? null;
}

export function realSnapshotDeps(cfg: LiveStuntConfig): SnapshotDeps {
  const tid = asTenantId(cfg.tenant_id);
  let push: Promise<Push | null> | null = null;
  const getPush = () => (push ??= readPush(cfg.tenant_id));
  const count = async (column: "bookings" | "new_hosts", since: string, until: string) => {
    const p = await getPush();
    if (p) return pushedCount(cfg.tenant_id, column, since, until, new Date(), p);
    return column === "bookings"
      ? countRange(cfg.tenant_id, "bookings", since, until)
      : countRange(cfg.tenant_id, "users", since, until, cfg.host_match);
  };
  return {
    countBookings: (since, until) => count("bookings", since, until),
    countHosts: (since, until) => count("new_hosts", since, until),
    bookingValue: async (since, until) => {
      const p = await getPush();
      return p ? pushedCount(cfg.tenant_id, "booking_value_usd", since, until, new Date(), p) : null;
    },
    async spendByDay(fromDay, toDay) {
      const { data, error } = await tenantClient(tid)
        .from("ad_spend_daily")
        .select("spend_date, amount_usd")
        .gte("spend_date", fromDay)
        .lte("spend_date", toDay);
      if (error) throw new Error("ad_spend_daily_read_failed");
      const out: Record<string, number> = {};
      for (const r of (data ?? []) as { spend_date: string; amount_usd: number | string }[]) {
        out[r.spend_date] = (out[r.spend_date] ?? 0) + Number(r.amount_usd);
      }
      return out;
    },
    async nowLine(sinceUtc) {
      const [notes, actions] = await Promise.all([
        tenantClient(tid).from("cgo_notes").select("created_at").order("created_at", { ascending: false }).limit(1),
        tenantClient(tid).from("channel_actions").select("channel_slug").eq("exec_status", "executed").gte("executed_at", sinceUtc),
      ]);
      if (notes.error || actions.error) throw new Error("live_stunt_now_line_read_failed");
      const rows = (actions.data ?? []) as { channel_slug: string }[];
      return {
        last_review_at: ((notes.data ?? []) as { created_at: string }[])[0]?.created_at ?? null,
        changes_today: rows.length,
        channel_slugs: rows.map((r) => r.channel_slug),
      };
    },
    now: () => new Date(),
  };
}
