import { describe, it, expect, vi } from "vitest";
import { cardAroundCgoDoor, takesCgoDoor, type CardAroundDoorInput } from "../chat-card-door";

const input = (over: Partial<CardAroundDoorInput> = {}): CardAroundDoorInput => ({
  tenant_id: "t1",
  run_id: "ad315e2d",
  trigger: "chat",
  has_thread: true,
  decision_id: "8af34774",
  decision_class: "google_ads.update_campaign_budget_review",
  body: { campaign_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 },
  agent_slug: "cgo",
  ...over,
});
const shown = { shown: true as const, already: false, card_id: "8af34774", table: "decisions" as const, what: "x" };

describe("cardAroundCgoDoor", () => {
  it("must-catch (the incident): a chat's Google cut the gate holds is shown in that chat, and the door is told it is there", async () => {
    const attach = vi.fn(async () => shown);
    const cgoApprove = vi.fn(async (_t: string, _id: string, _c: string, _b: unknown, _a?: string, opts?: { shownInChat?: () => Promise<boolean> }) => {
      expect(await opts!.shownInChat!()).toBe(true);
      return false;
    });
    const r = await cardAroundCgoDoor(input(), { cgoApprove, attach, handOff: vi.fn() });
    expect(r).toEqual({ cgoApproved: false, cardInChat: true });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith({ tenant_id: "t1", run_id: "ad315e2d", card_id: "8af34774", table: "decisions" });
  });

  it("a waiting card the door never asked about (Autopilot off, a founder order) is still shown after the door", async () => {
    const attach = vi.fn(async () => shown);
    const r = await cardAroundCgoDoor(input(), { cgoApprove: vi.fn(async () => false), attach, handOff: vi.fn() });
    expect(r.cardInChat).toBe(true);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("must-not-touch: an Autopilot-approved change, a scheduled review, a non-ad class and a turn with no thread get no attach", async () => {
    const attach = vi.fn(async () => shown);
    const handOff = vi.fn();
    expect(await cardAroundCgoDoor(input(), { cgoApprove: vi.fn(async () => true), attach, handOff })).toEqual({ cgoApproved: true, cardInChat: false });
    const review = vi.fn(async (..._a: unknown[]) => false);
    await cardAroundCgoDoor(input({ trigger: "a2a" }), { cgoApprove: review, attach, handOff });
    expect(review.mock.calls[0][5]).toEqual({});
    await cardAroundCgoDoor(input({ decision_class: "linkedin_ads.launch_campaign" }), { cgoApprove: vi.fn(async () => false), attach, handOff });
    await cardAroundCgoDoor(input({ has_thread: false }), { cgoApprove: vi.fn(async () => false), attach, handOff });
    expect(attach).not.toHaveBeenCalled();
  });

  it("a failed attach never fails the emit and never notifies twice: queued (or told now) covers it, so the door does not ask", async () => {
    const attach = vi.fn(async () => {
      throw new Error("db down");
    });
    for (const outcome of ["queued", "told"] as const) {
      const handOff = vi.fn(async () => outcome);
      let asked = false;
      const cgoApprove = vi.fn(async (_t: string, _id: string, _c: string, _b: unknown, _a?: string, opts?: { shownInChat?: () => Promise<boolean> }) => {
        asked = !(await opts!.shownInChat!());
        return false;
      });
      const r = await cardAroundCgoDoor(input(), { cgoApprove, attach, handOff });
      expect(asked).toBe(false);
      expect(r.cardInChat).toBe(false);
      expect(handOff).toHaveBeenCalledTimes(1);
    }
  });

  it("the runner's own failed inline write already handed off (queued or told): the door neither attaches nor asks", async () => {
    for (const prior of ["queued", "told"] as const) {
      const attach = vi.fn(async () => shown);
      let asked = false;
      const cgoApprove = vi.fn(async (_t: string, _id: string, _c: string, _b: unknown, _a?: string, opts?: { shownInChat?: () => Promise<boolean> }) => {
        asked = !(await opts!.shownInChat!());
        return false;
      });
      await cardAroundCgoDoor(input({ prior_handoff: prior }), { cgoApprove, attach, handOff: vi.fn() });
      expect(asked).toBe(false);
      expect(attach).not.toHaveBeenCalled();
    }
  });

  it("must-not-touch: when the hand-off reached nobody, the door asks exactly as before", async () => {
    const attach = vi.fn(async () => {
      throw new Error("db down");
    });
    let asked = false;
    const cgoApprove = vi.fn(async (_t: string, _id: string, _c: string, _b: unknown, _a?: string, opts?: { shownInChat?: () => Promise<boolean> }) => {
      asked = !(await opts!.shownInChat!());
      return false;
    });
    await cardAroundCgoDoor(input(), { cgoApprove, attach, handOff: vi.fn(async () => "not_told" as const) });
    expect(asked).toBe(true);
  });

  it("takesCgoDoor: Meta, Google and a cgo LinkedIn launch", () => {
    expect(takesCgoDoor("meta_ads.update_ad_set_budget_review")).toBe(true);
    expect(takesCgoDoor("linkedin_ads.launch_campaign")).toBe(true);
    expect(takesCgoDoor("engineer.ship-pr")).toBe(false);
  });
});

describe("cardAroundCgoDoor with a card emit_decision kept or adopted (bug #3)", () => {
  it("must-catch: a reused card never enters the cgo door (no approval without a tap), and is still shown in the chat", async () => {
    const attach = vi.fn(async () => shown);
    const cgoApprove = vi.fn(async () => true);
    expect(await cardAroundCgoDoor(input({ reused: true }), { cgoApprove, attach, handOff: vi.fn() })).toEqual({ cgoApproved: false, cardInChat: true });
    expect(cgoApprove).not.toHaveBeenCalled();
  });

  it("must-not-touch: a card this run filed still goes through the door", async () => {
    const cgoApprove = vi.fn(async () => true);
    expect((await cardAroundCgoDoor(input({ reused: false }), { cgoApprove, attach: vi.fn(async () => shown), handOff: vi.fn() })).cgoApproved).toBe(true);
    expect(cgoApprove).toHaveBeenCalledTimes(1);
  });
});
