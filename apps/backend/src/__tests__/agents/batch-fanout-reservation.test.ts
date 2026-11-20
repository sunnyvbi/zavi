import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

import {
  MAX_CHILDREN_PER_BATCH,
  resolveDailyChildCap,
  reserveBatchFanoutBudgetOrReject,
} from "@/services/agents/batch-fanout-reservation";

beforeEach(() => {
  mocks.rpc.mockReset();
});

describe("resolveDailyChildCap", () => {
  const prev = process.env.PRAXIS_BATCH_FANOUT_DAILY_CHILD_CAP;
  afterEach(() => {
    if (prev === undefined) delete process.env.PRAXIS_BATCH_FANOUT_DAILY_CHILD_CAP;
    else process.env.PRAXIS_BATCH_FANOUT_DAILY_CHILD_CAP = prev;
  });
  it("returns 0 when unset (no cap)", () => {
    delete process.env.PRAXIS_BATCH_FANOUT_DAILY_CHILD_CAP;
    expect(resolveDailyChildCap()).toBe(0);
  });
  it("parses a positive integer", () => {
    process.env.PRAXIS_BATCH_FANOUT_DAILY_CHILD_CAP = "20";
    expect(resolveDailyChildCap()).toBe(20);
  });
  it("floors fractional values", () => {
    process.env.PRAXIS_BATCH_FANOUT_DAILY_CHILD_CAP = "12.7";
    expect(resolveDailyChildCap()).toBe(12);
  });
  it("treats junk / non-positive as no cap", () => {
    process.env.PRAXIS_BATCH_FANOUT_DAILY_CHILD_CAP = "abc";
    expect(resolveDailyChildCap()).toBe(0);
    process.env.PRAXIS_BATCH_FANOUT_DAILY_CHILD_CAP = "-3";
    expect(resolveDailyChildCap()).toBe(0);
  });
});

describe("reserveBatchFanoutBudgetOrReject — edge inputs (RPC NOT called)", () => {
  it("throws on child_count = 0", async () => {
    await expect(
      reserveBatchFanoutBudgetOrReject({
        tenant_id: "tnt-1",
        batch_id: "bat-1",
        parent_message_id: null,
        child_count: 0,
        cost_class: "expensive",
      }),
    ).rejects.toThrow(/child_count 0 out of range/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("throws on child_count > MAX_CHILDREN_PER_BATCH", async () => {
    await expect(
      reserveBatchFanoutBudgetOrReject({
        tenant_id: "tnt-1",
        batch_id: "bat-1",
        parent_message_id: null,
        child_count: MAX_CHILDREN_PER_BATCH + 1,
        cost_class: "expensive",
      }),
    ).rejects.toThrow(/out of range/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("reserveBatchFanoutBudgetOrReject — happy path", () => {
  it("returns ok:true with reserved_usd and remaining_usd on success", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        reserved_usd: 2.4,
        remaining_usd: 22.6,
        idempotent_retry: false,
      },
      error: null,
    });
    const r = await reserveBatchFanoutBudgetOrReject({
      tenant_id: "tnt-1",
      batch_id: "bat-1",
      parent_message_id: "msg-9",
      child_count: 3,
      cost_class: "expensive",
      daily_usd_cap: 25,
      daily_child_cap: 20,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reserved_usd).toBeCloseTo(2.4);
      expect(r.remaining_usd).toBeCloseTo(22.6);
      expect(r.idempotent_retry).toBe(false);
    }
    expect(mocks.rpc).toHaveBeenCalledWith(
      "reserve_batch_fanout_budget_or_reject",
      {
        p_tenant_id: "tnt-1",
        p_batch_id: "bat-1",
        p_parent_message_id: "msg-9",
        p_child_count: 3,
        p_estimate_usd_per_child: 0.8,
        p_daily_child_cap: 20,
        p_daily_usd_cap: 25,
      },
    );
  });

  it("passes remaining_usd=null when the RPC reports no $ cap configured", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        reserved_usd: 0.04,
        remaining_usd: null,
        idempotent_retry: false,
      },
      error: null,
    });
    const r = await reserveBatchFanoutBudgetOrReject({
      tenant_id: "tnt-1",
      batch_id: "bat-2",
      parent_message_id: null,
      child_count: 2,
      cost_class: "cheap",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remaining_usd).toBeNull();
  });
});

describe("reserveBatchFanoutBudgetOrReject — idempotent retry", () => {
  it("surfaces idempotent_retry=true on second call with same batch_id", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        reserved_usd: 1.6,
        idempotent_retry: true,
        reason: "already_reserved",
      },
      error: null,
    });
    const r = await reserveBatchFanoutBudgetOrReject({
      tenant_id: "tnt-1",
      batch_id: "bat-retry",
      parent_message_id: null,
      child_count: 2,
      cost_class: "expensive",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.idempotent_retry).toBe(true);
      expect(r.reserved_usd).toBeCloseTo(1.6);
    }
  });
});

