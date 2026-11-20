
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));

const hold = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
const metaUpdate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/services/growth/move-group", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/move-group")>()),
  pairedDispatchHold: hold,
}));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: metaUpdate }));
const flag = vi.hoisted(() => ({ on: false }));
vi.mock("@/services/decisions/ad-budget-choice-flag", () => ({ adBudgetChoiceEnabled: async () => flag.on }));
const advance = vi.hoisted(() => vi.fn(async () => undefined));
const raiseFailed = vi.hoisted(() => vi.fn(async () => undefined));
const moveCheck = vi.hoisted(() => vi.fn(async (): Promise<unknown> => "go"));
vi.mock("@/services/growth/move-card", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/move-card")>()),
  checkMoveAfter: moveCheck,
  advanceMove: advance,
  tellRaiseFailed: raiseFailed,
}));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(async () => { throw new Error("no platform read in this test"); }), getAdAccountCurrency: vi.fn(async () => "USD") }));

import { __testOnly_handlers as HANDLERS, __testOnly_settleMoveLeg as settleMoveLeg } from "../dispatch-decision";

const body = {
  ad_set_id: "111",
  daily_budget_usd: 50,
  expected_current_daily_budget_usd: 40,
  rationale: "founder order",
  origin: "user_initiated_chat",
  founder_chat_order: true,
  move_group: "run-root",
};
const row = { id: "d-raise", tenant_id: "t-1", agent_run_id: "run-root", decision_class: "meta_ads.update_ad_set_budget_review", status: "dispatching", handler: null, body, approved_by: "owner-1", approved_by_source: null };

beforeEach(() => {
  flag.on = false;
  hold.mockReset();
  moveCheck.mockReset().mockResolvedValue("go");
  metaUpdate.mockReset();
});

describe("the paired-move backstop in the shared handler wrapper", () => {
  it("must-catch: a waiting raise goes back to the founder, nothing sent to the platform", async () => {
    hold.mockResolvedValue("This raise is part of a move you asked for. Approve the matching cut first; this raise runs only after the cut is done.");
    const r = await HANDLERS["meta_ads.update_ad_set_budget_review"]({ ...row });
    expect(r).toMatchObject({ ok: false, held_for_founder: true, code: "paired_move_waits" });
    expect(hold).toHaveBeenCalledWith("t-1", { id: "d-raise", exec_class: "meta_ads.update_ad_set_budget_review", body });
    expect(metaUpdate).not.toHaveBeenCalled();
  });

  it("must-not-touch: a leg cleared to go reaches the handler", async () => {
    hold.mockResolvedValue(null);
    await HANDLERS["meta_ads.update_ad_set_budget_review"]({ ...row }).catch(() => undefined);
    expect(hold).toHaveBeenCalledTimes(1);
  });
});

