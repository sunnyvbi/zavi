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

import { isPmCriticXfamilyEnabled } from "../pm-critic-xfamily-flag";

beforeEach(() => {
  state.blob = {};
  state.error = null;
});

describe("isPmCriticXfamilyEnabled — default OFF, per-tenant allowlist", () => {
  it("absent key → OFF (ships inert)", async () => {
    state.blob = {};
    expect(await isPmCriticXfamilyEnabled("t1")).toBe(false);
  });

  it("enabled:false → OFF", async () => {
    state.blob = { pm_critic_xfamily: { enabled: false } };
    expect(await isPmCriticXfamilyEnabled("t1")).toBe(false);
  });

  it("enabled:true + empty allowlist → ON fleet-wide", async () => {
    state.blob = { pm_critic_xfamily: { enabled: true, tenant_allowlist: [] } };
    expect(await isPmCriticXfamilyEnabled("anytenant")).toBe(true);
  });

  it("enabled:true + absent allowlist → ON fleet-wide", async () => {
    state.blob = { pm_critic_xfamily: { enabled: true } };
    expect(await isPmCriticXfamilyEnabled("anytenant")).toBe(true);
  });

  it("enabled:true + tenant IN allowlist → ON (contained pilot hit)", async () => {
    state.blob = {
      pm_critic_xfamily: { enabled: true, tenant_allowlist: ["t1", "t2"] },
    };
    expect(await isPmCriticXfamilyEnabled("t1")).toBe(true);
  });

  it("enabled:true + tenant NOT in allowlist → OFF (contained pilot miss)", async () => {
    state.blob = {
      pm_critic_xfamily: { enabled: true, tenant_allowlist: ["t2", "t3"] },
    };
    expect(await isPmCriticXfamilyEnabled("t1")).toBe(false);
  });

  it("enabled truthy-but-not-true (string) → OFF (only boolean true arms)", async () => {
    state.blob = { pm_critic_xfamily: { enabled: "true" } };
    expect(await isPmCriticXfamilyEnabled("t1")).toBe(false);
  });

  it("system_config read error → OFF (outage fails SAFE — never arms egress)", async () => {
    state.error = { message: "pooler down" };
    expect(await isPmCriticXfamilyEnabled("t1")).toBe(false);
  });

  it("no system_config row at all → OFF", async () => {
    state.blob = null;
    expect(await isPmCriticXfamilyEnabled("t1")).toBe(false);
  });

  it("other pm flags present, pm_critic_xfamily absent → OFF (not clobbered)", async () => {
    state.blob = { pm_operator_db_enabled: true, pm_roadmap_enabled: true };
    expect(await isPmCriticXfamilyEnabled("t1")).toBe(false);
  });
});
