import { describe, expect, it, vi, beforeEach } from "vitest";

type Q = { table: string; eqs: Array<[string, unknown]> };
const state = vi.hoisted(() => ({ queries: [] as Q[], decision: null as Record<string, unknown> | null, events: [] as unknown[], eventError: null as unknown }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const q: Q = { table, eqs: [] };
      state.queries.push(q);
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = (k: string, v: unknown) => (q.eqs.push([k, v]), c);
      c.maybeSingle = async () => ({ data: table === "decisions" ? state.decision : null, error: null });
      c.limit = async () => ({ data: state.events, error: state.eventError });
      return c;
    },
  }),
}));

import { readCardDefault } from "../ad-card-receipt";

const ID = "00000000-0000-4000-8000-0000000000f1";
beforeEach(() => {
  state.queries = [];
  state.events = [];
  state.eventError = null;
  state.decision = { status: "proposed", decision_class: "google_ads.update_campaign_budget_review", autonomy_at_emit: "approval", origin: "user_initiated_chat", cgo_hold: null };
});

describe("readCardDefault", () => {
  it("claims a chat card only when the thread_event exists, read in the same tenant", async () => {
    expect(await readCardDefault("t1", ID)).toMatchObject({ founder_order: true, chat_card: false, phase: "waiting" });
    state.events = [{ id: "te-1" }];
    expect(await readCardDefault("t1", ID)).toMatchObject({ chat_card: true });
    const te = state.queries.find((q) => q.table === "thread_event")!;
    expect(te.eqs).toEqual(expect.arrayContaining([["tenant_id", "t1"], ["kind", "decision"], ["body->>decision_id", ID]]));
  });

  it("a held row is held, with its plain words", async () => {
    state.decision = { ...state.decision, origin: null, cgo_hold: { words: ["a", "b", "c"], reasons: ["x"] } };
    expect(await readCardDefault("t1", ID)).toMatchObject({ phase: "held", hold_words: ["a", "b"], founder_order: false });
  });

  it("a thread_event read error throws (the receipt then leaves the tool result as is)", async () => {
    state.eventError = { message: "down" };
    await expect(readCardDefault("t1", ID)).rejects.toThrow("down");
  });
});