describe("switch ON (plan 2026-10-23)", () => {
  const CUT = "11111111-1111-4111-8111-111111111111";
  it("must-catch R3: a paired raise WITHOUT move_after is still held for the founder", async () => {
    flag.on = true;
    hold.mockResolvedValue("Approve the matching cut first.");
    const r = await HANDLERS["meta_ads.update_ad_set_budget_review"]({ ...row });
    expect(r).toMatchObject({ ok: false, held_for_founder: true, code: "paired_move_waits" });
    expect(metaUpdate).not.toHaveBeenCalled();
  });
  const stamped = { ...body, move_after: { cut_ids: [CUT], by: "owner-1", at: "2026-10-23T10:00:00Z", budget_to_usd: null, daily_limit_to_usd: null } };
  it("(c) a person-approved stamped raise whose cuts all applied and hold: the move card's live check says go, the handler runs", async () => {
    flag.on = true;
    hold.mockResolvedValue("Approve the matching cut first.");
    const r = await HANDLERS["meta_ads.update_ad_set_budget_review"]({ ...row, body: stamped }).catch(() => null);
    expect(moveCheck).toHaveBeenCalledWith("t-1", stamped);
    expect(hold).not.toHaveBeenCalled();
    expect(r).not.toMatchObject({ code: "paired_move_waits" });
  });
  it("(a) must-catch: a cut put back live after the approval (checkMoveAfter stops) holds the raise for the founder, nothing sent", async () => {
    flag.on = true;
    moveCheck.mockResolvedValue({ stop: [CUT] });
    const r = await HANDLERS["meta_ads.update_ad_set_budget_review"]({ ...row, body: stamped });
    expect(r).toMatchObject({ ok: false, held_for_founder: true, code: "paired_move_waits" });
    expect(metaUpdate).not.toHaveBeenCalled();
    moveCheck.mockResolvedValue("wait");
    expect(await HANDLERS["meta_ads.update_ad_set_budget_review"]({ ...row, body: stamped })).toMatchObject({ held_for_founder: true });
  });
  it("(b) must-catch: a stamped raise not approved by a person's own tap (staff, email) is treated as unstamped: pairedDispatchHold runs", async () => {
    flag.on = true;
    hold.mockResolvedValue("Approve the matching cut first.");
    for (const src of ["staff", "email"]) {
      hold.mockClear();
      const r = await HANDLERS["meta_ads.update_ad_set_budget_review"]({ ...row, body: stamped, approved_by_source: src });
      expect(hold).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ code: "paired_move_waits", held_for_founder: true });
    }
    expect(moveCheck).not.toHaveBeenCalled();
    const r = await HANDLERS["meta_ads.update_ad_set_budget_review"]({ ...row, body: stamped, approved_by_source: "cgo" });
    expect(r).toMatchObject({ ok: false });
    expect(moveCheck).not.toHaveBeenCalled();
  });
  it("switch OFF: a stamp changes nothing, the hold runs", async () => {
    hold.mockResolvedValue("Approve the matching cut first.");
    expect(await HANDLERS["meta_ads.update_ad_set_budget_review"]({ ...row, body: stamped })).toMatchObject({ code: "paired_move_waits" });
  });
});

describe("a settled leg of a move (Task 2.8)", () => {
  const CUT = "11111111-1111-4111-8111-111111111111";
  const cut = { decision_class: "google_ads.update_campaign_budget_review", tenant_id: "t-1", body: { campaign_id: "c2", daily_budget_usd: 10, expected_current_daily_budget_usd: 40 } };
  const stampedRaise = { decision_class: "meta_ads.update_ad_set_budget_review", tenant_id: "t-1", body: { ...body, move_after: { cut_ids: [CUT], by: "owner-1", at: "t", budget_to_usd: null, daily_limit_to_usd: null } } };
  beforeEach(() => {
    advance.mockClear();
    raiseFailed.mockClear();
  });
  it("a cut that acts (or ends) advances its move once", async () => {
    await settleMoveLeg(cut, CUT, "acted");
    expect(advance).toHaveBeenCalledWith("t-1", CUT);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(raiseFailed).not.toHaveBeenCalled();
  });
  it("must-catch F4: a failed raise of a move tells the founder, uncertain unless it never reached the platform; a raise that acts calls neither", async () => {
    await settleMoveLeg(stampedRaise, "d-raise", "uncertain");
    expect(raiseFailed).toHaveBeenLastCalledWith("t-1", expect.objectContaining({ id: "d-raise" }), "unknown");
    await settleMoveLeg(stampedRaise, "d-raise", "not_sent");
    expect(raiseFailed).toHaveBeenLastCalledWith("t-1", expect.objectContaining({ id: "d-raise" }), "never");
    raiseFailed.mockClear();
    await settleMoveLeg(stampedRaise, "d-raise", "acted");
    expect(raiseFailed).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });
  it("other classes are left alone", async () => {
    await settleMoveLeg({ decision_class: "pm.ticket", tenant_id: "t-1", body: {} }, "x", "acted");
    expect(advance).not.toHaveBeenCalled();
  });
});
