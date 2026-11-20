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

import { isPmRoadmapEnabled } from "../roadmap-flag";

beforeEach(() => {
  state.blob = {};
  state.error = null;
});

describe("isPmRoadmapEnabled — default ON unless explicitly disabled", () => {
  it("absent key → ON (the new default)", async () => {
    state.blob = {};
    expect(await isPmRoadmapEnabled()).toBe(true);
  });

  it("explicit true → ON", async () => {
    state.blob = { pm_roadmap_enabled: true };
    expect(await isPmRoadmapEnabled()).toBe(true);
  });

  it("explicit false → OFF (kill switch)", async () => {
    state.blob = { pm_roadmap_enabled: false };
    expect(await isPmRoadmapEnabled()).toBe(false);
  });

  it("other keys present, pm_roadmap_enabled absent → still ON (no clobber of default)", async () => {
    state.blob = { disabled_agent_slugs: ["advisor"], meta_ads_write_enabled: false };
    expect(await isPmRoadmapEnabled()).toBe(true);
  });

  it("system_config read error → OFF (outage fails safe, never silently flips)", async () => {
    state.error = { message: "pooler down" };
    expect(await isPmRoadmapEnabled()).toBe(false);
  });

  it("no system_config row at all → ON (absent blob == default)", async () => {
    state.blob = null;
    expect(await isPmRoadmapEnabled()).toBe(true);
  });
});
