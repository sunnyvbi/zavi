import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}), send: async () => undefined } }));
vi.mock("@/services/tenant-client", () => ({ dbConnectorPlatformRpc: async () => ({ data: null, error: null }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/data-gateway/connector/discovery-outbox", () => ({ sendConnectorDiscovery: async () => true }));
vi.mock("@/services/data-gateway/connector/offline", () => ({ deliverOfflineNotice: async () => 1 }));

import {
  backfillPerTick,
  runConnectorFailingAlerts,
  runConnectorQueueSweep,
  runConnectorTick,
  runDiscoveryOutboxRetry,
  runOfflineNoticeRetry,
  runRediscoveryBackfill,
  runRescanRetries,
  type TickDeps,
} from "../db-connector-sweep";

const counts = (o: Partial<Record<string, number>>) => ({ expired: 0, scrubbed: 0, deleted: 0, codes: 0, limits: 0, notices: 0, ...o });

function deps(rpc: (name: string, args: Record<string, unknown>) => unknown, over: Partial<TickDeps> = {}) {
  const sent: unknown[] = [];
  const logs: unknown[] = [];
  let t = 0;
  const d: Partial<TickDeps> = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => rpc(name, args)) as never,
    send: vi.fn(async (e: unknown) => void sent.push(e)),
    log: vi.fn(async (e: unknown) => void logs.push(e)) as never,
    sendDiscovery: vi.fn(async () => true),
    deliverNotice: vi.fn(async () => 1),
    now: () => (t += 1000),
    ...over,
  };
  return { d, sent, logs };
}

describe("queue purge (finding 2)", () => {
  it("drains every backlog in batches, judged on EACH count, until a partial batch", async () => {
    const seq = [counts({ scrubbed: 5000 }), counts({ expired: 5000, deleted: 10 }), counts({ deleted: 3 })];
    const { d } = deps(() => ({ data: seq.shift(), error: null }));
    const out = await runConnectorQueueSweep(d);
    expect(out).toMatchObject({ scrubbed: 5000, expired: 5000, deleted: 13, batches: 3, budget_hit: false });
  });
  it("stops at the time budget and logs the backlog", async () => {
    const { d, logs } = deps(() => ({ data: counts({ deleted: 5000 }), error: null }), { now: (() => { let t = 0; return () => (t += 30_000); })() });
    const out = await runConnectorQueueSweep(d);
    expect(out.budget_hit).toBe(true);
    expect(logs).toContainEqual(expect.objectContaining({ code: "connector_purge_backlog" }));
  });
});

describe("failing alerts (findings 3, 10)", () => {
  it("queued incidents are durable outbox rows; the drain is nudged", async () => {
    const { d, sent } = deps(() => ({ data: 2, error: null }));
    expect(await runConnectorFailingAlerts(d)).toEqual({ queued: 2 });
    expect(d.rpc).toHaveBeenCalledWith("claim_db_connector_failing_alerts", { p_minutes: 15 });
    expect(sent).toEqual([{ name: "ops/alert.enqueued", data: {} }]);
  });
  it("nothing queued -> no nudge", async () => {
    const { d, sent } = deps(() => ({ data: 0, error: null }));
    await runConnectorFailingAlerts(d);
    expect(sent).toEqual([]);
  });
});

describe("outbox retries (findings 9, 11)", () => {
  it("discovery rows are resent per generation", async () => {
    const { d } = deps(() => ({ data: [{ tenant_id: "t1", generation: "4" }, { tenant_id: "t2", generation: 1 }], error: null }));
    expect(await runDiscoveryOutboxRetry(d)).toEqual({ claimed: 2, sent: 2 });
    expect(d.sendDiscovery).toHaveBeenCalledWith("t1", 4);
  });
  it("offline notices are retried one by one; a failing row does not stop the next", async () => {
    let n = 0;
    const { d } = deps(() => ({ data: [{ notice_id: "n1", tenant_id: "t1", feature: "F", machine_name: null, last_seen_at: null }, { notice_id: "n2", tenant_id: "t2", feature: "F", machine_name: "m", last_seen_at: null }], error: null }), {
      deliverNotice: vi.fn(async () => (++n === 1 ? 0 : 2)),
    });
    expect(await runOfflineNoticeRetry(d)).toEqual({ claimed: 2, delivered: 1 });
  });
});

describe("rediscovery backfill (findings 12, 13)", () => {
  const backfillRpc = (over: Record<string, unknown> = {}) => (name: string) => {
    if (name in over) return over[name];
    if (name === "seed_db_rediscovery_backfill") return { data: [{ scanned: 1, done: true }], error: null };
    if (name === "db_rediscovery_backfill_backlog") return { data: [{ pending: 2, oldest: new Date(0).toISOString() }], error: null };
    if (name === "claim_db_rediscovery_backfill") return { data: ["t1", "t2"], error: null };
    if (name === "ack_db_rediscovery_backfill") return { data: 2, error: null };
    throw new Error(name);
  };
  it("seeds a page, sends deterministic ids, acknowledges only after the send, logs backlog + lag", async () => {
    const { d, sent, logs } = deps(backfillRpc());
    expect(await runRediscoveryBackfill(d, {})).toEqual({ seeded: 1, requested: 2, pending: 2, skipped: false });
    expect(sent).toEqual([[
      { id: "dbc-rediscover-backfill-t1-0", name: "operator-db.discover.requested", data: { tenant_id: "t1" } },
      { id: "dbc-rediscover-backfill-t2-0", name: "operator-db.discover.requested", data: { tenant_id: "t2" } },
    ]]);
    expect(d.rpc).toHaveBeenCalledWith("ack_db_rediscovery_backfill", { p_tenant_ids: ["t1", "t2"] });
    expect(logs).toContainEqual(expect.objectContaining({ code: "rediscovery_backfill_backlog", meta: expect.objectContaining({ count: 2 }) }));
  });
  it("a failed send is NOT acknowledged (the leases lapse and a later tick resends)", async () => {
    const { d } = deps(backfillRpc(), { send: vi.fn(async () => { throw new Error("inngest down"); }) });
    expect(await runRediscoveryBackfill(d, {})).toMatchObject({ requested: 0 });
    expect(d.rpc).not.toHaveBeenCalledWith("ack_db_rediscovery_backfill", expect.anything());
  });
  it("keeps seeding pages while more remain", async () => {
    const pages = [{ scanned: 2000, done: false }, { scanned: 5, done: true }];
    const { d } = deps(backfillRpc({ seed_db_rediscovery_backfill: undefined }) as never, {
      rpc: vi.fn(async (name: string) => (name === "seed_db_rediscovery_backfill" ? { data: [pages.shift()], error: null } : backfillRpc()(name))) as never,
    });
    expect((await runRediscoveryBackfill(d, {})).seeded).toBe(2005);
  });
  it("rate is sized to finish within a day, bounded", () => {
    expect(backfillPerTick(0, {})).toBe(10);
    expect(backfillPerTick(9_600, {})).toBe(100);
    expect(backfillPerTick(1_000_000, {})).toBe(500);
    expect(backfillPerTick(1_000_000, { DB_REDISCOVERY_BACKFILL_MAX_PER_TICK: "2000" })).toBe(2000);
  });
  it("a tenant re-queued on a later day gets a new event id (not deduplicated against the first rediscovery)", async () => {
    const day1 = deps(backfillRpc(), { now: () => 5 * 86_400_000 });
    await runRediscoveryBackfill(day1.d, {});
    const day2 = deps(backfillRpc(), { now: () => 6 * 86_400_000 });
    await runRediscoveryBackfill(day2.d, {});
    const ids = (s: unknown[]) => (s[0] as Array<{ id: string }>).map((e) => e.id);
    expect(ids(day1.sent)).toEqual(["dbc-rediscover-backfill-t1-5", "dbc-rediscover-backfill-t2-5"]);
    expect(ids(day2.sent)).toEqual(["dbc-rediscover-backfill-t1-6", "dbc-rediscover-backfill-t2-6"]);
  });
  it("kill switch", async () => {
    expect(await runRediscoveryBackfill({}, { DB_REDISCOVERY_BACKFILL_ENABLED: "false" })).toMatchObject({ skipped: true });
  });
});

describe("re-scan retries (kept last good catalogs)", () => {
  it("sends one discovery per due row; the id follows the failure, so a re-lease reuses it", async () => {
    const rows = [{ tenant_id: "t1", failed_at: "2026-10-14T06:00:00.000Z" }, { tenant_id: "t2", failed_at: "2026-10-14T07:00:00.000Z" }];
    const { d, sent } = deps(() => ({ data: rows, error: null }));
    expect(await runRescanRetries(d)).toEqual({ claimed: 2, requested: 2 });
    expect(d.rpc).toHaveBeenCalledWith("claim_db_rescan_retries", { p_limit: 50 });
    const ids = [`dbc-rescan-retry-t1-${Date.parse(rows[0]!.failed_at)}`, `dbc-rescan-retry-t2-${Date.parse(rows[1]!.failed_at)}`];
    expect(sent).toEqual([[
      { id: ids[0], name: "operator-db.discover.requested", data: { tenant_id: "t1" } },
      { id: ids[1], name: "operator-db.discover.requested", data: { tenant_id: "t2" } },
    ]]);
    const again = deps(() => ({ data: rows, error: null }), { now: () => 86_400_000 });
    await runRescanRetries(again.d);
    expect((again.sent[0] as Array<{ id: string }>).map((e) => e.id)).toEqual(ids);
  });
  it("nothing due -> nothing sent", async () => {
    const { d, sent } = deps(() => ({ data: [], error: null }));
    expect(await runRescanRetries(d)).toEqual({ claimed: 0, requested: 0 });
    expect(sent).toEqual([]);
  });
  it("a failed claim fails the step (the tick reports it)", async () => {
    const { d } = deps(() => ({ data: null, error: { message: "boom" } }));
    await expect(runRescanRetries(d)).rejects.toThrow("claim_db_rescan_retries failed");
  });
});

describe("tick", () => {
  it("one step failing never stops the others; the tick still reports the failure", async () => {
    const { d } = deps((name) => {
      if (name === "claim_db_connector_failing_alerts") return { data: null, error: { message: "boom" } };
      if (name === "purge_db_connector_requests") return { data: counts({}), error: null };
      if (name === "seed_db_rediscovery_backfill") return { data: [{ scanned: 0, done: true }], error: null };
      if (name === "db_rediscovery_backfill_backlog") return { data: [{ pending: 0 }], error: null };
      return { data: [], error: null };
    });
    await expect(runConnectorTick(d)).rejects.toThrow("failing_alerts");
    expect((d.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      "claim_db_connector_failing_alerts",
      "claim_db_connector_discovery_outbox",
      "claim_db_connector_offline_notices_due",
      "purge_db_connector_requests",
      "seed_db_rediscovery_backfill",
      "db_rediscovery_backfill_backlog",
      "claim_db_rescan_retries",
    ]);
  });
});
