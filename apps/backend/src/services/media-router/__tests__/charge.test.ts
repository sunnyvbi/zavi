import { describe, it, expect, vi, beforeEach } from "vitest";
const tenantRpc = vi.fn();
vi.mock("@/services/tenant-client", () => ({ tenantRpc: (...a: unknown[]) => tenantRpc(...a), asTenantId: (t: string) => t }));
const logEvent = vi.fn();
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));
const flat = { on: false };
vi.mock("@/services/billing/flat-pricing", () => ({ isFlatJobPricingOn: async () => flat.on }));
import { billedMediaUsd, chargeMedia, canAffordMedia, checkAffordMedia, type PendingCharge, flushCharges } from "../charge";

const base = { tenant_id: "t", run_id: "r", key: "r:agent-image:0:abc", cost_usd: 0.06, task: "image.photo" as const, model: "m" };

describe("media charge helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flat.on = false;
  });
  it("zero cost makes no RPC call", async () => {
    expect(await chargeMedia({ ...base, cost_usd: 0 })).toBe("zero");
    expect(tenantRpc).not.toHaveBeenCalled();
  });
  it("charges through tenantRpc with the exact arg names", async () => {
    tenantRpc.mockResolvedValueOnce({ data: "charged", error: null });
    expect(await chargeMedia(base)).toBe("charged");
    expect(tenantRpc).toHaveBeenCalledWith("t", "charge_media_credits", { p_media_key: base.key, p_cost_usd: 0.06, p_task: "image.photo", p_model: "m", p_run_id: "r" });
  });
  it("an RPC error is logged at error level and returned, never thrown", async () => {
    tenantRpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await chargeMedia(base)).toBe("error");
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "media_charge_failed" }));
  });
  it("canAffordMedia: true/false from the RPC; FAILS CLOSED on error", async () => {
    tenantRpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await canAffordMedia("t", 0.5)).toBe(true);
    tenantRpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await canAffordMedia("t", 0.5)).toBe(false);
    tenantRpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    expect(await canAffordMedia("t", 0.5)).toBe(false);
    expect(await canAffordMedia("t", 0)).toBe(true);
  });
  it("checkAffordMedia: only an explicit false is a MEASURED shortfall", async () => {
    tenantRpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await checkAffordMedia("t", 0.5)).toBe("ok");
    tenantRpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await checkAffordMedia("t", 0.5)).toBe("short");
    tenantRpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    expect(await checkAffordMedia("t", 0.5)).toBe("unknown");
    tenantRpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await checkAffordMedia("t", 0.5)).toBe("unknown");
    expect(await checkAffordMedia("t", 0)).toBe("ok");
  });
  it("flushCharges charges a run's items in ONE all-or-nothing batch call", async () => {
    tenantRpc.mockResolvedValue({ data: { [base.key]: "charged", k2: "charged" }, error: null });
    const pend: PendingCharge[] = [base, { ...base, key: "k2", cost_usd: 0.5 }];
    await flushCharges(pend);
    expect(tenantRpc).toHaveBeenCalledTimes(1);
    expect(tenantRpc).toHaveBeenCalledWith("t", "charge_media_credits_batch", {
      p_run_id: "r",
      p_items: [
        { key: base.key, cost_usd: 0.06, task: "image.photo", model: "m" },
        { key: "k2", cost_usd: 0.5, task: "image.photo", model: "m" },
      ],
    });
  });
  it("flushCharges THROWS when the batch errors (nothing landed), so the step retries the whole batch", async () => {
    tenantRpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    const pend: PendingCharge[] = [base, { ...base, key: "k2" }];
    await expect(flushCharges(pend)).rejects.toThrow(/2 of 2/);
    expect(tenantRpc).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "media_charge_failed" }));
  });
  it("a missing batch RPC throws (retry) and NEVER falls back to per-key charges that could half-charge a delivery", async () => {
    tenantRpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    await expect(flushCharges([base, { ...base, key: "k2" }])).rejects.toThrow(/2 of 2/);
    expect(tenantRpc.mock.calls.map((c) => c[1])).toEqual(["charge_media_credits_batch"]);
  });
  it("flushCharges does not throw on already / not_enforced / zero, and skips zero-cost items", async () => {
    tenantRpc.mockResolvedValueOnce({ data: { [base.key]: "already", k2: "not_enforced" }, error: null });
    await expect(flushCharges([base, { ...base, key: "k2" }, { ...base, key: "k3", cost_usd: 0 }])).resolves.toBeUndefined();
    expect((tenantRpc.mock.calls[0][2] as { p_items: unknown[] }).p_items).toHaveLength(2);
  });

});

describe("flat media pricing (switch on)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flat.on = true;
  });
  it("a priced task bills its flat credits as an exact USD amount", async () => {
    expect(await billedMediaUsd("image.photo", 0.06)).toBe(0.075);
    expect(await billedMediaUsd("video.cinematic", 2.9)).toBe(3.775);
  });
  it("an unpriced task, or a zero vendor cost, keeps the vendor amount", async () => {
    expect(await billedMediaUsd("not.a.task", 0.06)).toBe(0.06);
    expect(await billedMediaUsd("image.photo", 0)).toBe(0);
  });
  it("chargeMedia sends the flat amount", async () => {
    tenantRpc.mockResolvedValueOnce({ data: "charged", error: null });
    await chargeMedia(base);
    expect(tenantRpc).toHaveBeenCalledWith("t", "charge_media_credits", expect.objectContaining({ p_cost_usd: 0.075 }));
  });
  it("flushCharges sends the flat amount for every batch item", async () => {
    tenantRpc.mockResolvedValueOnce({ data: null, error: null });
    await flushCharges([base, { ...base, key: "k2", cost_usd: 0.5 }]);
    expect(tenantRpc).toHaveBeenCalledWith("t", "charge_media_credits_batch", {
      p_run_id: "r",
      p_items: [
        { key: base.key, cost_usd: 0.075, task: "image.photo", model: "m" },
        { key: "k2", cost_usd: 0.075, task: "image.photo", model: "m" },
      ],
    });
  });
});
