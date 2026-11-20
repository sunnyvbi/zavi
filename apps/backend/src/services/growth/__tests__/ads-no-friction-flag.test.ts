import { describe, expect, it, vi } from "vitest";

const state: { blob: unknown; error: unknown; throws: boolean } = { blob: {}, error: null, throws: false };
vi.mock("@/services/tenant-client", () => ({
  globalClient: () => {
    if (state.throws) throw new Error("down");
    return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { blob: state.blob }, error: state.error }) }) }) }) };
  },
}));

import { adsNoFrictionEnabled, adsNoFrictionFromBlob } from "@/services/growth/ads-no-friction-flag";

describe("ads_launch_no_friction_enabled", () => {
  it("ON by default", () => expect(adsNoFrictionFromBlob({})).toBe(true));
  it("OFF only on explicit false", () => {
    expect(adsNoFrictionFromBlob({ ads_launch_no_friction_enabled: false })).toBe(false);
    expect(adsNoFrictionFromBlob({ ads_launch_no_friction_enabled: true })).toBe(true);
  });
  it("unreadable = OFF (today's behaviour)", () => expect(adsNoFrictionFromBlob(null)).toBe(false));
  it("reads system_config; an error or a throw = OFF", async () => {
    state.blob = {}; state.error = null; state.throws = false;
    expect(await adsNoFrictionEnabled()).toBe(true);
    state.error = { message: "x" };
    expect(await adsNoFrictionEnabled()).toBe(false);
    state.error = null; state.throws = true;
    expect(await adsNoFrictionEnabled()).toBe(false);
  });
});
