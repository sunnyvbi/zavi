
import { describe, it, expect, beforeEach, vi } from "vitest";

const serviceClientMock = vi.fn();
vi.mock("@/services/supabase", () => ({
  serviceClient: () => serviceClientMock(),
}));

vi.mock("@/services/memory/loader", () => ({
  assertValidTenantId: vi.fn(),
}));

import {
  loadTenantConfig,
  invalidateTenantConfig,
  _resetTenantConfigCache,
} from "../tenant";

const TENANT = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";

function mkSupabaseFor(slug: string, displayName: string) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              id: TENANT,
              slug,
              display_name: displayName,
              rar_weekly_threshold: 3500,
            },
            error: null,
          }),
        }),
      }),
    }),
  };
}

describe("loadTenantConfig — process cache (P6)", () => {
  beforeEach(() => {
    _resetTenantConfigCache();
    serviceClientMock.mockReset();
  });

  it("second call within TTL is served from cache (no DB hit)", async () => {
    serviceClientMock.mockReturnValue(mkSupabaseFor("upcar", "Upcar"));

    const first = await loadTenantConfig(TENANT);
    const second = await loadTenantConfig(TENANT);

    expect(first.slug).toBe("upcar");
    expect(second).toBe(first);
    expect(serviceClientMock).toHaveBeenCalledTimes(1);
  });

  it("invalidateTenantConfig forces a fresh load", async () => {
    serviceClientMock.mockReturnValueOnce(mkSupabaseFor("upcar", "Upcar"));
    const first = await loadTenantConfig(TENANT);

    serviceClientMock.mockReturnValueOnce(mkSupabaseFor("upcar", "Upcar (Renamed)"));
    invalidateTenantConfig(TENANT);

    const second = await loadTenantConfig(TENANT);
    expect(first.display_name).toBe("Upcar");
    expect(second.display_name).toBe("Upcar (Renamed)");
    expect(serviceClientMock).toHaveBeenCalledTimes(2);
  });

  it("invalidating one tenant doesn't evict another", async () => {
    serviceClientMock
      .mockReturnValueOnce(mkSupabaseFor("upcar", "Upcar"))
      .mockReturnValueOnce({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: TENANT_2,
                  slug: "apna",
                  display_name: "Apna",
                  rar_weekly_threshold: 3500,
                },
                error: null,
              }),
            }),
          }),
        }),
      });
    await loadTenantConfig(TENANT);
    await loadTenantConfig(TENANT_2);
    expect(serviceClientMock).toHaveBeenCalledTimes(2);

    invalidateTenantConfig(TENANT);

    await loadTenantConfig(TENANT_2);
    expect(serviceClientMock).toHaveBeenCalledTimes(2);

    serviceClientMock.mockReturnValueOnce(mkSupabaseFor("upcar", "Upcar"));
    await loadTenantConfig(TENANT);
    expect(serviceClientMock).toHaveBeenCalledTimes(3);
  });

  it("entry expires after TTL", async () => {
    vi.useFakeTimers();
    serviceClientMock.mockReturnValue(mkSupabaseFor("upcar", "Upcar"));

    await loadTenantConfig(TENANT);
    expect(serviceClientMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    await loadTenantConfig(TENANT);
    expect(serviceClientMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31_000);
    await loadTenantConfig(TENANT);
    expect(serviceClientMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
