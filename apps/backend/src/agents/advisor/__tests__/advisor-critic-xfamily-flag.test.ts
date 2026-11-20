import { describe, it, expect, beforeEach, vi } from "vitest";

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
              : {
                  data: state.blob === null ? null : { blob: state.blob },
                  error: null,
                },
        }),
      }),
    }),
  }),
}));

import { isAdvisorCriticXfamilyEnabled } from "../advisor-critic-xfamily-flag";

beforeEach(() => {
  state.blob = {};
  state.error = null;
});

describe("isAdvisorCriticXfamilyEnabled — default OFF, per-tenant allowlist", () => {
  it("absent key → OFF (ships inert)", async () => {
    expect(await isAdvisorCriticXfamilyEnabled("t1")).toBe(false);
  });
  it("enabled:false → OFF", async () => {
    state.blob = { advisor_critic_xfamily: { enabled: false } };
    expect(await isAdvisorCriticXfamilyEnabled("t1")).toBe(false);
  });
  it("enabled:true + empty allowlist → ON fleet-wide", async () => {
    state.blob = { advisor_critic_xfamily: { enabled: true, tenant_allowlist: [] } };
    expect(await isAdvisorCriticXfamilyEnabled("any")).toBe(true);
  });
  it("enabled:true + absent allowlist → ON fleet-wide", async () => {
    state.blob = { advisor_critic_xfamily: { enabled: true } };
    expect(await isAdvisorCriticXfamilyEnabled("any")).toBe(true);
  });
  it("enabled:true + tenant IN allowlist → ON", async () => {
    state.blob = { advisor_critic_xfamily: { enabled: true, tenant_allowlist: ["t1", "t2"] } };
    expect(await isAdvisorCriticXfamilyEnabled("t1")).toBe(true);
  });
  it("enabled:true + tenant NOT in allowlist → OFF (contained pilot)", async () => {
    state.blob = { advisor_critic_xfamily: { enabled: true, tenant_allowlist: ["t2"] } };
    expect(await isAdvisorCriticXfamilyEnabled("t1")).toBe(false);
  });
  it("enabled truthy-but-not-true → OFF", async () => {
    state.blob = { advisor_critic_xfamily: { enabled: "true" } };
    expect(await isAdvisorCriticXfamilyEnabled("t1")).toBe(false);
  });
  it("read error → OFF (outage fails SAFE)", async () => {
    state.error = { message: "pooler down" };
    expect(await isAdvisorCriticXfamilyEnabled("t1")).toBe(false);
  });
  it("separate from pm key — pm flag present, advisor absent → OFF", async () => {
    state.blob = { pm_critic_xfamily: { enabled: true } };
    expect(await isAdvisorCriticXfamilyEnabled("t1")).toBe(false);
  });
});
