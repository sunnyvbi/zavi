import { describe, it, expect, vi } from "vitest";

const rows: Record<string, Array<Record<string, unknown>>> = {
  human_members: [{ id: "m1", auth_user_id: "u1" }],
  tenant_users: [
    { user_id: "u1", tenant_id: "t_own" },
    { user_id: "u1", tenant_id: "t_referred" },
    { user_id: "u2", tenant_id: "t_other" },
  ],
  tenant_subscriptions: [
    { tenant_id: "t_own", stripe_customer_id: "cus_own" },
    { tenant_id: "t_referred", stripe_customer_id: "cus_referred" },
    { tenant_id: "t_other", stripe_customer_id: "cus_other" },
  ],
};
const updates: Array<{ table: string; values: unknown; eq: [string, unknown] }> = [];

function query(table: string) {
  let out = rows[table] ?? [];
  let pendingUpdate: unknown = null;
  const q = {
    select: () => q,
    update: (values: unknown) => ((pendingUpdate = values), q),
    eq: (col: string, v: unknown) => {
      if (pendingUpdate !== null) {
        updates.push({ table, values: pendingUpdate, eq: [col, v] });
        return Promise.resolve({ error: null });
      }
      out = out.filter((r) => r[col] === v);
      return q;
    },
    in: (col: string, vs: unknown[]) => Promise.resolve({ data: out.filter((r) => vs.includes(r[col])), error: null }),
    maybeSingle: () => Promise.resolve({ data: out[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: out, error: null }),
  };
  return q;
}

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: (t: string) => query(t), rpc: vi.fn() }) }));

import { markSelfReferral, ownCustomersOf, tenantForCustomer } from "../store";

describe("affiliate store reads for the billing webhook", () => {
  it("maps a Stripe customer to its tenant (tenant_subscriptions is tenant-scoped, so not through globalClient)", async () => {
    expect(await tenantForCustomer("cus_referred")).toBe("t_referred");
  });

  it("the creator's own customers are their login's workspaces, never the referred one or someone else's", async () => {
    expect(await ownCustomersOf("m1", "t_referred")).toEqual(["cus_own"]);
  });

  it("a creator with no login has no own customers", async () => {
    expect(await ownCustomersOf("m_unknown", "t_referred")).toEqual([]);
  });

  it("marking a self-referral keeps the staff signals already on the referral", async () => {
    await markSelfReferral("t_referred", { card_seen_on_other_referral: true });
    expect(updates.at(-1)).toEqual({
      table: "affiliate_referrals",
      values: { signals: { card_seen_on_other_referral: true, self_referral: "own_card" } },
      eq: ["tenant_id", "t_referred"],
    });
  });
});
