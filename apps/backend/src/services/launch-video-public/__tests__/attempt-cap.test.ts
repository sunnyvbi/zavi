import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkAttemptCap } from "../caps";

const rpc = vi.fn();
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc }) }));

const getNumberSetting = vi.fn();
vi.mock("@/services/settings", () => ({ getNumberSetting: (k: string) => getNumberSetting(k) }));

beforeEach(() => {
  rpc.mockReset();
  getNumberSetting.mockReset();
  getNumberSetting.mockImplementation((k: string) =>
    Promise.resolve(k === "launch_video_public_attempts_global_day" ? 1000 : 20),
  );
});

const ok = () => rpc.mockResolvedValue({ data: true, error: null });

describe("checkAttemptCap", () => {
  it("allows an attempt under both limits", async () => {
    ok();
    expect(await checkAttemptCap({ ip_hash: "abc" })).toEqual({ allowed: true });
  });

  it("refuses on the per-IP axis FIRST and does not touch the global bucket", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await checkAttemptCap({ ip_hash: "abc" })).toEqual({
      allowed: false,
      reason: "cap",
      axis: "ip",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_key).toBe("lvp_attempt:ip:abc");
  });

  it("refuses on the GLOBAL axis when the caller's own bucket had room", async () => {
    rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    expect(await checkAttemptCap({ ip_hash: "abc" })).toEqual({
      allowed: false,
      reason: "cap",
      axis: "global",
    });
  });

  it("REFUSES a caller with no derivable IP instead of waving it through", async () => {
    expect(await checkAttemptCap({ ip_hash: null })).toEqual({ allowed: false, reason: "no_ip" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("treats a limit of 0 as uncapped without spending a round-trip", async () => {
    getNumberSetting.mockResolvedValue(0);
    expect(await checkAttemptCap({ ip_hash: "abc" })).toEqual({ allowed: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED with reason 'error' when the RPC errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await checkAttemptCap({ ip_hash: "abc" })).toEqual({ allowed: false, reason: "error" });
  });

  it("FAILS CLOSED with reason 'error' when the RPC throws", async () => {
    rpc.mockRejectedValue(new Error("connection reset"));
    expect(await checkAttemptCap({ ip_hash: "abc" })).toEqual({ allowed: false, reason: "error" });
  });

  it("reads both launch-video keys, not a render cap", async () => {
    ok();
    await checkAttemptCap({ ip_hash: "abc" });
    const keys = getNumberSetting.mock.calls.map((c) => c[0]);
    expect(keys).toContain("launch_video_public_attempts_per_ip_day");
    expect(keys).toContain("launch_video_public_attempts_global_day");
  });

  it("namespaces both keys so they cannot collide with the onboarding buckets", async () => {
    ok();
    await checkAttemptCap({ ip_hash: "deadbeef" });
    const keys = rpc.mock.calls.map((c) => c[1].p_key as string);
    expect(keys).toEqual(["lvp_attempt:ip:deadbeef", "lvp_attempt:global"]);
    for (const k of keys) {
      expect(k.startsWith("user:")).toBe(false);
      expect(k.startsWith("anon:")).toBe(false);
    }
  });

  it("meters over a rolling 24h window and passes each resolved limit through", async () => {
    ok();
    await checkAttemptCap({ ip_hash: "abc" });
    expect(rpc.mock.calls[0][1].p_window_seconds).toBe(86_400);
    expect(rpc.mock.calls[0][1].p_limit).toBe(20);
    expect(rpc.mock.calls[1][1].p_limit).toBe(1000);
  });
});
