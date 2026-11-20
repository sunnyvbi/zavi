
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { pulseOneTenant } from "../perfmkt-pulse";

beforeAll(() => {
  process.env.PRAXIS_DISABLE_CRON_STOP = "1";
});
afterAll(() => {
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

import type { PulseWindowMetrics } from "../perfmkt-pulse-detect";

type Deps = Parameters<typeof pulseOneTenant>[1];

const QUIET: PulseWindowMetrics = { spend_usd: 100, conversions: 10, purchase_value_usd: 300 };
const BLEED: PulseWindowMetrics = { spend_usd: 200, conversions: 10, purchase_value_usd: 300 };

function deps(over: Partial<Deps> = {}): Deps {
  return {
    isAutopilotOn: vi.fn(async () => true),
    isPulseEnabled: vi.fn(async () => true),
    getCreds: vi.fn(async () => ({ ad_account_id: "act_123" })),
    readWindow: vi.fn(async () => QUIET),
    readPixelStatus: vi.fn(async () => "healthy" as const),
    enqueue: vi.fn(async () => ({ run_id: "run-abc" })),
    ...over,
  };
}

describe("pulseOneTenant — gates (no enqueue, no Meta reads)", () => {
  it("autopilot OFF → skipped(autopilot_off), never reads Meta or enqueues", async () => {
    const d = deps({ isAutopilotOn: vi.fn(async () => false) });
    const out = await pulseOneTenant({ id: "t1" }, d);
    expect(out).toEqual({ status: "skipped", reason: "autopilot_off" });
    expect(d.getCreds).not.toHaveBeenCalled();
    expect(d.readWindow).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("pulse flag OFF → skipped(pulse_disabled), no enqueue", async () => {
    const d = deps({ isPulseEnabled: vi.fn(async () => false) });
    const out = await pulseOneTenant({ id: "t1" }, d);
    expect(out).toEqual({ status: "skipped", reason: "pulse_disabled" });
    expect(d.getCreds).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("Meta not connected (getCreds throws) → skipped(meta_not_connected), no enqueue", async () => {
    const d = deps({
      getCreds: vi.fn(async () => {
        throw new Error("meta_ads_not_connected");
      }),
    });
    const out = await pulseOneTenant({ id: "t1" }, d);
    expect(out).toEqual({ status: "skipped", reason: "meta_not_connected" });
    expect(d.enqueue).not.toHaveBeenCalled();
  });
});

describe("pulseOneTenant — quiet day (no breach)", () => {
  it("flat windows + healthy pixel → quiet, NO enqueue", async () => {
    const d = deps();
    const out = await pulseOneTenant({ id: "t1" }, d);
    expect(out).toEqual({ status: "quiet" });
    expect(d.enqueue).not.toHaveBeenCalled();
  });
});

describe("pulseOneTenant — breach → enqueue", () => {
  it("spend bleed (current 2× prior) → enqueues a scoped performance-marketer run", async () => {
    const readWindow: Deps["readWindow"] = vi
      .fn()
      .mockResolvedValueOnce(BLEED)
      .mockResolvedValueOnce(QUIET);
    const d = deps({ readWindow });
    const out = await pulseOneTenant({ id: "t1" }, d);
    expect(out.status).toBe("enqueued");
    if (out.status === "enqueued") {
      expect(out.run_id).toBe("run-abc");
      expect(out.breach_metrics).toContain("spend/up");
    }
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    const arg = (d.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.tenant_id).toBe("t1");
    expect(arg.intent).toContain("AUTOMATED DAILY ADS PULSE");
    expect(arg.breaches.length).toBeGreaterThan(0);
  });

  it("degraded pixel alone → enqueues (tracking break wakes the specialist)", async () => {
    const d = deps({ readPixelStatus: vi.fn(async () => "degraded" as const) });
    const out = await pulseOneTenant({ id: "t9" }, d);
    expect(out.status).toBe("enqueued");
    expect(d.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("pulseOneTenant — per-tenant scoping", () => {
  it("every dep call + enqueue is keyed to the exact tenant id passed in", async () => {
    const readWindow: Deps["readWindow"] = vi
      .fn()
      .mockResolvedValueOnce(BLEED)
      .mockResolvedValueOnce(QUIET);
    const d = deps({ readWindow });
    await pulseOneTenant({ id: "tenant-XYZ" }, d);
    expect(d.isAutopilotOn).toHaveBeenCalledWith("tenant-XYZ");
    expect(d.isPulseEnabled).toHaveBeenCalledWith("tenant-XYZ");
    expect(d.getCreds).toHaveBeenCalledWith("tenant-XYZ");
    expect(d.readPixelStatus).toHaveBeenCalledWith("tenant-XYZ");
    expect((d.readWindow as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("tenant-XYZ");
    const enqArg = (d.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(enqArg.tenant_id).toBe("tenant-XYZ");
  });
});
