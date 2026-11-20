import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rpc: vi.fn(async (_tid: string, _name: string, _args: Record<string, unknown>) => ({ data: [{ token: "tok", held_kind: null }], error: null })),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (tid: string, name: string, args: Record<string, unknown>) => h.rpc(tid, name, args),
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => ({ get: async () => null }) }));

import { directChangeDepsFor, realSiteDirectEditDeps } from "../site-direct-edits";
import { SITE_DIRECT_CHANGE_LEASE_TTL_S, SITE_LEASE_TTL_S } from "@/services/sites/site-preview-lease";
import { IDEMPOTENT_ROUTES } from "@/services/http/idempotent-routes";

const T = "11111111-1111-4111-8111-111111111111";
const S = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  h.rpc.mockClear();
});

async function ttlFor(kind: string): Promise<unknown> {
  await directChangeDepsFor(realSiteDirectEditDeps(), kind).claimLease(T, S);
  const claims = h.rpc.mock.calls.filter((c) => c[1] === "claim_site_preview_lease");
  expect(claims).toHaveLength(1);
  return claims[0]![2].p_ttl_seconds;
}

describe("real direct-change lease TTLs", () => {
  it("a crashed theme, section or pasted-photo change locks the site for the short edit TTL only", async () => {
    expect(SITE_LEASE_TTL_S.edit).toBeLessThan(SITE_DIRECT_CHANGE_LEASE_TTL_S);
    for (const kind of ["theme", "section", "image_url"]) {
      h.rpc.mockClear();
      expect(await ttlFor(kind)).toBe(SITE_LEASE_TTL_S.edit);
    }
  });

  it("paid photo generation, photo edits and logo generation hold the long lease", async () => {
    for (const kind of ["image_generate", "image_edit", "logo"]) {
      h.rpc.mockClear();
      expect(await ttlFor(kind)).toBe(SITE_DIRECT_CHANGE_LEASE_TTL_S);
    }
  });

  it("a retried request stays deduped for as long as the long lease can hold the site", () => {
    const route = IDEMPOTENT_ROUTES.find((r) => r.path === "/api/website/site-design-edit" && r.method === "post");
    expect(route).toBeDefined();
    expect(route!.staleMs).toBeGreaterThanOrEqual(SITE_DIRECT_CHANGE_LEASE_TTL_S * 1000);
  });
});
