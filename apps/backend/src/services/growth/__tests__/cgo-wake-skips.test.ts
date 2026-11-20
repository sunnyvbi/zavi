import { describe, it, expect, vi, beforeEach } from "vitest";

const inserts: Array<Record<string, unknown>> = [];
let insertError: { message: string } | null = null;
let throwOnFrom = false;
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      if (throwOnFrom) throw new Error("db down");
      return { insert: async (row: Record<string, unknown>) => (inserts.push({ table, ...row }), { error: insertError }) };
    },
  }),
}));

import { recordWakeSkip } from "../cgo-wake-skips";

beforeEach(() => {
  inserts.length = 0;
  insertError = null;
  throwOnFrom = false;
});

describe("recordWakeSkip", () => {
  it("writes one row with the tenant, the wake and why", async () => {
    await recordWakeSkip("t1", "ad_budget_review", "recent_review");
    expect(inserts).toEqual([{ table: "cgo_wake_skips", tenant_id: "t1", wake_reason: "ad_budget_review", why: "recent_review" }]);
  });

  it("a write error or a thrown client never reaches the caller", async () => {
    insertError = { message: "nope" };
    await expect(recordWakeSkip("t1", "daily_check", "nothing_due")).resolves.toBeUndefined();
    throwOnFrom = true;
    await expect(recordWakeSkip("t1", "daily_check", "nothing_due")).resolves.toBeUndefined();
  });
});
