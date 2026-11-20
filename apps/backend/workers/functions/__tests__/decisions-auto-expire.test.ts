import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  logEvent: vi.fn(async (_a: Record<string, unknown>) => undefined),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));

import {
  expireStaleDecisions,
  distinctThreadIds,
  terminalizeTimedOutPausedRuns,
  partitionExpirable,
} from "../decisions-auto-expire";

const T1 = "00000000-0000-0000-0000-000000000001";
const T2 = "00000000-0000-0000-0000-000000000002";

beforeEach(() => {
  m.logEvent.mockClear();
});

describe("expireStaleDecisions", () => {
  it("flips all stale proposed rows to expired, grouped per tenant (C8 scope)", async () => {
    const seen: Array<{ tenant_id: string; ids: string[] }> = [];
    const r = await expireStaleDecisions(
      [
        { id: "a", tenant_id: T1 },
        { id: "b", tenant_id: T1 },
        { id: "c", tenant_id: T2 },
      ],
      {
        expireForTenant: async (tenant_id, ids) => {
          seen.push({ tenant_id, ids });
          return ids.length;
        },
      },
    );
    expect(r).toEqual({ scanned: 3, expired: 3, tenants: 2, failed_tenants: 0 });
    const t1 = seen.find((s) => s.tenant_id === T1)!;
    const t2 = seen.find((s) => s.tenant_id === T2)!;
    expect(t1.ids.sort()).toEqual(["a", "b"]);
    expect(t2.ids).toEqual(["c"]);
  });

  it("a row that's no longer proposed (concurrent action) is skipped — idempotent count", async () => {
    const r = await expireStaleDecisions(
      [
        { id: "a", tenant_id: T1 },
        { id: "b", tenant_id: T1 },
      ],
      {
        expireForTenant: async (_t, _ids) => 1,
      },
    );
    expect(r.expired).toBe(1);
    expect(r.failed_tenants).toBe(0);
  });

  it("a failing tenant is isolated (best-effort) and does not block the rest", async () => {
    const r = await expireStaleDecisions(
      [
        { id: "a", tenant_id: T1 },
        { id: "c", tenant_id: T2 },
      ],
      {
        expireForTenant: async (tenant_id, ids) => {
          if (tenant_id === T1) throw new Error("boom");
          return ids.length;
        },
      },
    );
    expect(r).toEqual({ scanned: 2, expired: 1, tenants: 2, failed_tenants: 1 });
    expect(m.logEvent).toHaveBeenCalledTimes(1);
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({
      code: "decision_expire_tenant_failed",
      tenant_id: T1,
    });
  });

  it("empty input → clean no-op (no flips, no tenants)", async () => {
    const r = await expireStaleDecisions([], { expireForTenant: async () => 0 });
    expect(r).toEqual({ scanned: 0, expired: 0, tenants: 0, failed_tenants: 0 });
  });
});

describe("distinctThreadIds", () => {
  it("dedupes + drops null/empty thread ids", () => {
    expect(
      distinctThreadIds([
        { thread_id: "t1" },
        { thread_id: "t1" },
        { thread_id: "t2" },
        { thread_id: null },
        { thread_id: "" },
      ]),
    ).toEqual(["t1", "t2"]);
  });

  it("empty → []", () => {
    expect(distinctThreadIds([])).toEqual([]);
  });
});

