import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { blob: Record<string, unknown> | null; error: unknown } = {
  blob: {},
  error: null,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.error
              ? { data: null, error: state.error }
              : { data: state.blob === null ? null : { blob: state.blob }, error: null },
        }),
      }),
    }),
  }),
}));

import { isAdsManagerTriageFocusEnabled } from "../triage-focus-flag";

beforeEach(() => {
  state.blob = {};
  state.error = null;
});

describe("isAdsManagerTriageFocusEnabled — default ON, error fails safe", () => {
  it("absent key + clean read → true (triage on by default)", async () => {
    state.blob = {};
    expect(await isAdsManagerTriageFocusEnabled()).toBe(true);
  });

  it("explicit true → true", async () => {
    state.blob = { ads_manager_triage_focus: true };
    expect(await isAdsManagerTriageFocusEnabled()).toBe(true);
  });

  it("explicit false → false (the kill-switch that reverts to legacy)", async () => {
    state.blob = { ads_manager_triage_focus: false };
    expect(await isAdsManagerTriageFocusEnabled()).toBe(false);
  });

  it("non-boolean value → true (only an explicit false disables)", async () => {
    state.blob = { ads_manager_triage_focus: "true" };
    expect(await isAdsManagerTriageFocusEnabled()).toBe(true);
  });

  it("other flags present, triage key absent → true", async () => {
    state.blob = { meta_ads_write_enabled: true, disabled_agent_slugs: ["dispute-response"] };
    expect(await isAdsManagerTriageFocusEnabled()).toBe(true);
  });

  it("no system_config row → true (absent ⇒ default on)", async () => {
    state.blob = null;
    expect(await isAdsManagerTriageFocusEnabled()).toBe(true);
  });

  it("system_config read error → false (fail safe to legacy on a degraded read)", async () => {
    state.error = { message: "pooler down" };
    expect(await isAdsManagerTriageFocusEnabled()).toBe(false);
  });
});
