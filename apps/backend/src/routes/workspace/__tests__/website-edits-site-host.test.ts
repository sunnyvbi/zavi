
import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  sites: [] as Array<Record<string, unknown>>,
  sitesError: null as Error | null,
  sitesTenants: [] as string[],
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u1", access_token: "tok" })),
}));
vi.mock("@/services/tenant-client", () => {
  const empty = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "is"]) q[m] = () => q;
    q.then = (r: (v: unknown) => unknown) => r({ data: [], error: null });
    return q;
  };
  return {
    tenantClient: () => ({ from: () => empty() }),
    publicHostClient: () => ({ from: () => empty() }),
    tenantRpc: vi.fn(),
  };
});
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    listForTenant: async (tid: string) => {
      state.sitesTenants.push(tid);
      if (state.sitesError) throw state.sitesError;
      return state.sites.filter((s) => s.tenant_id === tid);
    },
  }),
}));

import { getWebsiteEditsHandler } from "../website-edits";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}
async function edits(app: string) {
  const res = mockRes();
  await getWebsiteEditsHandler({ query: { app } } as never, res as never);
  return res as { statusCode: number; body: { error?: { code: string } } };
}

beforeEach(() => {
  state.sites = [
    { id: "a", tenant_id: T, hostname: "lucky-paws.zavi.site", live_url: "https://lucky-paws.zavi.site" },
    { id: "b", tenant_id: T, hostname: "mile-high.zavi.site", live_url: null },
    { id: "c", tenant_id: OTHER_T, hostname: "someone-else.zavi.site", live_url: null },
  ];
  state.sitesError = null;
  state.sitesTenants = [];
});

describe("inline overlay edits on a site host", () => {
  it("each of the tenant's two sites is refused with 409 not_available_for_site", async () => {
    for (const host of ["lucky-paws.zavi.site", "mile-high.zavi.site"]) {
      const r = await edits(host);
      expect(r.statusCode).toBe(409);
      expect(r.body.error?.code).toBe("not_available_for_site");
    }
    expect(state.sitesTenants.every((t) => t === T)).toBe(true);
  });

  it("another tenant's site host stays a 403", async () => {
    const r = await edits("someone-else.zavi.site");
    expect(r.statusCode).toBe(403);
    expect(r.body.error?.code).toBe("not_your_app");
  });

  it("a sites read error fails closed (403)", async () => {
    state.sitesError = new Error("down");
    expect((await edits("lucky-paws.zavi.site")).statusCode).toBe(403);
  });
});
