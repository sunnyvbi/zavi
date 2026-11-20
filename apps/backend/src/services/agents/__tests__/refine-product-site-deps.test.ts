
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  wake: vi.fn(async () => ({ status: "waking" })),
  getByRun: vi.fn(async () => null),
  get: vi.fn(async () => null),
  marker: null as Record<string, unknown> | null,
  runReads: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/services/sites/wiring", () => ({ wakeSiteByHostname: h.wake }));
vi.mock("@/services/sites/store", () => ({ siteStore: () => ({ getByRun: h.getByRun, get: h.get }) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table !== "conductor_runs") throw new Error(`unexpected table ${table}`);
      const filters: Record<string, unknown> = {};
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => ((filters[k] = v), b),
        maybeSingle: async () => {
          h.runReads.push({ ...filters });
          return { data: h.marker, error: null };
        },
      };
      return b;
    },
  }),
}));

import { realRefineProductDeps } from "@/services/agents/refine-product";

const SITE = "aaaaaaaa-0000-4000-8000-000000000001";

beforeEach(() => {
  h.getByRun.mockReset();
  h.getByRun.mockResolvedValue(null);
  h.get.mockReset();
  h.get.mockResolvedValue(null);
  h.marker = null;
  h.runReads = [];
});

describe("realRefineProductDeps (new-flow sites)", () => {
  it("wakeSite is wired to Slice 2's wake by hostname", async () => {
    expect(realRefineProductDeps.wakeSite).toBeTypeOf("function");
    await realRefineProductDeps.wakeSite!("alpha.zaviagent.com");
    expect(h.wake).toHaveBeenCalledWith("alpha.zaviagent.com");
  });

  it("loadSiteForRun reads the tenant-scoped site store by run for a site-marked run", async () => {
    h.marker = { s0: SITE, s1: SITE, s2: SITE };
    await realRefineProductDeps.loadSiteForRun!("t1", "run-a");
    expect(h.runReads[0]).toMatchObject({ tenant_id: "t1", id: "run-a" });
    expect(h.getByRun).toHaveBeenCalledWith("t1", "run-a");
  });

  it("a site's refine run (not its root) resolves through its payload pointer, tenant-scoped", async () => {
    h.marker = { s0: SITE, s1: null, s2: null };
    const row = { id: SITE, tenant_id: "t1" };
    h.get.mockResolvedValue(row as never);
    expect(await realRefineProductDeps.loadSiteForRun!("t1", "refine-run")).toBe(row);
    expect(h.getByRun).toHaveBeenCalledWith("t1", "refine-run");
    expect(h.get).toHaveBeenCalledWith("t1", SITE);
  });

  it("an old-flow run never touches the site store, even when the store throws", async () => {
    h.marker = { s0: null, s1: null, s2: null };
    h.getByRun.mockRejectedValue(new Error("sites table unreachable"));
    expect(await realRefineProductDeps.loadSiteForRun!("t1", "run-old")).toBeNull();
    expect(h.getByRun).not.toHaveBeenCalled();
  });

  it("an unknown run (no row) is old-flow and never touches the site store", async () => {
    expect(await realRefineProductDeps.loadSiteForRun!("t1", "run-missing")).toBeNull();
    expect(h.getByRun).not.toHaveBeenCalled();
  });
});
