
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ tenantRpc: vi.fn(), serviceClient: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  tenantRpc: m.tenantRpc,
  asTenantId: (t: string) => t,
  globalClient: m.serviceClient,
}));

import {
  consumeReadSlot,
  readBudget,
  readsPerDay,
  releaseReadSlot,
  utcDay,
  X_METRICS_METER_KEY,
  X_METRICS_READS_PER_DAY_DEFAULT,
} from "../read-cap";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function config(blob: Record<string, unknown> | null, error: unknown = null) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: blob ? { blob } : null, error }) }) }),
    }),
  };
}

beforeEach(() => {
  m.tenantRpc.mockReset();
  m.serviceClient.mockReset().mockReturnValue(config({}));
});

describe("readsPerDay", () => {
  it("defaults to ONE read a day when the key is absent", async () => {
    expect(await readsPerDay()).toBe(X_METRICS_READS_PER_DAY_DEFAULT);
    expect(X_METRICS_READS_PER_DAY_DEFAULT).toBe(1);
  });

  it("honours an operator's number, including a deliberate 0 (uncapped)", async () => {
    m.serviceClient.mockReturnValue(config({ x_metrics_reads_per_day: 10 }));
    expect(await readsPerDay()).toBe(10);
    m.serviceClient.mockReturnValue(config({ x_metrics_reads_per_day: "5" }));
    expect(await readsPerDay()).toBe(5);
    m.serviceClient.mockReturnValue(config({ x_metrics_reads_per_day: 0 }));
    expect(await readsPerDay()).toBe(0);
  });

  it("a config read error keeps the default cap, never removes the ceiling", async () => {
    m.serviceClient.mockReturnValue(config(null, { message: "down" }));
    expect(await readsPerDay()).toBe(1);
    m.serviceClient.mockImplementation(() => {
      throw new Error("no client");
    });
    expect(await readsPerDay()).toBe(1);
  });

  it("garbage in the blob does not become an unbounded cap", async () => {
    for (const bad of ["lots", -1, null, {}, true]) {
      m.serviceClient.mockReturnValue(config({ x_metrics_reads_per_day: bad }));
      expect(await readsPerDay()).toBe(1);
    }
  });
});

describe("consumeReadSlot", () => {
  it("reserves a slot and reports how many are used, with the tenant INJECTED", async () => {
    m.tenantRpc.mockResolvedValue({ data: 1, error: null });
    expect(await consumeReadSlot(TENANT)).toEqual({ ok: true, used: 1, cap: 1 });
    expect(m.tenantRpc).toHaveBeenCalledWith(TENANT, "consume_metered_read_or_reject", {
      p_day: utcDay(),
      p_key: X_METRICS_METER_KEY,
      p_cap: 1,
    });
  });

  it("a null return is the cap guard rejecting — the caller must not read", async () => {
    m.tenantRpc.mockResolvedValue({ data: null, error: null });
    expect(await consumeReadSlot(TENANT)).toMatchObject({ ok: false, reason: "cap_reached", cap: 1 });
  });

  it("FAILS CLOSED ON COST: an unusable counter rejects rather than allowing the read", async () => {
    m.tenantRpc.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    expect(await consumeReadSlot(TENANT)).toMatchObject({ ok: false, reason: "unavailable" });

    m.tenantRpc.mockRejectedValue(new Error("not in the tenant-RPC registry"));
    expect(await consumeReadSlot(TENANT)).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("releaseReadSlot", () => {
  it("refunds the slot for the same day and key", async () => {
    m.tenantRpc.mockResolvedValue({ data: null, error: null });
    await releaseReadSlot(TENANT);
    expect(m.tenantRpc).toHaveBeenCalledWith(TENANT, "release_metered_read", {
      p_day: utcDay(),
      p_key: X_METRICS_METER_KEY,
    });
  });

  it("never throws: a failed refund must not fail the read that already returned", async () => {
    m.tenantRpc.mockRejectedValue(new Error("down"));
    await expect(releaseReadSlot(TENANT)).resolves.toBeUndefined();
  });
});

describe("readBudget", () => {
  const counter = (row: { reads: number } | null, error: unknown = null) =>
    ({
      from: () => ({
        select: () => {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({ data: row, error }),
          };
          return chain;
        },
      }),
    }) as never;

  it("no row yet means nothing spent today", async () => {
    expect(await readBudget(counter(null), TENANT)).toEqual({ used: 0, cap: 1, remaining: 1 });
  });

  it("counts down, and never below zero", async () => {
    expect(await readBudget(counter({ reads: 1 }), TENANT)).toEqual({ used: 1, cap: 1, remaining: 0 });
    expect(await readBudget(counter({ reads: 9 }), TENANT)).toEqual({ used: 9, cap: 1, remaining: 0 });
  });

  it("cap 0 is uncapped, not zero-remaining", async () => {
    m.serviceClient.mockReturnValue(config({ x_metrics_reads_per_day: 0 }));
    const b = await readBudget(counter({ reads: 40 }), TENANT);
    expect(b.cap).toBe(0);
    expect(b.remaining).toBe(Number.POSITIVE_INFINITY);
  });

  it("an unreadable counter reports none remaining, so the button explains instead of lying", async () => {
    expect(await readBudget(counter(null, { message: "down" }), TENANT)).toMatchObject({ remaining: 0 });
  });
});

describe("utcDay", () => {
  it("is UTC, not the server's local day — X's dedup window is UTC", () => {
    expect(utcDay(new Date("2026-09-18T00:30:00Z"))).toBe("2026-09-18");
    expect(utcDay(new Date("2026-09-18T23:59:59Z"))).toBe("2026-09-18");
  });
});
