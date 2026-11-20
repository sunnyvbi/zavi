import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  row: {
    id: "order-1",
    tenant_id: "tenant-1",
    status: "checkout_pending",
    source: "booking",
    offer_id: null,
    agent_run_id: "run-1",
    stripe_checkout_session_id: "cs_secret",
  } as Record<string, unknown>,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => {
    let cols: string[] = [];
    const q = {
      from: () => q,
      select: (c: string) => {
        cols = c.split(",").map((s) => s.trim());
        return q;
      },
      eq: () => q,
      maybeSingle: async () => ({ data: Object.fromEntries(Object.entries(db.row).filter(([k]) => cols.includes(k))), error: null }),
    };
    return q;
  },
}));

import { loadCreatorJob } from "../booking-db";

describe("loadCreatorJob reads whether the agent proposed the order", () => {
  it("carries agent_run_id, so the drawer can tell an agent hire from a payable order", async () => {
    const row = await loadCreatorJob("tenant-1", "order-1");
    expect(row?.agent_run_id).toBe("run-1");
    expect(row).not.toHaveProperty("stripe_checkout_session_id");
  });
});
