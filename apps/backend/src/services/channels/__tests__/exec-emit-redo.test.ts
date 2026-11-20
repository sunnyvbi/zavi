
import { describe, it, expect, vi, beforeEach } from "vitest";

const switchedChannelForRun = vi.fn();
vi.mock("@/services/channels/channel-actions", () => ({
  switchedChannelForRun: (...a: unknown[]) => switchedChannelForRun(...a),
}));

import { resolveChannelExecEmit } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";

const emit_decision = vi.fn(async () => "decision-1");
const write = vi.fn(async () => "action-1");

beforeEach(() => {
  vi.clearAllMocks();
  switchedChannelForRun.mockResolvedValue("google_ads");
});

const base = { tenant_id: "t-1", run_id: "r-1", emit_decision };

const GOOGLE: ReadonlySet<string> = new Set(["google_ads", "youtube_ads"]);

describe("resolveChannelExecEmit — a redo proposes nothing", () => {
  for (const channel of ["google_ads", "meta_ads"]) {
    it(`gives the switched ${channel} rail a closure that refuses when invoked`, async () => {
      switchedChannelForRun.mockResolvedValue(channel);
      const emit = await resolveChannelExecEmit(new Set([channel]), { ...base, redo: true }, write);
      expect(emit).toBeTypeOf("function");
      await expect(emit!("google_ads.budget_change", {})).rejects.toBeInstanceOf(
        ExpectedToolError,
      );
      expect(write).not.toHaveBeenCalled();
      expect(emit_decision).not.toHaveBeenCalled();
    });
  }

  it("a resolve that is never invoked does NOT throw, so reads still work", async () => {
    const emit = await resolveChannelExecEmit(GOOGLE, { ...base, redo: true }, write);
    expect(emit).toBeTypeOf("function");
    expect(write).not.toHaveBeenCalled();
  });

  it("carries a machine-readable code, not just prose", async () => {
    const emit = await resolveChannelExecEmit(GOOGLE, { ...base, redo: true }, write);
    await emit!("google_ads.budget_change", {}).catch((e: ExpectedToolError) => {
      expect(e.code).toBe("redo_scope");
    });
    expect.assertions(1);
  });

  it("leaves an UNSWITCHED run to the runner belt, closure untouched", async () => {
    switchedChannelForRun.mockResolvedValue(null);
    const emit = await resolveChannelExecEmit(GOOGLE, { ...base, redo: true }, write);
    expect(emit).toBe(emit_decision);
  });
});

describe("resolveChannelExecEmit — a normal run is untouched", () => {
  it("still routes a switched run to the platform's writer", async () => {
    const emit = await resolveChannelExecEmit(GOOGLE, base, write);
    expect(emit).toBeTypeOf("function");
    await emit!("google_ads.remove_resource", { level: "keyword" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("still hands an unswitched run its original emit closure", async () => {
    switchedChannelForRun.mockResolvedValue(null);
    const emit = await resolveChannelExecEmit(GOOGLE, base, write);
    expect(emit).toBe(emit_decision);
  });

  it("an absent redo flag means normal, not refused", async () => {
    const emit = await resolveChannelExecEmit(GOOGLE, { ...base, redo: undefined }, write);
    expect(emit).toBeTypeOf("function");
  });
});

describe("a platform pin can hold more than one channel", () => {
  it("routes a youtube_ads run to google's writer, not to the legacy closure", async () => {
    switchedChannelForRun.mockResolvedValue("youtube_ads");
    const emit = await resolveChannelExecEmit(GOOGLE, base, write);
    await emit!("google_ads.update_campaign_budget", { daily_budget_usd: 40 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(emit_decision).not.toHaveBeenCalled();
  });

  it("still leaves another platform's switched channel alone", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const emit = await resolveChannelExecEmit(GOOGLE, base, write);
    expect(emit).toBe(emit_decision);
    expect(write).not.toHaveBeenCalled();
  });
});
