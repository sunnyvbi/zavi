import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ table: string; eqs: Array<[string, unknown]>; select: string }> = [];
let tenant: string | null = "t-active";

function builder(table: string) {
  const rec = { table, eqs: [] as Array<[string, unknown]>, select: "" };
  calls.push(rec);
  const q: Record<string, unknown> = {};
  q.select = (s: string) => ((rec.select = s), q);
  q.eq = (c: string, v: unknown) => (rec.eqs.push([c, v]), q);
  q.order = () => q;
  q.limit = async () => ({ data: [], error: null });
  q.maybeSingle = async () => ({ data: null, error: null });
  return q;
}

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ from: builder }) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => tenant }));

import { realWatchDeps } from "../socialPostWatch";

describe("realWatchDeps reads are pinned to the active tenant", () => {
  beforeEach(() => {
    calls.length = 0;
    tenant = "t-active";
  });

  it("filters social_posts, decisions and social_publish_attempts by the active tenant", async () => {
    await realWatchDeps.readPost("d1");
    await realWatchDeps.readDecision("d1");
    await realWatchDeps.readReason("p1");
    expect(calls.map((c) => c.table)).toEqual(["social_posts", "decisions", "social_publish_attempts"]);
    expect(calls[0].eqs).toContainEqual(["tenant_id", "t-active"]);
    expect(calls[1].eqs).toContainEqual(["tenant_id", "t-active"]);
    expect(calls[2].select).toContain("social_posts!inner(tenant_id)");
    expect(calls[2].eqs).toContainEqual(["social_posts.tenant_id", "t-active"]);
  });

  it("reads nothing while the active tenant is unresolved", async () => {
    tenant = null;
    expect(await realWatchDeps.readPost("d1")).toBeNull();
    expect(await realWatchDeps.readDecision("d1")).toBeNull();
    expect(await realWatchDeps.readReason("p1")).toBeNull();
    expect(calls).toEqual([]);
  });
});
