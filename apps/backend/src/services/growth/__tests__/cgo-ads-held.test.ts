
import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "33333333-3333-3333-3333-333333333333";
const row: Record<string, unknown> = {
  channel_slug: "google_ads",
  run_id: "run-1",
  title: "Halve a search campaign that booked nothing in 7 days",
  exec_class: "google_ads.update_campaign_budget",
  exec_payload: { campaign_id: "c1", daily_budget_usd: 25 },
  exec_status: null,
  status: "pending",
  approved_by_source: null,
};

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
    return { from: () => q };
  },
}));
vi.mock("@/services/decisions/ad-budget", () => ({ readActiveAdBudget: async () => ({ id: "b1" }) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: async () => true }));

const authorizeUnattended = vi.fn();
const askFounderAboutHeld = vi.fn().mockResolvedValue(true);
const recordCardHold = vi.fn().mockResolvedValue(true);
vi.mock("../unattended-policy", () => ({
  isExecutableAdClass: () => true,
  authorizeUnattended: (...a: unknown[]) => authorizeUnattended(...a),
  askFounderAboutHeld: (...a: unknown[]) => askFounderAboutHeld(...a),
  recordCardHold: (...a: unknown[]) => recordCardHold(...a),
}));

const approveDecisionAsCgo = vi.fn().mockResolvedValue(true);
vi.mock("../cgo-auto-run", () => ({ approveDecisionAsCgo: (...a: unknown[]) => approveDecisionAsCgo(...a), tenantOwnerId: async () => "owner-1" }));

import { cgoApproveAdDecision, cgoApproveChannelAction } from "../cgo-ads";

describe("cgoApproveChannelAction when the gate holds the card", () => {
  beforeEach(() => {
    askFounderAboutHeld.mockClear();
    recordCardHold.mockClear();
    authorizeUnattended.mockResolvedValue({ verdict: "ask_founder", reasons: ["objective_not_conversions"], evidence: null });
  });

  it("asks nothing on its own when the review listens (the review note carries the card)", async () => {
    let heard: string[] = [];
    const ok = await cgoApproveChannelAction(T, "ca-1", { onHeld: (r) => (heard = r) });
    expect(ok).toBe(false);
    expect(heard).toEqual(["objective_not_conversions"]);
    expect(askFounderAboutHeld).not.toHaveBeenCalled();
    expect(recordCardHold).toHaveBeenCalledTimes(1);
    expect(recordCardHold.mock.calls[0][0]).toBe(T);
    expect(recordCardHold.mock.calls[0][1]).toEqual({ table: "channel_actions", id: "ca-1", run_id: "run-1" });
    expect(recordCardHold.mock.calls[0][2]).toMatchObject({ reasons: ["objective_not_conversions"] });
  });

  it("a review hold the gate denies is written on the card too, and the review's note still tells the founder (bug #8)", async () => {
    authorizeUnattended.mockResolvedValueOnce({ verdict: "deny", reasons: ["delete_never_unattended"] });
    expect(await cgoApproveChannelAction(T, "ca-1", { onHeld: () => undefined })).toBe(false);
    expect(recordCardHold).toHaveBeenCalledWith(T, { table: "channel_actions", id: "ca-1", run_id: "run-1" }, expect.objectContaining({ reasons: ["delete_never_unattended"] }));
    expect(askFounderAboutHeld).not.toHaveBeenCalled();
  });

  it("still asks the founder when nobody listens (a hold outside a review)", async () => {
    const ok = await cgoApproveChannelAction(T, "ca-1");
    expect(ok).toBe(false);
    expect(askFounderAboutHeld).toHaveBeenCalledTimes(1);
    expect(askFounderAboutHeld.mock.calls[0][1]).toMatchObject({ kind: "ad", exec_class: row.exec_class });
  });

  it("leaves a founder-edited card for the founder, before any gate runs", async () => {
    authorizeUnattended.mockClear();
    row.edited_body = { ad_review_edited: true };
    try {
      expect(await cgoApproveChannelAction(T, "ca-1")).toBe(false);
      expect(authorizeUnattended).not.toHaveBeenCalled();
      expect(askFounderAboutHeld).not.toHaveBeenCalled();
    } finally {
      delete row.edited_body;
    }
  });
});

