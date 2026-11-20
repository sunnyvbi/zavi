import { inngest } from "../client";
import { dbConnectorPlatformRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { sendConnectorDiscovery } from "@/services/data-gateway/connector/discovery-outbox";
import { deliverOfflineNotice } from "@/services/data-gateway/connector/offline";

const PURGE_BATCH = 5_000;
const PURGE_BUDGET_MS = 90_000;
export const FAILING_MINUTES = 15;
const DISCOVERY_RETRY_LIMIT = 200;
const NOTICE_RETRY_LIMIT = 100;
const SEED_PAGE = 2_000;
const SEED_BUDGET_MS = 30_000;
export const TICKS_PER_DAY = 96;
export const BACKFILL_MIN_PER_TICK = 10;
export const BACKFILL_DEFAULT_MAX_PER_TICK = 500;
const RESCAN_RETRY_LIMIT = 50;
const DAY_MS = 86_400_000;

type Rpc = typeof dbConnectorPlatformRpc;
export type TickDeps = {
  rpc: Rpc;
  send: (events: unknown) => Promise<unknown>;
  log: typeof logEvent;
  sendDiscovery: (tenant_id: string, generation: number) => Promise<boolean>;
  deliverNotice: typeof deliverOfflineNotice;
  now: () => number;
};
const DEFAULT: TickDeps = {
  rpc: (...a) => dbConnectorPlatformRpc(...a),
  send: (e) => inngest.send(e as never),
  log: (i) => logEvent(i),
  sendDiscovery: (t, g) => sendConnectorDiscovery(t, g),
  deliverNotice: (...a) => deliverOfflineNotice(...a),
  now: () => Date.now(),
};
const withDefaults = (d: Partial<TickDeps>): TickDeps => ({ ...DEFAULT, ...d });

export type PurgeCounts = { expired: number; scrubbed: number; deleted: number; codes: number; limits: number; notices: number };
const PURGE_KEYS: (keyof PurgeCounts)[] = ["expired", "scrubbed", "deleted", "codes", "limits", "notices"];

export async function runConnectorQueueSweep(deps: Partial<TickDeps> = {}): Promise<PurgeCounts & { batches: number; budget_hit: boolean }> {
  const d = withDefaults(deps);
  const total: PurgeCounts = { expired: 0, scrubbed: 0, deleted: 0, codes: 0, limits: 0, notices: 0 };
  const start = d.now();
  let batches = 0;
  for (;;) {
    const { data, error } = await d.rpc("purge_db_connector_requests", { p_batch_limit: PURGE_BATCH });
    if (error) throw new Error(`purge_db_connector_requests failed: ${error.message}`);
    const c = (data ?? {}) as Partial<PurgeCounts>;
    batches += 1;
    for (const k of PURGE_KEYS) total[k] += Number(c[k] ?? 0);
    const more = PURGE_KEYS.some((k) => Number(c[k] ?? 0) >= PURGE_BATCH);
    if (!more) return { ...total, batches, budget_hit: false };
    if (d.now() - start > PURGE_BUDGET_MS) {
      await d.log({ level: "warn", source: "db-connector.sweep", code: "connector_purge_backlog", meta: { count: total.deleted + total.scrubbed + total.expired, total: batches } });
      return { ...total, batches, budget_hit: true };
    }
  }
}

export async function runConnectorFailingAlerts(deps: Partial<TickDeps> = {}): Promise<{ queued: number }> {
  const d = withDefaults(deps);
  const { data, error } = await d.rpc("claim_db_connector_failing_alerts", { p_minutes: FAILING_MINUTES });
  if (error) throw new Error(`claim_db_connector_failing_alerts failed: ${error.message}`);
  const queued = typeof data === "number" ? data : 0;
  if (queued > 0) {
    await d.log({ level: "error", source: "db-connector.liveness", code: "connector_reads_failing", meta: { count: queued } });
    await d.send({ name: "ops/alert.enqueued", data: {} }).catch(() => undefined);
  }
  return { queued };
}

export async function runDiscoveryOutboxRetry(deps: Partial<TickDeps> = {}): Promise<{ claimed: number; sent: number }> {
  const d = withDefaults(deps);
  const { data, error } = await d.rpc("claim_db_connector_discovery_outbox", { p_limit: DISCOVERY_RETRY_LIMIT });
  if (error) throw new Error(`claim_db_connector_discovery_outbox failed: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as { tenant_id: string; generation: number | string }[];
  let sent = 0;
  for (const r of rows) {
    if (await d.sendDiscovery(r.tenant_id, Number(r.generation))) sent += 1;
  }
  return { claimed: rows.length, sent };
}

export async function runOfflineNoticeRetry(deps: Partial<TickDeps> = {}): Promise<{ claimed: number; delivered: number }> {
  const d = withDefaults(deps);
  const { data, error } = await d.rpc("claim_db_connector_offline_notices_due", { p_limit: NOTICE_RETRY_LIMIT });
  if (error) throw new Error(`claim_db_connector_offline_notices_due failed: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as { notice_id: string; tenant_id: string; feature: string; machine_name: string | null; last_seen_at: string | null }[];
  let delivered = 0;
  for (const r of rows) {
    const n = await d.deliverNotice({ tenant_id: r.tenant_id, notice_id: r.notice_id, feature: r.feature, machine: r.machine_name, last_seen_at: r.last_seen_at });
    if (n > 0) delivered += 1;
  }
  return { claimed: rows.length, delivered };
}

export function backfillPerTick(pending: number, env: NodeJS.ProcessEnv = process.env): number {
  const max = Math.max(BACKFILL_MIN_PER_TICK, Number(env.DB_REDISCOVERY_BACKFILL_MAX_PER_TICK) || BACKFILL_DEFAULT_MAX_PER_TICK);
  return Math.min(max, Math.max(BACKFILL_MIN_PER_TICK, Math.ceil(pending / TICKS_PER_DAY)));
}

export async function runRediscoveryBackfill(
  deps: Partial<TickDeps> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ seeded: number; requested: number; pending: number; skipped: boolean }> {
  if (env.DB_REDISCOVERY_BACKFILL_ENABLED === "false") return { seeded: 0, requested: 0, pending: 0, skipped: true };
  const d = withDefaults(deps);
  let seeded = 0;
  const start = d.now();
  for (;;) {
    const { data, error } = await d.rpc("seed_db_rediscovery_backfill", { p_limit: SEED_PAGE });
    if (error) throw new Error(`seed_db_rediscovery_backfill failed: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as { scanned?: number; done?: boolean } | null;
    seeded += Number(row?.scanned ?? 0);
    if (row?.done !== false || d.now() - start > SEED_BUDGET_MS) break;
  }
  const { data: bl, error: blErr } = await d.rpc("db_rediscovery_backfill_backlog", {});
  if (blErr) throw new Error(`db_rediscovery_backfill_backlog failed: ${blErr.message}`);
  const backlog = (Array.isArray(bl) ? bl[0] : bl) as { pending?: number | string; oldest?: string | null } | null;
  const pending = Number(backlog?.pending ?? 0);
  if (pending === 0) return { seeded, requested: 0, pending, skipped: false };
  const lagMs = backlog?.oldest ? Math.max(0, d.now() - Date.parse(backlog.oldest)) : 0;
  await d.log({ level: "info", source: "db-connector.backfill", code: "rediscovery_backfill_backlog", meta: { count: pending, ms: lagMs } });
  const { data, error } = await d.rpc("claim_db_rediscovery_backfill", { p_limit: backfillPerTick(pending, env) });
  if (error) throw new Error(`claim_db_rediscovery_backfill failed: ${error.message}`);
  const tenants = (Array.isArray(data) ? data : [])
    .map((t) => (typeof t === "string" ? t : (t as { claim_db_rediscovery_backfill?: string })?.claim_db_rediscovery_backfill))
    .filter((t): t is string => typeof t === "string");
  if (tenants.length === 0) return { seeded, requested: 0, pending, skipped: false };
  try {
    const day = Math.floor(d.now() / DAY_MS);
    await d.send(tenants.map((tenant_id) => ({ id: `dbc-rediscover-backfill-${tenant_id}-${day}`, name: "operator-db.discover.requested", data: { tenant_id } })));
  } catch (e) {
    await d.log({ level: "error", source: "db-connector.backfill", code: "rediscovery_backfill_send_failed", error: e, meta: { count: tenants.length } });
    return { seeded, requested: 0, pending, skipped: false };
  }
  const { error: ackErr } = await d.rpc("ack_db_rediscovery_backfill", { p_tenant_ids: tenants });
  if (ackErr) {
    await d.log({ level: "warn", source: "db-connector.backfill", code: "rediscovery_backfill_ack_failed", meta: { count: tenants.length } });
  }
  return { seeded, requested: tenants.length, pending, skipped: false };
}

export async function runRescanRetries(deps: Partial<TickDeps> = {}): Promise<{ claimed: number; requested: number }> {
  const d = withDefaults(deps);
  const { data, error } = await d.rpc("claim_db_rescan_retries", { p_limit: RESCAN_RETRY_LIMIT });
  if (error) throw new Error(`claim_db_rescan_retries failed: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as { tenant_id?: unknown; failed_at?: unknown }[];
  const due = rows.filter((r): r is { tenant_id: string; failed_at: string } => typeof r.tenant_id === "string" && typeof r.failed_at === "string");
  if (due.length === 0) return { claimed: rows.length, requested: 0 };
  await d.send(
    due.map((r) => ({
      id: `dbc-rescan-retry-${r.tenant_id}-${Date.parse(r.failed_at)}`,
      name: "operator-db.discover.requested",
      data: { tenant_id: r.tenant_id },
    })),
  );
  await d.log({ level: "info", source: "db-connector.sweep", code: "rescan_retries_sent", meta: { count: due.length } });
  return { claimed: rows.length, requested: due.length };
}

export async function runConnectorTick(deps: Partial<TickDeps> = {}): Promise<Record<string, unknown>> {
  const d = withDefaults(deps);
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (e) {
      errors.push(name);
      await d.log({ level: "error", source: "db-connector.sweep", code: `${name}_failed`, error: e });
    }
  };
  await step("failing_alerts", () => runConnectorFailingAlerts(d));
  await step("discovery_retry", () => runDiscoveryOutboxRetry(d));
  await step("offline_notices", () => runOfflineNoticeRetry(d));
  await step("queue_purge", () => runConnectorQueueSweep(d));
  await step("rediscovery_backfill", () => runRediscoveryBackfill(d));
  await step("rescan_retries", () => runRescanRetries(d));
  if (errors.length) throw new Error(`db-connector-tick: ${errors.join(", ")} failed`);
  return out;
}

