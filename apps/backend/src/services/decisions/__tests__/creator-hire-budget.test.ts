import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc }) }));

import {
  creatorHireIdemKey,
  recordCreatorCaps,
  refundCreatorHire,
  reserveCreatorHire,
  settleCreatorHire,
} from "../creator-hire-budget";

const T = "tenant-1";
const HIRE = { order_id: "order-1", amount_usd: 250, caps_id: "caps-1" };
const ok = (data: unknown) => rpc.mockResolvedValue({ data, error: null });

beforeEach(() => {
  rpc.mockReset();
});

describe("reserveCreatorHire", () => {
  it("sends the order-keyed idem key, the amount and the caps id, with the tenant injected", async () => {
    ok({ status: "reserved", amount_usd: "250.00", left_usd: "750.00" });
    expect(await reserveCreatorHire(T, HIRE)).toEqual({ status: "reserved", amount_usd: 250, left_usd: 750 });
    expect(rpc).toHaveBeenCalledWith("reserve_creator_hire", {
      p_tenant_id: T,
      p_idem_key: "creator-hire:order-1",
      p_order_id: "order-1",
      p_amount_usd: 250,
      p_caps_id: "caps-1",
    });
    expect(creatorHireIdemKey("order-1")).toBe("creator-hire:order-1");
  });

  it("passes the hire card and its approver when given (autopilot tracking T1)", async () => {
    ok({ status: "reserved", amount_usd: "250.00", left_usd: "750.00" });
    await reserveCreatorHire(T, { ...HIRE, channel_action_id: "act-1", approved_by_user_id: "user-1" });
    expect(rpc).toHaveBeenCalledWith("reserve_creator_hire", expect.objectContaining({ p_channel_action_id: "act-1", p_approved_by_user_id: "user-1" }));
  });

  it.each(["no_budget", "no_caps", "over_hire_cap", "over_week_cap", "over_budget"])("%s is a refusal, never reserved", async (s) => {
    ok({ status: s, amount_usd: "250.00" });
    expect(await reserveCreatorHire(T, HIRE)).toEqual({ status: s, amount_usd: 250 });
  });

  it("no_budget with amount 0 maps to 0", async () => {
    ok({ status: "no_budget", amount_usd: 0 });
    expect(await reserveCreatorHire(T, HIRE)).toEqual({ status: "no_budget", amount_usd: 0 });
  });

  it("a retry carries the row's state so a caller never charges an already-spent hire twice", async () => {
    ok({ status: "already_held", amount_usd: "250.00", state: "held" });
    expect(await reserveCreatorHire(T, HIRE)).toEqual({ status: "already_held", amount_usd: 250, state: "held" });
    ok({ status: "already_held", amount_usd: "250.00", state: "spent" });
    expect(await reserveCreatorHire(T, HIRE)).toEqual({ status: "already_held", amount_usd: 250, state: "spent" });
  });

  it("fails closed: RPC error, thrown client, unknown status, missing fields, bad amount", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "PGRST202" } });
    expect((await reserveCreatorHire(T, HIRE)).status).toBe("unavailable");
    rpc.mockImplementation(() => {
      throw new Error("socket hang up");
    });
    expect((await reserveCreatorHire(T, HIRE)).status).toBe("unavailable");
    rpc.mockReset();
    ok({ status: "maybe" });
    expect((await reserveCreatorHire(T, HIRE)).status).toBe("unavailable");
    ok(null);
    expect((await reserveCreatorHire(T, HIRE)).status).toBe("unavailable");
    ok({ status: "reserved" });
    expect((await reserveCreatorHire(T, HIRE)).status).toBe("unavailable");
    ok({ status: "already_held", amount_usd: 1, state: "released" });
    expect((await reserveCreatorHire(T, HIRE)).status).toBe("unavailable");
    rpc.mockReset();
    expect((await reserveCreatorHire(T, { ...HIRE, amount_usd: 0 })).status).toBe("unavailable");
    expect((await reserveCreatorHire(T, { ...HIRE, amount_usd: Number.NaN })).status).toBe("unavailable");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("settleCreatorHire", () => {
  it("keys by order and maps each answer", async () => {
    ok({ status: "spent", changed: true });
    expect(await settleCreatorHire(T, "order-1", "spent")).toEqual({ status: "spent", changed: true });
    expect(rpc).toHaveBeenCalledWith("settle_creator_hire", { p_tenant_id: T, p_idem_key: "creator-hire:order-1", p_outcome: "spent" });
    ok({ status: "spent", changed: false });
    expect(await settleCreatorHire(T, "order-1", "released")).toEqual({ status: "spent", changed: false });
    ok({ status: "not_found" });
    expect(await settleCreatorHire(T, "order-1", "released")).toEqual({ status: "not_found" });
  });
  it("fails closed", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await settleCreatorHire(T, "order-1", "spent")).status).toBe("unavailable");
    ok({ status: "spent" });
    expect((await settleCreatorHire(T, "order-1", "spent")).status).toBe("unavailable");
  });
});

describe("refundCreatorHire", () => {
  it("sends the cumulative refunded amount and maps each answer", async () => {
    ok({ status: "partially_refunded", refunded_usd: "100.00" });
    expect(await refundCreatorHire(T, "order-1", 100)).toEqual({ status: "partially_refunded", refunded_usd: 100 });
    expect(rpc).toHaveBeenCalledWith("refund_creator_hire", { p_tenant_id: T, p_order_id: "order-1", p_amount_usd: 100 });
    ok({ status: "refunded", refunded_usd: "250.00" });
    expect(await refundCreatorHire(T, "order-1", 250)).toEqual({ status: "refunded", refunded_usd: 250 });
    ok({ status: "not_found" });
    expect(await refundCreatorHire(T, "order-1", 250)).toEqual({ status: "not_found" });
  });
  it("fails closed", async () => {
    expect((await refundCreatorHire(T, "order-1", 0)).status).toBe("unavailable");
    expect(rpc).not.toHaveBeenCalled();
    ok({ status: "refunded" });
    expect((await refundCreatorHire(T, "order-1", 5)).status).toBe("unavailable");
  });
});

describe("recordCreatorCaps", () => {
  it("records a version with the run id and returns its id", async () => {
    ok({ status: "recorded", id: "caps-9" });
    expect(await recordCreatorCaps(T, { per_hire_usd: 200, per_week_usd: 600, why: "test two creators", run_id: "run-1" })).toEqual({
      status: "recorded",
      id: "caps-9",
    });
    expect(rpc).toHaveBeenCalledWith("record_cgo_creator_caps", {
      p_tenant_id: T,
      p_per_hire_usd: 200,
      p_per_week_usd: 600,
      p_why: "test two creators",
      p_run_id: "run-1",
    });
  });
  it("fails closed", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "run not found for tenant" } });
    expect((await recordCreatorCaps(T, { per_hire_usd: 1, per_week_usd: 1, why: "x", run_id: null })).status).toBe("unavailable");
  });
});