describe("D4: Autopilot never approves a card that puts a budget back after its test", () => {
  it("refuses it before any gate runs and says why to a listening review", async () => {
    authorizeUnattended.mockClear();
    row.body = { test_revert_of: "d-test", test_revert_object: "c1" };
    try {
      let heard: string[] = [];
      expect(await cgoApproveChannelAction(T, "ca-1", { onHeld: (r) => (heard = r) })).toBe(false);
      expect(heard).toEqual(["budget_test_revert"]);
      expect(authorizeUnattended).not.toHaveBeenCalled();
    } finally {
      delete row.body;
    }
  });
});

describe("cgoApproveAdDecision never approves a founder's own chat order (plan 2026-10-17 Task 3.2)", () => {
  it("returns false for a founder-marked Google review card and never approves, before any gate runs", async () => {
    approveDecisionAsCgo.mockClear();
    authorizeUnattended.mockClear();
    const ok = await cgoApproveAdDecision(T, "d-1", "google_ads.update_campaign_budget_review", { campaign_id: "c1", daily_budget_usd: 10, origin: "user_initiated_chat" }, "cgo");
    expect(ok).toBe(false);
    expect(approveDecisionAsCgo).not.toHaveBeenCalled();
    expect(authorizeUnattended).not.toHaveBeenCalled();
  });
});

