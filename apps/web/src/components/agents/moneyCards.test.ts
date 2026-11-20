import { describe, it, expect } from "vitest";
import { cutsFirst, firstOfEachMove, moveHeader, moveKeyOf, type MoveCardRow } from "./moneyCards";

const CLS = "meta_ads.set_status_review";
const f = (b: Record<string, unknown>) => ({ founder_chat_order: true, move_group: "g", level: "adset", ...b });
const ON: MoveCardRow = { id: "on", decision_class: CLS, status: "proposed", body: f({ object_id: "9", status: "ACTIVE", verified_name: "Host Recommended Areas (copy)", object_daily_budget: 60, object_status: "PAUSED" }) };
const PA: MoveCardRow = { id: "pa", decision_class: CLS, status: "proposed", body: f({ object_id: "1", status: "PAUSED", verified_name: "Regular Leads - Ad set", object_daily_budget: 100, object_status: "ACTIVE" }) };
const PB: MoveCardRow = { id: "pb", decision_class: CLS, status: "proposed", body: f({ object_id: "2", status: "PAUSED", verified_name: "Regular Leads (copy)", object_daily_budget: 80, object_status: "ACTIVE" }) };

describe("the move header", () => {
  it("waiting: the total, the parts, nothing changed yet", () => {
    expect(moveHeader([ON, PA, PB])).toEqual({ total: "This move: −$120/day (turn on $60, pause $180)", decided: 0, count: 3, status: "Nothing has changed yet.", tone: "plain" });
  });

  it("must-catch: after the switch-on ran alone, spend is up $60 and the 2 pauses are named", () => {
    const h = moveHeader([{ ...ON, status: "acted", body: { ...ON.body, move_group: undefined, run_alone: { move_group_left: "g" } } }, PA, PB]);
    expect(h).toMatchObject({ decided: 1, tone: "up", status: "Right now: spend is up $60/day. Approve the 2 pauses to finish the move." });
  });

  it("all three applied: done, $120 lower", () => {
    expect(moveHeader([ON, PA, PB].map((r) => ({ ...r, status: "acted" })))).toMatchObject({ decided: 3, status: "Done. Daily spend is $120 lower." });
  });

  it("must-not-invent: a card without its amount gives no total", () => {
    const h = moveHeader([{ ...ON, body: f({ object_id: "9", status: "ACTIVE", verified_name: "X" }) }, PA]);
    expect(h.total).toBeNull();
  });

  it("F4: approved or dispatching is not applied; the header says it is being applied, no number", () => {
    expect(moveHeader([{ ...ON, status: "approved" }, PA, PB])).toMatchObject({
      status: "Approved, waiting to be applied. Nothing has changed yet. Approve the 2 pauses to finish the move.",
      tone: "plain",
    });
    expect(moveHeader([{ ...ON, status: "dispatching" }, PA, PB]).status).toMatch(/^Being applied now\. Nothing has changed yet\./);
  });

  it("F5: a leg that ended without applying is named, and the plan is never claimed as done", () => {
    const h = moveHeader([{ ...ON, status: "acted" }, { ...PA, status: "rejected" }, { ...PB, status: "dispatch_failed" }]);
    expect(h.total).toBe("This move: −$120/day (turn on $60, pause $180)");
    expect(h.status).toBe("Right now: spend is up $60/day. 1 change was not applied. Zavi could not confirm whether 1 change went through. Check the ad account.");
    expect(h.status).not.toMatch(/Done|lower/);
    expect(h.decided).toBe(3);
  });

  it("F6: cards in different currencies give no total and no number", () => {
    const inr = { ...PA, body: { ...PA.body, currency: "INR" } };
    const h = moveHeader([{ ...ON, status: "acted" }, inr]);
    expect(h.total).toBeNull();
    expect(h.status).not.toMatch(/\$|₹/);
  });

  it("pauses come first; a ran-alone card stays in its move", () => {
    expect(cutsFirst([ON, PA, PB]).map((r) => r.id)).toEqual(["pa", "pb", "on"]);
    expect(moveKeyOf({ run_alone: { move_group_left: "g" } })).toBe("g");
    expect(moveKeyOf({ move_group: "g" })).toBeNull();
  });
});

describe("move keys for the one move card (plan 2026-10-23)", () => {
  const R = "raise:aaaaaaaa-0000-4000-8000-000000000001";
  it("a raise: group counts with or without the founder mark; a bad one does not", () => {
    expect(moveKeyOf({ move_group: R })).toBe(R);
    expect(moveKeyOf({ move_group: R, founder_chat_order: true })).toBe(R);
    expect(moveKeyOf({ move_group: "raise:nope" })).toBeNull();
    expect(moveKeyOf({ move_group: "run-root" })).toBeNull();
  });
  it("firstOfEachMove keeps the first row of each move and every lone row, in order", () => {
    const rows = [
      { id: "a", body: { move_group: R } },
      { id: "b", body: null },
      { id: "c", body: { move_group: R } },
      { id: "d", body: { founder_chat_order: true, move_group: "run-1" } },
      { id: "e", body: { founder_chat_order: true, move_group: "run-1" } },
    ];
    expect(firstOfEachMove(rows).map((r) => r.id)).toEqual(["a", "b", "d"]);
  });
});
