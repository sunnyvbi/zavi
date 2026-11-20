import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.maybeSingle }),
      }),
    }),
  }),
}));

import {
  isShadowTenantAllowed,
  assertShadowTenantAllowed,
  SHADOW_DOGFOOD_TENANT,
} from "@/services/eval/shadow-tenant-allowlist";

const CUSTOMER = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

beforeEach(() => {
  mocks.maybeSingle.mockReset();
});

describe("isShadowTenantAllowed", () => {
  it("dogfood is ALWAYS allowed (no DB read — outage can't lock it out)", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "down" } });
    expect(await isShadowTenantAllowed(SHADOW_DOGFOOD_TENANT)).toBe(true);
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("empty allowlist → a customer tenant is NOT allowed (ships inert)", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { blob: { shadow_customer_tenant_ids: [] } },
      error: null,
    });
    expect(await isShadowTenantAllowed(CUSTOMER)).toBe(false);
  });

  it("a customer tenant on the allowlist IS allowed", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { blob: { shadow_customer_tenant_ids: [CUSTOMER] } },
      error: null,
    });
    expect(await isShadowTenantAllowed(CUSTOMER)).toBe(true);
    expect(await isShadowTenantAllowed(OTHER)).toBe(false);
  });

  it("FAIL-CLOSED: a read error → not allowed", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await isShadowTenantAllowed(CUSTOMER)).toBe(false);
  });

  it("FAIL-CLOSED: missing/malformed allowlist (not an array) → not allowed", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { blob: {} }, error: null });
    expect(await isShadowTenantAllowed(CUSTOMER)).toBe(false);
    mocks.maybeSingle.mockResolvedValue({
      data: { blob: { shadow_customer_tenant_ids: "nope" } },
      error: null,
    });
    expect(await isShadowTenantAllowed(CUSTOMER)).toBe(false);
  });

  it("FAIL-CLOSED: empty/blank tenant → not allowed", async () => {
    expect(await isShadowTenantAllowed("")).toBe(false);
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: thrown error inside the read → not allowed (caught)", async () => {
    mocks.maybeSingle.mockRejectedValue(new Error("network"));
    expect(await isShadowTenantAllowed(CUSTOMER)).toBe(false);
  });
});

describe("assertShadowTenantAllowed", () => {
  it("throws for a non-allowlisted tenant", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { blob: { shadow_customer_tenant_ids: [] } },
      error: null,
    });
    await expect(assertShadowTenantAllowed(CUSTOMER)).rejects.toThrow(/not on the shadow allowlist/);
  });
  it("does not throw for dogfood", async () => {
    await expect(assertShadowTenantAllowed(SHADOW_DOGFOOD_TENANT)).resolves.toBeUndefined();
  });
});
