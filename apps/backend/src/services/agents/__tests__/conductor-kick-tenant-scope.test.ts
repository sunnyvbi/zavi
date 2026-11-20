import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, ...unknown[]]>,
  row: { data: { status: "active" }, error: null } as { data: unknown; error: unknown },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      h.calls.push(["from", table]);
      const b: Record<string, unknown> = {
        select: (...a: unknown[]) => (h.calls.push(["select", ...a]), b),
        eq: (...a: unknown[]) => (h.calls.push(["eq", ...a]), b),
        maybeSingle: () => Promise.resolve(h.row),
      };
      return b;
    },
  }),
}));

import { isActiveConductorRun } from "../conductor-kick";

const RUN = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";
const TENANT = "a7ec7367-acc8-4abc-995b-7da60a572de3";

describe("isActiveConductorRun", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.row = { data: { status: "active" }, error: null };
  });

  it("filters conductor_runs by the finishing run's tenant before the id", async () => {
    await expect(isActiveConductorRun(RUN, TENANT)).resolves.toBe(true);
    expect(h.calls[0]).toEqual(["from", "conductor_runs"]);
    expect(h.calls.filter(([n]) => n === "eq")).toEqual([
      ["eq", "tenant_id", TENANT],
      ["eq", "id", RUN],
    ]);
  });

  it("refuses to look anything up with no tenant, even for a valid run id", async () => {
    await expect(isActiveConductorRun(RUN, "")).resolves.toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("is false for a conductor another tenant owns, because the scoped read finds no row", async () => {
    h.row = { data: null, error: null };
    await expect(isActiveConductorRun(RUN, TENANT)).resolves.toBe(false);
  });

  it("is false on a read error rather than kicking blindly", async () => {
    h.row = { data: null, error: { message: "boom" } };
    await expect(isActiveConductorRun(RUN, TENANT)).resolves.toBe(false);
  });
});
