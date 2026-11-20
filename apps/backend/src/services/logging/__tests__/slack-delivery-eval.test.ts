
import { describe, it, expect } from "vitest";
import {
  computeDeliveryFailureReport,
  bucketKey,
  DELIVERY_FAILURE_LOG_CODES,
  type OutboxRow,
  type StaleRow,
  type FailureLogRow,
} from "../slack-delivery-eval";

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

const outbox = (tenant_id: string, status: string, n: number): OutboxRow[] =>
  Array.from({ length: n }, () => ({ tenant_id, status }));
const logs = (tenant_id: string, n: number): FailureLogRow[] =>
  Array.from({ length: n }, () => ({ tenant_id }));
const stale = (tenant_id: string, n: number): StaleRow[] =>
  Array.from({ length: n }, () => ({ tenant_id }));

const run = (a: {
  terminal?: OutboxRow[];
  stale?: StaleRow[];
  replyFailures?: FailureLogRow[];
}) =>
  computeDeliveryFailureReport({
    terminal: a.terminal ?? [],
    stale: a.stale ?? [],
    replyFailures: a.replyFailures ?? [],
  });

describe("computeDeliveryFailureReport", () => {
  it("THE INCIDENT: every delivery failing globally → alarms", () => {
    const r = run({ terminal: [...outbox(T1, "failed", 8), ...outbox(T2, "failed", 6)] });
    expect(r.global.failed).toBe(14);
    expect(r.global.rate).toBe(1);
    expect(r.globalAlarmed).toBe(true);
    expect(r.spikeAlarmed).toBe(true);
    expect(r.alarmedTenants.map((t) => t.tenant_id).sort()).toEqual([T1, T2].sort());
  });

  it("stays SILENT on a healthy path with a one-off blip", () => {
    const r = run({ terminal: [...outbox(T1, "sent", 40), ...outbox(T1, "failed", 1)] });
    expect(r.globalAlarmed).toBe(false);
    expect(r.spikeAlarmed).toBe(false);
    expect(r.alarmedTenants).toHaveLength(0);
  });

  it("stays SILENT on a tiny sample even at 100% failure (min-sample floor)", () => {
    const r = run({ terminal: outbox(T1, "failed", 2) });
    expect(r.global.rate).toBe(1);
    expect(r.globalAlarmed).toBe(false);
    expect(r.spikeAlarmed).toBe(false);
    expect(r.alarmedTenants).toHaveLength(0);
  });

  it("pages for ONE degraded tenant while the fleet is healthy", () => {
    const r = run({ terminal: [...outbox(T1, "failed", 5), ...outbox(T2, "sent", 30)] });
    expect(r.alarmedTenants).toHaveLength(1);
    expect(r.alarmedTenants[0].tenant_id).toBe(T1);
    expect(r.alarmedTenants[0].rate).toBe(1);
    expect(r.globalAlarmed).toBe(false);
    expect(r.spikeAlarmed).toBe(false);
  });

  it("SPIKE bar catches reply-path-only failures (which have no denominator)", () => {
    const r = run({ replyFailures: logs(T1, 12) });
    expect(r.global.terminal).toBe(0);
    expect(r.global.rate).toBe(0);
    expect(r.globalAlarmed).toBe(false);
    expect(r.spikeAlarmed).toBe(true);
  });

  it("sums both signals per tenant (outbox failure + reply failure both = undelivered)", () => {
    const r = run({ terminal: outbox(T1, "failed", 2), replyFailures: logs(T1, 3) });
    expect(r.perTenant[0].failed).toBe(5);
  });

  it("FRESH pending rows are not a strand (the DB scopes them out entirely)", () => {
    const r = run({ terminal: [], stale: [] });
    expect(r.global.terminal).toBe(0);
    expect(r.stalePending).toBe(0);
    expect(r.staleAlarmed).toBe(false);
    expect(r.affectedTenants).toBe(0);
  });

  it("DEAD DRAINER: rows stuck pending never become 'failed' → stale bar catches it", () => {
    const r = run({ stale: stale(T1, 12) });
    expect(r.global.failed).toBe(0);
    expect(r.globalAlarmed).toBe(false);
    expect(r.spikeAlarmed).toBe(false);
    expect(r.stalePending).toBe(12);
    expect(r.staleAlarmed).toBe(true);
    expect(r.affectedTenants).toBe(1);
  });

  it("NO DOUBLE-COUNT: an outbox failure is counted once, not twice", () => {
    expect([...DELIVERY_FAILURE_LOG_CODES]).not.toContain("deliver_failed_terminal");
    expect([...DELIVERY_FAILURE_LOG_CODES]).toContain("post_failed");

    const r = run({ terminal: outbox(T1, "failed", 6) });
    expect(r.global.failed).toBe(6);
    expect(r.perTenant[0].rate).toBeLessThanOrEqual(1);
  });

  it("REPLY-ONLY tenant outage pages via the no-denominator bar", () => {
    const r = run({ replyFailures: logs(T1, 6) });
    expect(r.perTenant[0].terminal).toBe(0);
    expect(r.perTenant[0].rate).toBe(0);
    expect(r.alarmedTenants).toHaveLength(1);
    expect(r.alarmedTenants[0].tenant_id).toBe(T1);
  });

  it("...but 2 reply failures for one tenant still stays silent (not a blip alarm)", () => {
    const r = run({ replyFailures: logs(T1, 2) });
    expect(r.alarmedTenants).toHaveLength(0);
    expect(r.spikeAlarmed).toBe(false);
  });
});

describe("bucketKey", () => {
  it("is stable within a window and rolls between windows (one email per incident)", () => {
    const w = 15 * 60 * 1000;
    const t0 = Math.floor(1_700_000_000_000 / w) * w;
    expect(bucketKey(t0, w)).toBe(bucketKey(t0 + w - 1, w));
    expect(bucketKey(t0, w)).not.toBe(bucketKey(t0 + w, w));
  });

  it("consecutive 5-min canary ticks inside one 15-min bucket share a key (no re-page)", () => {
    const w = 15 * 60 * 1000;
    const t0 = Math.floor(1_700_000_000_000 / w) * w;
    const keys = [0, 5 * 60_000, 10 * 60_000].map((off) => bucketKey(t0 + off, w));
    expect(new Set(keys).size).toBe(1);
  });
});
