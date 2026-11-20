import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getTenantSandboxKeepalive,
  invalidateTenantKeepaliveCache,
  _invalidateAllKeepaliveCache,
} from "@/services/sandbox/keepalive-flag";

let dbReturn:
  | { data: { sandbox_keepalive_enabled: boolean | null } | null; error: null }
  | { data: null; error: { message: string } };

const fromMock = vi.fn(() => ({
  select: () => ({
    eq: () => ({
      maybeSingle: async () => dbReturn,
    }),
  }),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: fromMock }),
}));

const t1 = "00000000-0000-0000-0000-000000000001";
const t2 = "00000000-0000-0000-0000-000000000002";

beforeEach(() => {
  fromMock.mockClear();
  _invalidateAllKeepaliveCache();
});

describe("getTenantSandboxKeepalive — helper", () => {
  it("flag=true → returns true", async () => {
    dbReturn = { data: { sandbox_keepalive_enabled: true }, error: null };
    expect(await getTenantSandboxKeepalive(t1)).toBe(true);
  });

  it("flag=false → returns false (regression guard for today's path)", async () => {
    dbReturn = { data: { sandbox_keepalive_enabled: false }, error: null };
    expect(await getTenantSandboxKeepalive(t1)).toBe(false);
  });

  it("missing row → returns false (fail-closed-to-pause)", async () => {
    dbReturn = { data: null, error: null };
    expect(await getTenantSandboxKeepalive(t1)).toBe(false);
  });

  it("null column → returns false (strict-bool check)", async () => {
    dbReturn = {
      data: { sandbox_keepalive_enabled: null },
      error: null,
    };
    expect(await getTenantSandboxKeepalive(t1)).toBe(false);
  });

  it("postgres error → returns false (fail-closed) + one console.warn", async () => {
    dbReturn = { data: null, error: { message: "connection refused" } };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getTenantSandboxKeepalive(t1)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/flag lookup failed.*connection refused/),
    );
    warnSpy.mockRestore();
  });

  it("cache hit + per-tenant isolation + invalidation", async () => {
    dbReturn = { data: { sandbox_keepalive_enabled: true }, error: null };
    expect(await getTenantSandboxKeepalive(t1)).toBe(true);
    expect(await getTenantSandboxKeepalive(t1)).toBe(true);
    expect(fromMock).toHaveBeenCalledTimes(1);

    dbReturn = { data: { sandbox_keepalive_enabled: false }, error: null };
    expect(await getTenantSandboxKeepalive(t2)).toBe(false);
    expect(fromMock).toHaveBeenCalledTimes(2);

    invalidateTenantKeepaliveCache(t1);
    dbReturn = { data: { sandbox_keepalive_enabled: false }, error: null };
    expect(await getTenantSandboxKeepalive(t1)).toBe(false);
    expect(fromMock).toHaveBeenCalledTimes(3);

    expect(await getTenantSandboxKeepalive(t2)).toBe(false);
    expect(fromMock).toHaveBeenCalledTimes(3);
  });
});
