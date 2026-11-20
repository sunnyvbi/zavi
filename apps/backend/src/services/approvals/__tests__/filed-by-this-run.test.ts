import { describe, expect, it, vi } from "vitest";

let single: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let list: { data: unknown; error: { message: string } | null } = { data: [], error: null };
const seen: Array<[string, unknown]> = [];
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        seen.push([c, v]);
        return q;
      },
      limit: async () => list,
      maybeSingle: async () => single,
    };
    return { from: () => q };
  },
}));

import { decisionsFiledByRun, filedByThisRun } from "../chat-card-door";

describe("decisionsFiledByRun + filedByThisRun", () => {
  it("a row that was not this run's a moment before, is this run's, and was never held is new", async () => {
    single = { data: { agent_run_id: "run-1", cgo_hold: null }, error: null };
    expect(await filedByThisRun("t1", "d-new", "run-1", new Set(["d-old"]))).toBe(true);
    expect(seen).toEqual(expect.arrayContaining([["id", "d-new"], ["tenant_id", "t1"]]));
  });

  it("must-catch (replay): this run's own row from before the emit is not new, whoever filed it", async () => {
    list = { data: [{ id: "d-1" }], error: null };
    const before = await decisionsFiledByRun("t1", "run-1");
    single = { data: { agent_run_id: "run-1", cgo_hold: null }, error: null };
    expect(await filedByThisRun("t1", "d-1", "run-1", before)).toBe(false);
  });

  it("must-catch: another run's kept card, a held card, an unreadable snapshot or row is not new", async () => {
    single = { data: { agent_run_id: "run-old", cgo_hold: null }, error: null };
    expect(await filedByThisRun("t1", "d1", "run-1", new Set())).toBe(false);
    single = { data: { agent_run_id: "run-1", cgo_hold: { reasons: ["x"] } }, error: null };
    expect(await filedByThisRun("t1", "d1", "run-1", new Set())).toBe(false);
    expect(await filedByThisRun("t1", "d1", "run-1", null)).toBe(false);
    single = { data: null, error: { message: "down" } };
    expect(await filedByThisRun("t1", "d1", "run-1", new Set())).toBe(false);
    list = { data: null, error: { message: "down" } };
    expect(await decisionsFiledByRun("t1", "run-1")).toBeNull();
  });
});
