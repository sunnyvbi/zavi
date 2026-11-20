import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ maybeSingle: vi.fn(), eq: vi.fn() }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, v: string) => {
          mocks.eq(table, cols, col, v);
          return { maybeSingle: mocks.maybeSingle };
        },
      }),
    }),
  }),
}));

import {
  isTenantDisabled,
  readTenantDisabled,
  invalidateTenantDisabledCache,
  TenantDisabledError,
} from "../disabled";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  mocks.maybeSingle.mockReset();
  mocks.eq.mockReset();
  invalidateTenantDisabledCache();
});

describe("tenant disabled reader", () => {
  it("reads tenants.disabled_at scoped to the tenant id", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { disabled_at: "2026-10-16T00:00:00Z" }, error: null });
    expect(await isTenantDisabled(T)).toBe(true);
    expect(mocks.eq).toHaveBeenCalledWith("tenants", "disabled_at", "id", T);
  });

  it("an active or missing tenant is not disabled", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: { disabled_at: null }, error: null });
    expect(await isTenantDisabled(T)).toBe(false);
    invalidateTenantDisabledCache(T);
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect(await isTenantDisabled(T)).toBe(false);
  });

  it("a failed read is unknown: closed by default, open when the caller asks", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await readTenantDisabled(T)).toBeNull();
    expect(await isTenantDisabled(T)).toBe(true);
    expect(await isTenantDisabled(T, "closed")).toBe(true);
    expect(await isTenantDisabled(T, "open")).toBe(false);
    mocks.maybeSingle.mockRejectedValue(new Error("network"));
    expect(await isTenantDisabled(T, "closed")).toBe(true);
    expect(await isTenantDisabled(T, "open")).toBe(false);
  });

  it("caches a good read, never a failed one, and invalidation drops it", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await isTenantDisabled(T, "open");
    mocks.maybeSingle.mockResolvedValueOnce({ data: { disabled_at: null }, error: null });
    expect(await isTenantDisabled(T)).toBe(false);
    expect(await isTenantDisabled(T)).toBe(false);
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
    invalidateTenantDisabledCache(T);
    mocks.maybeSingle.mockResolvedValueOnce({ data: { disabled_at: "x" }, error: null });
    expect(await isTenantDisabled(T)).toBe(true);
  });

  it("TenantDisabledError carries the tenant_disabled code", () => {
    expect(new TenantDisabledError().code).toBe("tenant_disabled");
  });
});