describe("terminalizeTimedOutPausedRuns", () => {
  it("no run ids → no cancel, no promote", async () => {
    const cancelPausedRuns = vi.fn(async () => []);
    const promoteThread = vi.fn(async () => undefined);
    const r = await terminalizeTimedOutPausedRuns(T1, [], {
      cancelPausedRuns,
      promoteThread,
    });
    expect(r).toEqual({ cancelled: 0, promoted: 0 });
    expect(cancelPausedRuns).not.toHaveBeenCalled();
    expect(promoteThread).not.toHaveBeenCalled();
  });

  it("cancels the paused runs and promotes the next blocked run per DISTINCT thread", async () => {
    const cancelPausedRuns = vi.fn(async () => [
      { id: "run_a", thread_id: "th_1" },
      { id: "run_b", thread_id: "th_1" },
      { id: "run_c", thread_id: "th_2" },
      { id: "run_d", thread_id: null },
    ]);
    const promoted: string[] = [];
    const promoteThread = vi.fn(async (_t: string, thread_id: string) => {
      promoted.push(thread_id);
    });
    const r = await terminalizeTimedOutPausedRuns(T1, ["run_a", "run_b", "run_c", "run_d"], {
      cancelPausedRuns,
      promoteThread,
    });
    expect(r).toEqual({ cancelled: 4, promoted: 2 });
    expect(promoted.sort()).toEqual(["th_1", "th_2"]);
    expect(promoteThread).toHaveBeenCalledWith(T1, "th_1");
    expect(promoteThread).toHaveBeenCalledWith(T1, "th_2");
  });

  it("a promote failure is isolated — other threads still promote, no throw", async () => {
    const cancelPausedRuns = vi.fn(async () => [
      { id: "run_a", thread_id: "th_1" },
      { id: "run_c", thread_id: "th_2" },
    ]);
    const promoteThread = vi.fn(async (_t: string, thread_id: string) => {
      if (thread_id === "th_1") throw new Error("rpc boom");
    });
    const r = await terminalizeTimedOutPausedRuns(T1, ["run_a", "run_c"], {
      cancelPausedRuns,
      promoteThread,
    });
    expect(r).toEqual({ cancelled: 2, promoted: 1 });
  });
});

describe("partitionExpirable (Track 2 never-expire-critical safety floor)", () => {
  it("holds security/money-critical rows out of the expirable set", () => {
    const scanned = [
      { id: "a", tenant_id: "t1", decision_class: "pm.needs_action", body: { theme: "add a footer link" } },
      {
        id: "b",
        tenant_id: "t1",
        decision_class: "engineer.ship-pr",
        body: { theme: "Password reset token reuse, account takeover" },
      },
      { id: "c", tenant_id: "t1", decision_class: "payment.refund_review", body: {} },
      { id: "d", tenant_id: "t2", decision_class: "growth-lead.lifecycle-draft", body: { theme: "email" } },
    ];
    const { expirable, criticalHeld } = partitionExpirable(scanned);
    expect(criticalHeld).toBe(2);
    expect(expirable.map((r) => r.id).sort()).toEqual(["a", "d"]);
    expect(expirable[0]).toEqual({ id: "a", tenant_id: "t1" });
  });

  it("never expires an open database outage card (the gateway clears it on recovery)", () => {
    const { expirable, criticalHeld } = partitionExpirable([
      { id: "o", tenant_id: "t1", decision_class: "operator_db.unreachable", body: { kind: "operator_db_unreachable" } },
    ]);
    expect(expirable).toEqual([]);
    expect(criticalHeld).toBe(1);
  });

  it("expires a PM retry card even when its item is a P0", () => {
    const scanned = [
      {
        id: "p",
        tenant_id: "t1",
        decision_class: "pm.needs_action",
        body: { theme: "P0 IDOR: getPaymentInfo returns other users payment methods", exception_kind: "stuck" },
      },
      { id: "q", tenant_id: "t1", decision_class: "pm.needs_action", body: { coalesced: true, affected_themes: ["Password hash leaking"] } },
    ];
    const { expirable, criticalHeld } = partitionExpirable(scanned);
    expect(criticalHeld).toBe(0);
    expect(expirable.map((r) => r.id).sort()).toEqual(["p", "q"]);
  });

  it("expires everything when nothing is critical", () => {
    const scanned = [
      { id: "a", tenant_id: "t1", decision_class: "content-design.publish", body: { theme: "blog post" } },
    ];
    const { expirable, criticalHeld } = partitionExpirable(scanned);
    expect(criticalHeld).toBe(0);
    expect(expirable).toHaveLength(1);
  });
});
