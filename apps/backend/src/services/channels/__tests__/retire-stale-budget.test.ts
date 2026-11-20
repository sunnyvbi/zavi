import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { CLOSED_CARD_TEXT, isBudgetChangeClass, retireStaleBudgetProposals } from "../retire-stale-budget";
import { reconcileChannelActionExec, settleChannelActionExec } from "../exec-actions";

const okRpc = (data: unknown) => vi.fn(async () => ({ data, error: null })) as never;

describe("isBudgetChangeClass", () => {
  it("knows the budget changes on every ad platform, review variants included", () => {
    for (const c of [
      "google_ads.update_campaign_budget_review",
      "meta_ads.update_ad_set_budget",
      "meta_ads.update_campaign_budget_review",
      "chatgpt_ads.update_campaign_budget",
      "tiktok_ads.update_budget",
      "reddit_ads.update_budget",
      "x_ads.update_campaign",
    ]) expect(isBudgetChangeClass(c)).toBe(true);
    for (const c of ["google_ads.create_campaign", "meta_ads.set_status_review", "linkedin_ads.set_status", null, undefined, ""]) {
      expect(isBudgetChangeClass(c)).toBe(false);
    }
  });
});

describe("retireStaleBudgetProposals", () => {
  it("does not call the database for a change that is not a budget change", async () => {
    const rpc = okRpc({ ok: true });
    await retireStaleBudgetProposals("t1", { kind: "channel_action", id: "a1", execClass: "google_ads.create_campaign" }, { rpc });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks the database with ids only and rewrites the Slack card of each decision it closed", async () => {
    const rpc = okRpc({ ok: true, stale: ["c1"], superseded: ["d1", "d2"] });
    const cardRef = vi.fn(async (id: string) => (id === "d1" ? { channel_id: "C1", ts: "1.1" } : null));
    const updateCard = vi.fn(async () => true);
    const out = await retireStaleBudgetProposals(
      "t1",
      { kind: "channel_action", id: "a1", execClass: "google_ads.update_campaign_budget_review" },
      { rpc, cardRef: cardRef as never, updateCard: updateCard as never },
    );
    expect(out).toEqual({ stale: ["c1"], superseded: ["d1", "d2"] });
    expect(rpc).toHaveBeenCalledWith("t1", "retire_stale_budget_proposals", { p_tenant_id: "t1", p_source_kind: "channel_action", p_source_id: "a1" });
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(updateCard).toHaveBeenCalledWith({ tenant_id: "t1", ref: { channel_id: "C1", ts: "1.1" }, text: CLOSED_CARD_TEXT });
  });

  it("closes nothing when the change did not land", async () => {
    const updateCard = vi.fn();
    const out = await retireStaleBudgetProposals("t1", { kind: "decision", id: "d0", execClass: "meta_ads.update_ad_set_budget" }, { rpc: okRpc({ ok: false, code: "not_executed" }), updateCard: updateCard as never });
    expect(out).toEqual({ stale: [], superseded: [] });
    expect(updateCard).not.toHaveBeenCalled();
  });

  it("never throws: a database or Slack failure leaves the proposals for the drift guard", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } })) as never;
    await expect(retireStaleBudgetProposals("t1", { kind: "decision", id: "d0", execClass: "tiktok_ads.update_budget" }, { rpc })).resolves.toEqual({ stale: [], superseded: [] });
    const cardRef = vi.fn(async () => { throw new Error("slack down"); });
    await expect(
      retireStaleBudgetProposals("t1", { kind: "decision", id: "d0", execClass: "tiktok_ads.update_budget" }, { rpc: okRpc({ ok: true, superseded: ["d1"] }), cardRef: cardRef as never }),
    ).resolves.toEqual({ stale: [], superseded: [] });
  });
});

describe("settle and reconcile call it after a budget change lands", () => {
  const settleRpc = okRpc({ ok: true });

  it("settle: on success, replay included; never on a failure", async () => {
    const retire = vi.fn(async () => ({ stale: [], superseded: [] }));
    await settleChannelActionExec("t1", { actionId: "a1", ok: true, execClass: "google_ads.update_campaign_budget_review", claimId: "k" }, settleRpc, () => {}, retire);
    expect(retire).toHaveBeenCalledWith("t1", { kind: "channel_action", id: "a1", execClass: "google_ads.update_campaign_budget_review" });
    retire.mockClear();
    await settleChannelActionExec("t1", { actionId: "a1", ok: true, execClass: "google_ads.update_campaign_budget_review", claimId: "k" }, okRpc({ ok: true, replayed: true }), () => {}, retire);
    expect(retire).toHaveBeenCalledTimes(1);
    retire.mockClear();
    await settleChannelActionExec("t1", { actionId: "a1", ok: true, execClass: "google_ads.update_campaign_budget_review", claimId: "k" }, okRpc({ ok: false, code: "not_dispatching" }), () => {}, retire);
    expect(retire).not.toHaveBeenCalled();
  });

  it("reconcile: only a reconciled success", async () => {
    const retire = vi.fn(async () => ({ stale: [], superseded: [] }));
    await reconcileChannelActionExec("t1", { actionId: "a1", ok: true, result: {}, execClass: "reddit_ads.update_budget" }, settleRpc, retire);
    expect(retire).toHaveBeenCalledTimes(1);
    retire.mockClear();
    await reconcileChannelActionExec("t1", { actionId: "a1", ok: false, result: { error: "x" }, error: "x", execClass: "reddit_ads.update_budget" }, settleRpc, retire);
    expect(retire).not.toHaveBeenCalled();
  });
});

describe("decisionClosedElsewhere", () => {
  it("is quiet when the click changed it or it already holds what was asked", async () => {
    const { decisionClosedElsewhere } = await import("@/services/approvals/decision-closed");
    expect(decisionClosedElsewhere("approve", { changed: true, status: "approved" })).toBeNull();
    expect(decisionClosedElsewhere("approve", { changed: false, status: "acted" })).toBeNull();
    expect(decisionClosedElsewhere("reject", { changed: false, status: "rejected" })).toBeNull();
  });
  it("says why when the click lost to another ending", async () => {
    const { decisionClosedElsewhere } = await import("@/services/approvals/decision-closed");
    expect(decisionClosedElsewhere("approve", { changed: false, status: "superseded" })).toMatch(/^Not approved: this proposal was closed just before your click/);
    expect(decisionClosedElsewhere("approve", { changed: false, status: "expired" })).toBe("Not approved: this proposal had expired.");
    expect(decisionClosedElsewhere("reject", { changed: false, status: "acted" })).toBe("Not rejected: it was already approved.");
    expect(decisionClosedElsewhere("approve", { changed: false, status: "rejected" })).toBe("Not approved: it was already rejected.");
    expect(decisionClosedElsewhere("approve", { changed: false, status: "proposed" })).toMatch(/^Not approved: something else was updating/);
  });
});
