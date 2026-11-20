
import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table !== "praxis_logs") throw new Error(`db unavailable in test: ${table}`);
      return {
        insert: async (row: Record<string, unknown>) => {
          inserted.rows.push(row);
          return { error: null };
        },
      };
    },
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    throw new Error("db unavailable in test");
  },
}));

import { authorizeUnattended } from "../unattended-policy";

const T = "55555555-5555-4555-8555-555555555555";

describe("authorizeUnattended logging", () => {
  beforeEach(() => {
    inserted.rows.length = 0;
  });

  it("a held action's reasons land in praxis_logs meta under hold_reasons", async () => {
    const v = await authorizeUnattended(T, { kind: "goal_change", trigger: "review" }, { where: "door" });
    expect(v.verdict).not.toBe("allow");
    const row = inserted.rows.find((r) => typeof r.code === "string" && (r.code as string).startsWith("cgo.unattended_"));
    expect(row).toBeDefined();
    const meta = row!.meta as Record<string, unknown>;
    expect(typeof meta.hold_reasons).toBe("string");
    expect((meta.hold_reasons as string).length).toBeGreaterThan(0);
    expect((meta.hold_reasons as string).split(",")).toEqual(v.reasons.slice(0, 5));
  });
});
