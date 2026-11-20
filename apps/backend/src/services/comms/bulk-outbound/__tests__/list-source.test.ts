import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), version: null as null | Record<string, unknown>, filters: [] as Array<[string, string]> }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.rpc(...a),
  tenantClient: () => ({
    from: () => {
      const b = {
        select: () => b,
        eq: (col: string, val: string) => {
          mocks.filters.push([col, val]);
          return b;
        },
        maybeSingle: async () => ({ data: mocks.version, error: null }),
      };
      return b;
    },
  }),
}));

import { resolveCohort } from "../cohort";
import { makeListCohortSource } from "../list-source";

describe("makeListCohortSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.filters = [];
    mocks.rpc.mockResolvedValue({ data: ["a@x.com", "b@x.com"], error: null });
  });

  it("reads the given version of the given list under the caller's tenant", async () => {
    mocks.version = { id: "V1", consent_confirmed_at: "2026-10-07T00:00:00Z" };
    const cohort = await resolveCohort("tenant-a", { segment: "x" }, "opt_in", makeListCohortSource({ listId: "L1", versionId: "V1" }));
    expect(cohort.recipients).toEqual(["a@x.com", "b@x.com"]);
    expect(mocks.filters).toEqual([["id", "V1"], ["list_id", "L1"]]);
    expect(mocks.rpc).toHaveBeenCalledWith("tenant-a", "email_list_version_emails", { p_list_id: "L1", p_version_id: "V1", p_limit: 1001 });
  });

  it("a version with no consent yields nobody", async () => {
    mocks.version = { id: "V1", consent_confirmed_at: null };
    const cohort = await resolveCohort("tenant-a", { segment: "x" }, "opt_in", makeListCohortSource({ listId: "L1", versionId: "V1" }));
    expect(cohort.recipients).toEqual([]);
  });

  it("a version that is not on that list (or not this tenant's) yields nobody and reads no addresses", async () => {
    mocks.version = null;
    const cohort = await resolveCohort("tenant-b", { segment: "x" }, "opt_in", makeListCohortSource({ listId: "L1", versionId: "V1" }));
    expect(cohort.recipients).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
