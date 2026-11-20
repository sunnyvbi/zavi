import { describe, expect, it, vi, beforeEach } from "vitest";

const logs = vi.hoisted(() => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/logging/logEvent", () => logs);
const openAdvice = vi.hoisted(() => ({ askFounderOutsideReview: vi.fn(async () => true) }));
vi.mock("../open-advice", async (orig) => ({ ...(await orig<object>()), askFounderOutsideReview: openAdvice.askFounderOutsideReview }));
const tenantWrites = vi.hoisted(() => ({ update: vi.fn(), insert: vi.fn(), rpc: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => tenantWrites.rpc(...a),
  tenantClient: () => ({
    rpc: (...a: unknown[]) => tenantWrites.rpc(...a),
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "gte", "lte", "gt", "lt", "order", "limit", "not", "or", "neq"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: null, error: null });
      q.single = async () => ({ data: null, error: null });
      q.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
      q.update = (...a: unknown[]) => (tenantWrites.update(...a), q);
      q.insert = (...a: unknown[]) => (tenantWrites.insert(...a), q);
      return q;
    },
  }),
}));
const facts = vi.hoisted(() => ({ load: vi.fn(async () => ({})), control: vi.fn(async (..._a: unknown[]) => ({})) }));
vi.mock("../business-control-runtime", () => ({ checkBusinessControl: (...a: unknown[]) => facts.control(...a) }));

import { UNSURE_WHICH_WARNING, adviseFounderOrder } from "../founder-order";
import * as policy from "../unattended-policy";

describe("adviseFounderOrder", () => {
  it("returns the plain words, evaluated as Autopilot's own change, dropping 'this is your call' reasons", async () => {
    const evaluate = vi.fn(async (..._a: unknown[]) => ({ verdict: "ask_founder" as const, reasons: ["founder_staged_change", "objective_metric_mismatch", "results_not_goal", "learning_lock"] }));
    const words = await adviseFounderOrder(
      "t-1",
      "d-1",
      "google_ads.update_campaign_budget_review",
      { campaign_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, origin: "user_initiated_chat", cut_guard_note: "x" },
      evaluate,
    );
    expect(words).toEqual(["it is not set up to get conversions, so zero conversions says nothing", "the conversions it counts are not the ones your goal is about"]);
    const action = evaluate.mock.calls[0][1] as unknown as { exec_class: string; payload: Record<string, unknown>; source: { table: string; id: string } };
    expect(action.exec_class).toBe("google_ads.update_campaign_budget");
    expect(action.payload).toEqual({ campaign_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 });
    expect(action.source).toMatchObject({ table: "decisions", id: "d-1" });
  });

  it("an explicit ambiguous match warns first, and never reaches the gate's payload (bug #13)", async () => {
    const evaluate = vi.fn(async (..._a: unknown[]) => ({ verdict: "allow" as const, reasons: [] }));
    const words = await adviseFounderOrder("t", "d", "meta_ads.update_ad_set_budget_review", { ad_set_id: "9", daily_budget_usd: 50, expected_current_daily_budget_usd: 40, match_unsure: "ambiguous_match", verified_name: "Search A" }, evaluate);
    expect(words).toEqual([UNSURE_WHICH_WARNING]);
    expect((evaluate.mock.calls[0][1] as unknown as { payload: Record<string, unknown> }).payload).toEqual({ ad_set_id: "9", daily_budget_usd: 50, expected_current_daily_budget_usd: 40 });
  });

  it("an allow, or only 'your call' reasons, is no warning", async () => {
    expect(await adviseFounderOrder("t", "d", "meta_ads.set_status_review", {}, async () => ({ verdict: "allow", reasons: [] }))).toEqual([]);
    expect(await adviseFounderOrder("t", "d", "meta_ads.set_status_review", {}, async () => ({ verdict: "deny", reasons: ["delete_never_unattended", "gate_error"] }))).toEqual([]);
  });
});

describe("evaluateUnattendedAdvisory has no side effects", () => {
  beforeEach(() => {
    logs.logEvent.mockClear();
    openAdvice.askFounderOutsideReview.mockClear();
    tenantWrites.update.mockClear();
    tenantWrites.insert.mockClear();
  });

  it("evaluates on the real fact loader (reads only, stubbed DB) without logging a cgo.unattended_* code, asking, or writing", async () => {
    facts.control.mockResolvedValueOnce({ hold: "business_step_exceeded" });
    const v = await policy.evaluateUnattendedAdvisory("t-1", {
      kind: "ad",
      exec_class: "google_ads.update_campaign_budget",
      payload: { campaign_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 },
      source: { table: "decisions", id: "d-1", run_id: null },
    });
    expect(v.verdict).not.toBe("allow");
    for (const c of logs.logEvent.mock.calls as unknown as Array<[{ code?: string }]>) expect(c[0].code ?? "").not.toMatch(/^cgo\.unattended_/);
    expect(openAdvice.askFounderOutsideReview).not.toHaveBeenCalled();
    expect(tenantWrites.update).not.toHaveBeenCalled();
    expect(tenantWrites.insert).not.toHaveBeenCalled();
  });
});
