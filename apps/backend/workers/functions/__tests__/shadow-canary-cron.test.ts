
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  flagEnabled: false,
  flagError: false,
  halted: false,
}));

vi.mock("@/services/supabase", () => {
  const cfgQ: Record<string, unknown> = {
    select: () => cfgQ,
    eq: () => cfgQ,
    maybeSingle: () => {
      if (h.flagError) return { data: null, error: { message: "cfg down" } };
      return { data: { blob: { shadow_canary_cron_enabled: h.flagEnabled } }, error: null };
    },
  };
  return { serviceClient: () => ({ from: () => cfgQ }) };
});

vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: async () => h.halted,
}));

import {
  isShadowCanaryCronEnabled,
  isShadowCanaryTenantAllowed,
  runShadowCanaryCron,
  DOGFOOD_TENANT,
} from "../shadow-canary-cron";

describe("isShadowCanaryCronEnabled — fail-closed flag", () => {
  beforeEach(() => {
    h.flagEnabled = false;
    h.flagError = false;
    h.halted = false;
  });

  it("false by default (flag absent/false)", async () => {
    expect(await isShadowCanaryCronEnabled()).toBe(false);
  });

  it("true only when the flag is explicitly true", async () => {
    h.flagEnabled = true;
    expect(await isShadowCanaryCronEnabled()).toBe(true);
  });

  it("fail-CLOSED on a system_config read error", async () => {
    h.flagError = true;
    expect(await isShadowCanaryCronEnabled()).toBe(false);
  });
});

describe("isShadowCanaryTenantAllowed — dogfood-only until Slice 2", () => {
  it("allows ONLY the dogfood tenant", () => {
    expect(isShadowCanaryTenantAllowed(DOGFOOD_TENANT)).toBe(true);
    expect(isShadowCanaryTenantAllowed("c0ffeeee-0000-0000-0000-000000000000")).toBe(false);
    expect(isShadowCanaryTenantAllowed("")).toBe(false);
  });
});

describe("runShadowCanaryCron — INERT on merge", () => {
  beforeEach(() => {
    h.flagEnabled = false;
    h.flagError = false;
    h.halted = false;
  });

  it("flag OFF → returns { enabled:false } with ZERO work (no replay spawned)", async () => {
    const r = await runShadowCanaryCron();
    expect(r).toEqual({ enabled: false });
  });

  it("fail-closed flag read → still inert", async () => {
    h.flagError = true;
    const r = await runShadowCanaryCron();
    expect(r).toEqual({ enabled: false });
  });
});