describe("reserveBatchFanoutBudgetOrReject — cap rejections", () => {
  it("returns ok:false with reason=daily_usd_cap_exceeded + detail", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: false,
        reason: "daily_usd_cap_exceeded",
        cap: 25,
        requested_usd: 30,
      },
      error: null,
    });
    const r = await reserveBatchFanoutBudgetOrReject({
      tenant_id: "tnt-1",
      batch_id: "bat-over",
      parent_message_id: null,
      child_count: 4,
      cost_class: "expensive",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("daily_usd_cap_exceeded");
      expect(r.detail).toMatchObject({ cap: 25, requested_usd: 30 });
    }
  });

  it("returns ok:false with reason=daily_child_cap_exceeded", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: false,
        reason: "daily_child_cap_exceeded",
        cap: 4,
        current: 2,
        requested: 3,
      },
      error: null,
    });
    const r = await reserveBatchFanoutBudgetOrReject({
      tenant_id: "tnt-1",
      batch_id: "bat-over-kids",
      parent_message_id: null,
      child_count: 3,
      cost_class: "expensive",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("daily_child_cap_exceeded");
      expect(r.detail).toMatchObject({ cap: 4, current: 2, requested: 3 });
    }
  });

  it("throws on unrecognized reason (defense-in-depth)", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, reason: "wat" },
      error: null,
    });
    await expect(
      reserveBatchFanoutBudgetOrReject({
        tenant_id: "tnt-1",
        batch_id: "bat-wat",
        parent_message_id: null,
        child_count: 1,
        cost_class: "cheap",
      }),
    ).rejects.toThrow(/unexpected reason: wat/);
  });
});

describe("reserveBatchFanoutBudgetOrReject — fail-closed on malformed success payloads (codex P2/P3)", () => {
  it("throws when ok:true but reserved_usd is missing", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, remaining_usd: 22.6, idempotent_retry: false },
      error: null,
    });
    await expect(
      reserveBatchFanoutBudgetOrReject({
        tenant_id: "tnt-1",
        batch_id: "bat-mal-1",
        parent_message_id: null,
        child_count: 1,
        cost_class: "cheap",
      }),
    ).rejects.toThrow(/malformed success: reserved_usd/);
  });

  it("throws when ok:true but reserved_usd is non-numeric", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, reserved_usd: "0.1", idempotent_retry: false },
      error: null,
    });
    await expect(
      reserveBatchFanoutBudgetOrReject({
        tenant_id: "tnt-1",
        batch_id: "bat-mal-2",
        parent_message_id: null,
        child_count: 1,
        cost_class: "cheap",
      }),
    ).rejects.toThrow(/malformed success: reserved_usd/);
  });

  it("throws when ok:true but reserved_usd is NaN", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, reserved_usd: Number.NaN, idempotent_retry: false },
      error: null,
    });
    await expect(
      reserveBatchFanoutBudgetOrReject({
        tenant_id: "tnt-1",
        batch_id: "bat-mal-3",
        parent_message_id: null,
        child_count: 1,
        cost_class: "cheap",
      }),
    ).rejects.toThrow(/malformed success: reserved_usd/);
  });

  it("throws when ok:true but remaining_usd is non-numeric / non-null", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        reserved_usd: 0.04,
        remaining_usd: "lots",
        idempotent_retry: false,
      },
      error: null,
    });
    await expect(
      reserveBatchFanoutBudgetOrReject({
        tenant_id: "tnt-1",
        batch_id: "bat-mal-4",
        parent_message_id: null,
        child_count: 1,
        cost_class: "cheap",
      }),
    ).rejects.toThrow(/malformed success: remaining_usd/);
  });

  it("treats missing idempotent_retry as false (not truthy-coerced)", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        reserved_usd: 0.04,
        remaining_usd: null,
      },
      error: null,
    });
    const r = await reserveBatchFanoutBudgetOrReject({
      tenant_id: "tnt-1",
      batch_id: "bat-mal-5",
      parent_message_id: null,
      child_count: 1,
      cost_class: "cheap",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idempotent_retry).toBe(false);
  });

  it("recognizes new RPC reason='already_reserved_concurrent' (race-recovery path)", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        reserved_usd: 1.6,
        idempotent_retry: true,
        reason: "already_reserved_concurrent",
      },
      error: null,
    });
    const r = await reserveBatchFanoutBudgetOrReject({
      tenant_id: "tnt-1",
      batch_id: "bat-concur",
      parent_message_id: null,
      child_count: 2,
      cost_class: "expensive",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.idempotent_retry).toBe(true);
      expect(r.reserved_usd).toBeCloseTo(1.6);
    }
  });
});

describe("reserveBatchFanoutBudgetOrReject — fail-closed on RPC errors", () => {
  it("throws when supabase returns an error (caller must NOT enqueue children)", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "connection refused" },
    });
    await expect(
      reserveBatchFanoutBudgetOrReject({
        tenant_id: "tnt-1",
        batch_id: "bat-boom",
        parent_message_id: null,
        child_count: 2,
        cost_class: "expensive",
      }),
    ).rejects.toThrow(/connection refused/);
  });

  it("throws when supabase returns empty data", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(
      reserveBatchFanoutBudgetOrReject({
        tenant_id: "tnt-1",
        batch_id: "bat-empty",
        parent_message_id: null,
        child_count: 1,
        cost_class: "standard",
      }),
    ).rejects.toThrow(/empty\/non-object/);
  });
});
