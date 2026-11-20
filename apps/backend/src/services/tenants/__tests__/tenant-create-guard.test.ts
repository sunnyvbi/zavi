import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { owned: 0, flagOn: false };
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: async () => ({ count: state.owned, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("@/services/gatekeeper", () => ({
  isFeatureEnabled: async () => state.flagOn,
}));

import { checkSelfServeTenantCap, MAX_SELF_SERVE_TENANTS } from "../tenant-create-guard";

const U = "0335f3eb-8f08-4f72-91e1-6cd085503f13";

beforeEach(() => {
  state.owned = 0;
  state.flagOn = false;
});

describe("checkSelfServeTenantCap", () => {
  it("never gates a first company", async () => {
    expect(await checkSelfServeTenantCap(U)).toBeNull();
  });

  it("refuses a second company when multi-workspace is off", async () => {
    state.owned = 1;
    expect((await checkSelfServeTenantCap(U))?.code).toBe("multi_workspace_not_enabled");
  });

  it("allows a second company when multi-workspace is on", async () => {
    state.owned = 1;
    state.flagOn = true;
    expect(await checkSelfServeTenantCap(U)).toBeNull();
  });

  it("still applies the company cap when multi-workspace is on", async () => {
    state.owned = MAX_SELF_SERVE_TENANTS;
    state.flagOn = true;
    expect((await checkSelfServeTenantCap(U))?.code).toBe("tenant_limit");
  });
});
