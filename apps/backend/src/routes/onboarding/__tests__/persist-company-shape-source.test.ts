import { describe, it, expect, vi, beforeEach } from "vitest";

const writes = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(),
  serviceClient: () => ({
    from: () => ({
      update: (v: Record<string, unknown>) => ({
        eq: async () => {
          writes.push(v);
          return { error: null };
        },
      }),
    }),
  }),
}));

import { persistCompanyShapeFrom } from "../activate";

describe("persistCompanyShapeFrom records the shape's source", () => {
  beforeEach(() => {
    writes.length = 0;
  });

  it("an operator answer is the founder's; a confident guess is inferred", async () => {
    await persistCompanyShapeFrom("t1", [{ kind: "operator", shape: "marketplace" }]);
    await persistCompanyShapeFrom("t2", [{ kind: "inferred", shape: "saas", confidence: "high" }]);
    expect(writes).toEqual([
      { company_shape: "marketplace", company_shape_source: "founder" },
      { company_shape: "saas", company_shape_source: "inferred" },
    ]);
  });

  it("a guessed marketplace is kept as inferred, never as the founder's", async () => {
    await persistCompanyShapeFrom("t3", [{ kind: "inferred", shape: "marketplace", confidence: "high" }]);
    expect(writes).toEqual([{ company_shape: "marketplace", company_shape_source: "inferred" }]);
  });
});
