import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as unknown[], filters: [] as Array<[string, unknown]> }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => {
    const q = {
      from: () => q,
      select: () => q,
      eq: (col: string, val: unknown) => {
        db.filters.push([col, val]);
        return q;
      },
      order: () => q,
      limit: async () => ({
        data: db.rows.filter((row) =>
          db.filters.every(([col, val]) => !(col in (row as Record<string, unknown>)) || (row as Record<string, unknown>)[col] === val),
        ),
        error: null,
      }),
    };
    return q;
  },
}));

import { openCreatorHelpRequest } from "../orders-db";

beforeEach(() => {
  db.rows = [];
  db.filters = [];
});

describe("the creator's own open help request", () => {
  it("returns what the creator asked, for this order's open request only", async () => {
    db.rows = [{ reason: "What is the market price?", created_at: "2026-10-22T05:33:21Z", opened_by: "creator" }];
    expect(await openCreatorHelpRequest("t1", "o1")).toEqual({ reason: "What is the market price?", opened_at: "2026-10-22T05:33:21Z" });
    expect(db.filters).toEqual([
      ["order_id", "o1"],
      ["status", "open"],
      ["kind", "step_in"],
    ]);
  });

  it("never hands the business's own words to the creator", async () => {
    db.rows = [{ reason: "The creator went silent.", created_at: "2026-10-22T05:33:21Z", opened_by: "tenant" }];
    expect(await openCreatorHelpRequest("t1", "o1")).toBeNull();
  });

  it("does not show the creator's cancellation dispute as a request for help", async () => {
    db.rows = [
      { reason: "I already filmed half of it.", created_at: "2026-10-22T06:00:00Z", opened_by: "creator", kind: "cancel_dispute" },
    ];
    expect(await openCreatorHelpRequest("t1", "o1")).toBeNull();
  });

  it("is null when nothing is open", async () => {
    expect(await openCreatorHelpRequest("t1", "o1")).toBeNull();
  });
});
