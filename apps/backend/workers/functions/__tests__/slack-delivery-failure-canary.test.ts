
import { describe, it, expect, vi, beforeEach } from "vitest";

type AlertArg = { msg: string; code?: string; tenant_id?: string; email?: { dedupeKey: string } };
const alertMock = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
const rows = vi.hoisted(() => ({
  terminal: [] as unknown[],
  stale: [] as unknown[],
  logs: [] as unknown[],
  outboxError: null as Error | null,
}));

vi.mock("@/services/logging/alert", () => ({ alert: alertMock }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const state = { isStale: false };
      const q = {
        select: () => q,
        in: () => q,
        gte: () => q,
        lt: () => {
          state.isStale = true;
          return q;
        },
        limit: async () => {
          if (table !== "slack_outbox") return { data: rows.logs, error: null };
          if (rows.outboxError) return { data: null, error: rows.outboxError };
          return { data: state.isStale ? rows.stale : rows.terminal, error: null };
        },
      };
      return q;
    },
  }),
}));

import { runSlackDeliveryFailureCanary } from "../slack-delivery-failure-canary";

const NOW = 1_700_000_000_000;
const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const T3 = "33333333-3333-3333-3333-333333333333";

const ob = (tenant_id: string, status: string, n: number) =>
  Array.from({ length: n }, () => ({ tenant_id, status }));
const stuck = (tenant_id: string, n: number) =>
  Array.from({ length: n }, () => ({ tenant_id }));

beforeEach(() => {
  alertMock.mockClear();
  rows.terminal = [];
  rows.stale = [];
  rows.logs = [];
  rows.outboxError = null;
});

const calls = () => alertMock.mock.calls.map((c) => c[0] as AlertArg);

describe("runSlackDeliveryFailureCanary — paging", () => {
  it("healthy fleet → ZERO emails", async () => {
    rows.terminal = ob(T1, "sent", 50);
    const r = await runSlackDeliveryFailureCanary(NOW);
    expect(r.paged).toBe(0);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("THE INCIDENT: fleet-wide outage sends exactly ONE email (not one per tenant)", async () => {
    rows.terminal = [...ob(T1, "failed", 6), ...ob(T2, "failed", 6), ...ob(T3, "failed", 6)];
    const r = await runSlackDeliveryFailureCanary(NOW);

    expect(r.paged).toBe(1);
    expect(alertMock).toHaveBeenCalledTimes(1);
    const c = calls()[0];
    expect(c.code).toBe("slack_delivery_failed_global");
    expect(c.msg).toContain("Tenants affected: 3");
    expect(c.email?.dedupeKey).toContain("slack_delivery:global:");
  });

  it("ONE degraded tenant (fleet healthy) → a per-tenant email", async () => {
    rows.terminal = [...ob(T1, "failed", 5), ...ob(T2, "sent", 40)];
    const r = await runSlackDeliveryFailureCanary(NOW);
    expect(r.paged).toBe(1);
    const c = calls()[0];
    expect(c.code).toBe("slack_delivery_failed_tenant");
    expect(c.tenant_id).toBe(T1);
  });

  it("DEAD DRAINER: stuck-pending rows page even with zero failures", async () => {
    rows.stale = stuck(T1, 12);
    const r = await runSlackDeliveryFailureCanary(NOW);
    expect(r.global_failed).toBe(0);
    expect(r.stale_alarmed).toBe(true);
    expect(r.paged).toBe(1);
    expect(calls()[0].msg).toContain("stuck UNDELIVERED");
    expect(calls()[0].msg).toContain("drainer may be dead");
    expect(calls()[0].msg).toContain("Tenants affected: 1");
  });

  it("RE-PAGE bucket is HOURLY, so a sustained outage doesn't email every 5 min", async () => {
    rows.terminal = [...ob(T1, "failed", 8), ...ob(T2, "failed", 8)];
    await runSlackDeliveryFailureCanary(NOW);
    await runSlackDeliveryFailureCanary(NOW + 5 * 60_000);
    const keys = calls().map((c) => c.email?.dedupeKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("BLIND SCAN: a read error pages instead of silently reporting healthy", async () => {
    rows.outboxError = new Error("db unreachable");
    const r = await runSlackDeliveryFailureCanary(NOW);
    expect(r.paged).toBe(1);
    expect(calls()[0].code).toBe("scan_failed");
    expect(calls()[0].msg).toContain("BLIND");
  });
});
