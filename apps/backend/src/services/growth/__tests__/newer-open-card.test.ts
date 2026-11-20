import { describe, it, expect, vi, beforeEach } from "vitest";

type Card = { id: string; run_id: string | null; channel_slug: string; title: string; exec_class: string | null; exec_payload: unknown; exec_status: string | null; exec_result: unknown; body: unknown };
let cards: Card[] = [];
let created: Record<string, string> = {};
let object: { ids: string[]; name: string | null; nameUnknown?: boolean } = { ids: [], name: null };

vi.mock("../open-advice", async (orig) => {
  const real = (await orig()) as typeof import("../open-advice");
  return { ...real, adObjectFor: async () => object, readOpenCards: async () => cards };
});
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: () => ({
    from: () => {
      let ids: string[] = [];
      const q = {
        select: () => q,
        eq: () => q,
        in: (_k: string, v: string[]) => ((ids = v), q),
        limit: async () => ({ data: ids.filter((id) => created[id]).map((id) => ({ id, created_at: created[id] })), error: null }),
      };
      return q;
    },
  }),
}));

import { newerOpenCardFor } from "../goal-owner";

const T = "11111111-1111-4111-8111-111111111111";
const payload = { campaign_id: "24109304360", name: "Upcar Sales Search Campaign", daily_budget_usd: 120 };
const row = { id: "509e69c0", decision_class: "google_ads.update_campaign_budget_review", body: payload, emitted_at: "2026-10-16T09:03:40Z", agent_run_id: "run-old" };
const card = (over: Partial<Card>): Card => ({ id: "c1", run_id: "run-new", channel_slug: "google_ads", title: "Let the campaign that books spend the extra $10 a day", exec_class: null, exec_payload: null, exec_status: null, exec_result: null, body: null, ...over });

beforeEach(() => {
  cards = [];
  created = {};
  object = { ids: ["24109304360"], name: "Upcar Sales Search Campaign" };
});

describe("newerOpenCardFor", () => {
  it("an exact copy of the change, filed later, retires the old proposal", async () => {
    cards = [card({ exec_class: row.decision_class, exec_payload: payload })];
    created = { c1: "2026-10-17T06:00:00Z" };
    expect(await newerOpenCardFor(T, row as never)).toBe(true);
  });

  it("a card filed before the proposal does not", async () => {
    cards = [card({ exec_class: row.decision_class, exec_payload: payload })];
    created = { c1: "2026-10-15T06:00:00Z" };
    expect(await newerOpenCardFor(T, row as never)).toBe(false);
  });

  it("an object whose name could not be read never retires anything, whatever prose cards are open", async () => {
    object = { ids: ["24109304360"], name: null, nameUnknown: true };
    cards = [card({ title: "Raise the budget on campaign B" })];
    created = { c1: "2026-10-17T06:00:00Z" };
    expect(await newerOpenCardFor(T, row as never)).toBe(false);
  });
});
