import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  flag: vi.fn(async (_key: string, _tenant?: string | null) => true),
  get: vi.fn(async (_t: string, _s: string) => null as unknown),
}));

vi.mock("@/services/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/settings")>()),
  getBoolSetting: h.flag,
}));
vi.mock("@/services/sites/site-design-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sites/site-design-store")>()),
  siteDesignStore: () => ({ get: h.get }),
}));

import { realConductorTickDeps } from "../conductor-driver";

const unpicked = { theme_mode: "theme_css", chosen_at: null, sealed_at: null, directions: [{ id: "a" }, { id: "b" }, { id: "c" }] };

beforeEach(() => {
  h.flag.mockReset();
  h.get.mockReset();
});

describe("realConductorTickDeps.siteAwaitsLook", () => {
  it("reads the tenant's site_build_waits_for_look setting, then the site's stored pick", async () => {
    h.flag.mockResolvedValue(true);
    h.get.mockResolvedValue(unpicked);
    expect(await realConductorTickDeps.siteAwaitsLook!({ tenant_id: "t1", site_id: "s1" })).toBe(true);
    expect(h.flag).toHaveBeenCalledWith("site_build_waits_for_look", "t1");
    expect(h.get).toHaveBeenCalledWith("t1", "s1");

    h.get.mockResolvedValue({ ...unpicked, chosen_at: "2026-10-07T00:00:00Z" });
    expect(await realConductorTickDeps.siteAwaitsLook!({ tenant_id: "t1", site_id: "s1" })).toBe(false);

    h.get.mockResolvedValue({ ...unpicked, directions: [] });
    expect(await realConductorTickDeps.siteAwaitsLook!({ tenant_id: "t1", site_id: "s1" })).toBe(false);
  });

  it("flag off: the build is released without a store read", async () => {
    h.flag.mockResolvedValue(false);
    h.get.mockResolvedValue(unpicked);
    expect(await realConductorTickDeps.siteAwaitsLook!({ tenant_id: "t1", site_id: "s1" })).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
  });
});