describe("cgoApproveAdDecision in a chat turn whose held card is shown in that chat (bugs #14, #24)", () => {
  const BODY = { campaign_id: "c1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 };
  beforeEach(() => {
    row.status = "proposed";
    row.agent_run_id = "run-chat";
    askFounderAboutHeld.mockClear();
    recordCardHold.mockClear().mockResolvedValue(true);
    authorizeUnattended.mockResolvedValue({ verdict: "ask_founder", reasons: ["objective_not_conversions"], evidence: null });
  });

  it("must-catch (the incident's held cut): the card is shown in the chat with its hold, and no second question or email goes out", async () => {
    const shownInChat = vi.fn(async () => true);
    expect(await cgoApproveAdDecision(T, "d-cut", "google_ads.update_campaign_budget_review", BODY, "cgo", { shownInChat })).toBe(false);
    expect(recordCardHold).toHaveBeenCalledWith(T, { table: "decisions", id: "d-cut", run_id: "run-chat" }, expect.objectContaining({ reasons: ["objective_not_conversions"] }));
    expect(shownInChat).toHaveBeenCalledTimes(1);
    expect(askFounderAboutHeld).not.toHaveBeenCalled();
  });

  it("must-not-touch: the founder is still asked when the card could not be shown, or the hold could not be written on it", async () => {
    expect(await cgoApproveAdDecision(T, "d-cut", "google_ads.update_campaign_budget_review", BODY, "cgo", { shownInChat: async () => false })).toBe(false);
    expect(askFounderAboutHeld).toHaveBeenCalledTimes(1);
    recordCardHold.mockResolvedValueOnce(false);
    const shownInChat = vi.fn(async () => true);
    await cgoApproveAdDecision(T, "d-cut", "google_ads.update_campaign_budget_review", BODY, "cgo", { shownInChat });
    expect(shownInChat).not.toHaveBeenCalled();
    expect(askFounderAboutHeld).toHaveBeenCalledTimes(2);
  });

  it("must-not-touch: a conflict with ANOTHER open card keeps its own question even when this card is shown", async () => {
    authorizeUnattended.mockResolvedValueOnce({ verdict: "ask_founder", reasons: ["open_advice_conflict"], evidence: null });
    const shownInChat = vi.fn(async () => true);
    await cgoApproveAdDecision(T, "d-cut", "google_ads.update_campaign_budget_review", BODY, "cgo", { shownInChat });
    expect(shownInChat).not.toHaveBeenCalled();
    expect(askFounderAboutHeld).toHaveBeenCalledTimes(1);
  });

  it("must-not-touch: an allowed change is approved by Autopilot and never shown as a card to tap", async () => {
    approveDecisionAsCgo.mockClear();
    authorizeUnattended.mockResolvedValueOnce({ verdict: "allow", reasons: [], evidence: null });
    const shownInChat = vi.fn(async () => true);
    expect(await cgoApproveAdDecision(T, "d-raise", "meta_ads.update_ad_set_budget_review", { ad_set_id: "1", daily_budget_usd: 50 }, "cgo", { shownInChat })).toBe(true);
    expect(shownInChat).not.toHaveBeenCalled();
    expect(approveDecisionAsCgo).toHaveBeenCalledTimes(1);
  });
});

describe("cgoApproveAdDecision when the gate DENIES (bug #8: no silent card)", () => {
  const BODY = { campaign_id: "c1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 };
  beforeEach(() => {
    row.status = "proposed";
    row.agent_run_id = "run-chat";
    askFounderAboutHeld.mockClear();
    recordCardHold.mockClear().mockResolvedValue(true);
    approveDecisionAsCgo.mockClear();
  });

  it("must-catch: a denied card outside a chat records why on the card and tells the founder, and is never approved", async () => {
    authorizeUnattended.mockResolvedValueOnce({ verdict: "deny", reasons: ["class_not_on_unattended_list"], evidence: null });
    expect(await cgoApproveAdDecision(T, "d-x", "google_ads.update_campaign_budget_review", BODY, "cgo")).toBe(false);
    expect(askFounderAboutHeld).toHaveBeenCalledWith(T, expect.objectContaining({ source: { table: "decisions", id: "d-x", run_id: "run-chat" } }), expect.objectContaining({ verdict: "deny" }));
    expect(approveDecisionAsCgo).not.toHaveBeenCalled();
  });

  it("must-catch: a denied card in a chat is shown there with its hold, no second ask", async () => {
    authorizeUnattended.mockResolvedValueOnce({ verdict: "deny", reasons: ["delete_never_unattended"], evidence: null });
    const shownInChat = vi.fn(async () => true);
    expect(await cgoApproveAdDecision(T, "d-x", "google_ads.update_campaign_budget_review", BODY, "cgo", { shownInChat })).toBe(false);
    expect(recordCardHold).toHaveBeenCalledWith(T, { table: "decisions", id: "d-x", run_id: "run-chat" }, expect.objectContaining({ reasons: ["delete_never_unattended"] }));
    expect(shownInChat).toHaveBeenCalledTimes(1);
    expect(askFounderAboutHeld).not.toHaveBeenCalled();
  });

  it("must-not-touch: a deny whose only reason is that the card is the founder's own writes and asks nothing", async () => {
    authorizeUnattended.mockResolvedValueOnce({ verdict: "deny", reasons: ["founder_staged_change"], evidence: null });
    expect(await cgoApproveAdDecision(T, "d-x", "google_ads.update_campaign_budget_review", BODY, "cgo")).toBe(false);
    expect(recordCardHold).not.toHaveBeenCalled();
    expect(askFounderAboutHeld).not.toHaveBeenCalled();
  });

  it("must-catch: a change proposed from an AI assistant is never approved, and waits for the person's tap without a second ask", async () => {
    authorizeUnattended.mockResolvedValueOnce({ verdict: "deny", reasons: ["assistant_run_change"], evidence: null });
    expect(await cgoApproveAdDecision(T, "d-x", "google_ads.update_campaign_budget", BODY, "google_ads")).toBe(false);
    expect(approveDecisionAsCgo).not.toHaveBeenCalled();
    expect(recordCardHold).not.toHaveBeenCalled();
    expect(askFounderAboutHeld).not.toHaveBeenCalled();
  });
});
