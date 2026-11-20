import { describe, it, expect, vi } from "vitest";
import {
  RECEIPT_WAIT_MS,
  channelActionPhase,
  decisionPhase,
  withAdCardReceipt,
  type CardRead,
} from "../ad-card-receipt";
import type { McpCallResult } from "../types";

const ok = (v: unknown): McpCallResult => ({ ok: true, is_error: false, content: JSON.stringify(v), ms: 1 });
const ctx = { tenant_id: "t1" };

function deps(cards: Array<CardRead | null>, newStatus: string | null = null) {
  let t = 0;
  let i = 0;
  const readCard = vi.fn(async () => cards[Math.min(i++, cards.length - 1)]);
  return {
    readCard,
    readNewStatus: vi.fn(async () => newStatus),
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    now: () => t,
  };
}

const card = (over: Partial<CardRead>): CardRead => ({
  table: "decisions",
  cls: "google_ads.create_campaign",
  phase: "waiting",
  by_cgo: false,
  reason: null,
  notice: null,
  ...over,
});

const googleCreate = {
  decision_id: "00000000-0000-4000-8000-0000000000d1",
  decision_class: "google_ads.create_campaign",
  will_auto_apply: false,
  notice: "The card waits for you, or Autopilot when it runs your ads under a budget. The campaign is created PAUSED once approved.",
};

describe("ad-card-receipt: an ad proposal reports what its card really did", () => {
  it("example 2: a Google create Autopilot approved and ran says approved + live, not 'waits / created paused'", async () => {
    const d = deps([card({ phase: "running", by_cgo: true }), card({ phase: "done", by_cgo: true })], "ENABLED");
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCreate), d)).content);
    expect(out.card_status).toBe("carried_out");
    expect(out.receipt).toBe("Autopilot approved it; Zavi set it to ENABLED on Google.");
    expect(out.will_auto_apply).toBe(true);
    expect(out.notice).toBeUndefined();
    expect(out.decision_id).toBe("00000000-0000-4000-8000-0000000000d1");
    expect(Object.keys(out).slice(0, 2)).toEqual(["card_status", "receipt"]);
    expect(d.readNewStatus).toHaveBeenCalledWith("t1", "decisions", "00000000-0000-4000-8000-0000000000d1");
  });

  it("example 3: a Meta switch-on reports ACTIVE once it lands, after waiting for it", async () => {
    const running = card({ cls: "meta_ads.set_status_review", phase: "running", by_cgo: true });
    const d = deps([running, running, running, card({ cls: "meta_ads.set_status_review", phase: "done", by_cgo: true })], "ACTIVE");
    const res = await withAdCardReceipt(ctx, "meta_ads", ok({ decision_id: "00000000-0000-4000-8000-0000000000d2", will_auto_apply: false }), d);
    const out = JSON.parse(res.content);
    expect(out.receipt).toBe("Autopilot approved it; Zavi set it to ACTIVE on Meta.");
    expect(d.sleep).toHaveBeenCalledTimes(3);
  });

  it("still running at the wait limit: approved, still being set up, never live", async () => {
    const d = deps([card({ phase: "running", by_cgo: true })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCreate), d)).content);
    expect(out.card_status).toBe("approved_by_autopilot");
    expect(out.receipt).toMatch(/still being set up on Google/);
    expect(out.receipt).not.toMatch(/set it to/);
    expect(d.sleep.mock.calls.reduce((s, [ms]) => s + ms, 0)).toBe(RECEIPT_WAIT_MS);
  });

  it("must not: a card that truly waits for the founder still says waiting and where; the tool's own notice (which guessed) is dropped", async () => {
    const d = deps([card({ phase: "waiting" })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCreate), d)).content);
    expect(out.card_status).toBe("waiting_for_approval");
    expect(out.receipt).toMatch(/waiting for the founder's approval/);
    expect(out.receipt).toMatch(/Growth page/);
    expect(out.will_auto_apply).toBe(false);
    expect(out.notice).toBeUndefined();
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("a failure says it failed, with the stored reason", async () => {
    const d = deps([card({ phase: "failed", by_cgo: true, reason: "cap_refuse: over the daily limit" })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCreate), d)).content);
    expect(out.card_status).toBe("failed");
    expect(out.receipt).toBe("Autopilot approved it, but it failed on Google: cap_refuse: over the daily limit.");
  });

  it("held for the founder at dispatch reads as waiting, with why", async () => {
    const d = deps([card({ phase: "held", reason: "a newer card is open on this ad set" })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "meta_ads", ok({ action_id: "00000000-0000-4000-8000-0000000000a1" }), d)).content);
    expect(out.card_status).toBe("waiting_for_approval");
    expect(out.receipt).toMatch(/^Autopilot held this for the founder: a newer card is open on this ad set\./);
  });

  it("a channel action that ran with no status change quotes the worker's notice", async () => {
    const d = deps([card({ table: "channel_actions", cls: "meta_ads.update_ad_set_budget", phase: "done", by_cgo: true, notice: "Set ad set budget to $48/day." })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "meta_ads", ok({ decision_id: "00000000-0000-4000-8000-0000000000a2" }), d)).content);
    expect(out.receipt).toBe("Autopilot approved it; done on Meta. Set ad set budget to $48/day.");
  });

  it("must not: a refused proposal (tool error, no card) is untouched", async () => {
    const err: McpCallResult = { ok: false, is_error: true, content: JSON.stringify({ error: "x", message: "Nothing was written" }), ms: 1 };
    const d = deps([card({})]);
    expect(await withAdCardReceipt(ctx, "google_ads", err, d)).toBe(err);
    const noId = ok({ dry_run: true });
    const placeholder = ok({ decision_id: "channel_action_suppressed" });
    expect(await withAdCardReceipt(ctx, "google_ads", placeholder, d)).toBe(placeholder);
    expect(await withAdCardReceipt(ctx, "google_ads", noId, d)).toBe(noId);
    expect(d.readCard).not.toHaveBeenCalled();
  });

  it("no work outside the ad servers, on a suppressed run, or for a non-ad card", async () => {
    const d = deps([card({ cls: "email.send" })]);
    const r = ok({ decision_id: "00000000-0000-4000-8000-0000000000d3" });
    expect(await withAdCardReceipt(ctx, "slack", r, d)).toBe(r);
    expect(await withAdCardReceipt({ tenant_id: "t1", writes_suppressed: true }, "google_ads", r, d)).toBe(r);
    expect(d.readCard).not.toHaveBeenCalled();
    expect(await withAdCardReceipt(ctx, "google_ads", r, d)).toBe(r);
  });

  it("a read error leaves the tool's result as it was", async () => {
    const d = { ...deps([]), readCard: vi.fn(async () => { throw new Error("db down"); }) };
    const r = ok(googleCreate);
    expect(await withAdCardReceipt(ctx, "google_ads", r, d)).toBe(r);
  });
});

describe("ad-card-receipt: review findings", () => {
  it("a founder approval still running is not called Autopilot, and will_auto_apply stays false", async () => {
    const d = deps([card({ phase: "running", by_cgo: false })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCreate), d)).content);
    expect(out.card_status).toBe("approved_in_progress");
    expect(out.will_auto_apply).toBe(false);
  });

  it("a create that ran with no record of being switched on is not live", async () => {
    const d = deps([card({ phase: "done", by_cgo: true })], null);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCreate), d)).content);
    expect(out.card_status).toBe("created_not_live");
    expect(out.receipt).toMatch(/no record of switching it on/);
  });

  it("a partial run is uncertain, never 'did not happen'", async () => {
    const d = deps([card({ table: "channel_actions", cls: "meta_ads.launch_campaign", phase: "uncertain", by_cgo: true, reason: "the ad set was made, the ad was not" })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "meta_ads", ok({ action_id: "00000000-0000-4000-8000-0000000000a3" }), d)).content);
    expect(out.card_status).toBe("uncertain");
    expect(out.receipt).toMatch(/may have only partly gone through on Meta/);
  });

  it("a stalled read never holds the tool call past the hard limit", async () => {
    const d = { ...deps([]), readCard: vi.fn(() => new Promise<CardRead | null>(() => {})) };
    const r = ok(googleCreate);
    expect(await withAdCardReceipt(ctx, "google_ads", r, d, 20)).toBe(r);
  });
});

describe("ad-card-receipt: lane A findings", () => {
  it("F1: a tool's own 'waiting_for_founder' status is dropped once Autopilot approved the card", async () => {
    const d = deps([card({ table: "channel_actions", cls: "x_ads.create_campaign", phase: "running", by_cgo: true })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "x_ads", ok({ action_id: "00000000-0000-4000-8000-0000000000a4", status: "waiting_for_founder" }), d)).content);
    expect(out.card_status).toBe("approved_by_autopilot");
    expect(out.status).toBeUndefined();
  });

  it("must not: a card that still waits keeps the tool's own status", async () => {
    const d = deps([card({ table: "channel_actions", cls: "x_ads.create_campaign", phase: "waiting" })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "x_ads", ok({ action_id: "00000000-0000-4000-8000-0000000000a5", status: "waiting_for_founder" }), d)).content);
    expect(out.status).toBe("waiting_for_founder");
  });

  it("F2: a create the executor verified ACTIVE (no status row) is carried out", async () => {
    const d = deps([card({ table: "channel_actions", cls: "x_ads.create_campaign", phase: "done", by_cgo: true, created_status: "ACTIVE" })], null);
    const out = JSON.parse((await withAdCardReceipt(ctx, "x_ads", ok({ action_id: "00000000-0000-4000-8000-0000000000a6" }), d)).content);
    expect(out.card_status).toBe("carried_out");
    expect(out.receipt).toBe("Autopilot approved it; Zavi set it to ACTIVE on X.");
  });

  it("F3: an enable Google did not confirm is not live", async () => {
    const d = deps([card({ phase: "done", by_cgo: true })], "UNVERIFIED");
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCreate), d)).content);
    expect(out.card_status).toBe("created_not_live");
    expect(out.receipt).toMatch(/Google has not confirmed the switch-on yet, so do not say it is live/);
  });
});

describe("phases from each store", () => {
  it("decisions", () => {
    expect(decisionPhase({ status: "proposed" })).toBe("waiting");
    expect(decisionPhase({ status: "proposed", dispatch_error: "held for the founder" })).toBe("held");
    expect(decisionPhase({ status: "proposed", autonomy_at_emit: "auto" })).toBe("auto");
    expect(decisionPhase({ status: "proposed", cgo_hold: { words: ["x"] } })).toBe("held");
    expect(decisionPhase({ status: "superseded", cgo_hold: null })).toBe("closed");
    expect(decisionPhase({ status: "approved" })).toBe("running");
    expect(decisionPhase({ status: "dispatching" })).toBe("running");
    expect(decisionPhase({ status: "acted" })).toBe("done");
    expect(decisionPhase({ status: "dispatch_failed" })).toBe("failed");
    expect(decisionPhase({ status: "rejected" })).toBe("closed");
  });
  it("channel_actions", () => {
    expect(channelActionPhase({ status: "pending", exec_status: null })).toBe("waiting");
    expect(channelActionPhase({ status: "pending", exec_status: "queued" })).toBe("running");
    expect(channelActionPhase({ status: "pending", exec_status: "dispatching" })).toBe("running");
    expect(channelActionPhase({ status: "acted", exec_status: "executed" })).toBe("done");
    expect(channelActionPhase({ status: "pending", exec_status: "failed", exec_result: { held_for_founder: true } })).toBe("held");
    expect(channelActionPhase({ status: "pending", exec_status: "failed", exec_result: { error: "x" } })).toBe("failed");
    expect(channelActionPhase({ status: "displaced", exec_status: null })).toBe("closed");
    expect(channelActionPhase({ status: "snoozed", exec_status: null })).toBe("waiting");
    expect(channelActionPhase({ status: "pending", exec_status: "failed", exec_result: { bucket: "partial_risk" } })).toBe("uncertain");
  });
});

describe("ad-card-receipt: a founder's direct ask", () => {
  const chatgptAsk = {
    action_id: "00000000-0000-4000-8000-0000000000c1",
    status: "proposed",
    message: "Proposed only. Approval and fresh Growth, wallet and platform checks are required before execution.",
    say_to_founder: "Running $25 on ChatGPT as one total for 1 day.",
  };
  const ask = (over: Partial<CardRead>) => card({ table: "channel_actions", cls: "chatgpt_ads.create_and_launch", direct_ask: true, ...over });

  it("still running at the cutoff: says Zavi posts the result itself, and drops the lines written before it ran", async () => {
    const d = deps([ask({ phase: "running" })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "chatgpt_ads", ok(chatgptAsk), d)).content);
    expect(out.card_status).toBe("direct_ask_launching");
    expect(out.receipt).toContain("Zavi posts how it ended in this conversation itself, after your reply");
    expect(out.receipt).toContain("say only that Zavi will post the result here");
    expect(out.say_to_founder).toBeUndefined();
    expect(out.message).toBeUndefined();
    expect(out.status).toBeUndefined();
  });

  it("drops will_auto_apply: a direct ask is neither Autopilot nor waiting", async () => {
    const d = deps([ask({ phase: "running" })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok({ ...chatgptAsk, will_auto_apply: false }), d)).content);
    expect("will_auto_apply" in out).toBe(false);
  });

  it("failed: the failure, and that Zavi posts it itself", async () => {
    const d = deps([ask({ phase: "failed", reason: "Zavi created ChatGPT campaign cmpn_1 but could not launch it, so it was archived." })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "chatgpt_ads", ok(chatgptAsk), d)).content);
    expect(out.card_status).toBe("failed");
    expect(out.receipt).toContain("The founder asked for it, but it failed on ChatGPT: Zavi created ChatGPT campaign cmpn_1");
    expect(out.receipt).not.toContain("It was approved");
    expect(out.receipt).toContain("Zavi posts this result in the founder's conversation itself");
    expect(out.say_to_founder).toBeUndefined();
  });

  it("uncertain (maybe the older card the duplicate check handed back): keeps the line that names it, no 'Zavi posts'", async () => {
    const line = "An earlier ChatGPT launch ('Renters 1-Day') may have partly gone through, so I did not start another one.";
    const d = deps([ask({ phase: "uncertain" })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "chatgpt_ads", ok({ ...chatgptAsk, say_to_founder: line }), d)).content);
    expect(out.card_status).toBe("uncertain");
    expect(out.say_to_founder).toBe(line);
    expect(out.receipt).not.toContain("Zavi posts");
  });

  it("an Autopilot (non-direct) card keeps today's running receipt", async () => {
    const d = deps([ask({ phase: "running", direct_ask: false, by_cgo: true })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "chatgpt_ads", ok(chatgptAsk), d)).content);
    expect(out.receipt).toBe("Autopilot approved it; it is still being set up on ChatGPT. Check the card before saying it is live.");
    expect(out.say_to_founder).toBe(chatgptAsk.say_to_founder);
  });
});

describe("receipts say where the card really is (plan 2026-10-17 Task 3.9)", () => {
  const googleCut = {
    decision_id: "00000000-0000-4000-8000-0000000000e1",
    decision_class: "google_ads.update_campaign_budget",
    will_auto_apply: true,
    notice: "Applies on its own within your cap.",
  };

  it("a founder order whose card is in the chat says so; the tool's auto class and will_auto_apply are overwritten", async () => {
    const d = deps([card({ cls: "google_ads.update_campaign_budget_review", founder_order: true, chat_card: true })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCut), d)).content);
    expect(out.receipt).toBe(
      "The founder asked for this. Its card is in the chat now and waits for the founder's tap. Nothing has changed in the ad account yet; do not say it is live or applied.",
    );
    expect(out.decision_class).toBe("google_ads.update_campaign_budget_review");
    expect(out.will_auto_apply).toBe(false);
    expect(out.notice).toBeUndefined();
  });

  it("without a chat card it never claims one: the Growth page", async () => {
    const d = deps([card({ cls: "google_ads.update_campaign_budget_review", founder_order: true, chat_card: false })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCut), d)).content);
    expect(out.receipt).not.toMatch(/in the chat/);
    expect(out.receipt).toMatch(/The founder can approve it on the Growth page/);
  });

  it("a channel_actions row points to its tile, never to a chat card", async () => {
    const d = deps([card({ table: "channel_actions", cls: "google_ads.update_campaign_budget", channel_slug: "google_ads", chat_card: true })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok({ action_id: "00000000-0000-4000-8000-0000000000e2" }), d)).content);
    expect(out.receipt).toMatch(/on the Google Ads tile/);
    expect(out.receipt).not.toMatch(/in the chat/);
  });

  it("ACCEPTANCE A2 (receipt): Autopilot's held cut says held, why, and the Growth page", async () => {
    const d = deps([
      card({
        cls: "google_ads.update_campaign_budget",
        phase: "held",
        hold_words: ["it is not set up to get conversions, so zero conversions says nothing"],
      }),
    ]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCut), d)).content);
    expect(out.card_status).toBe("waiting_for_approval");
    expect(out.receipt).toBe(
      "Autopilot held this for the founder: it is not set up to get conversions, so zero conversions says nothing. The founder can approve it on the Growth page; nothing has changed in the ad account.",
    );
    expect(out.will_auto_apply).toBe(false);
  });

  it("a card a newer budget change superseded is closed", async () => {
    const d = deps([card({ cls: "google_ads.update_campaign_budget_review", phase: decisionPhase({ status: "superseded" }) })]);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(googleCut), d)).content);
    expect(out.card_status).toBe("closed");
  });
});

describe("ad-card-receipt: will_auto_apply comes from the row even when the tool omits it", () => {
  const { will_auto_apply: _w, ...noClaim } = googleCreate;

  it("Autopilot approved and ran it: true", async () => {
    const d = deps([card({ phase: "running", by_cgo: true }), card({ phase: "done", by_cgo: true })], "ENABLED");
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(noClaim), d)).content);
    expect(out.will_auto_apply).toBe(true);
  });

  it("an auto-class card: true", async () => {
    const d = deps([card({ phase: "auto" })], null);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(noClaim), d)).content);
    expect(out.will_auto_apply).toBe(true);
  });

  it("a closed card: false", async () => {
    const d = deps([card({ phase: "closed" })], null);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(noClaim), d)).content);
    expect(out.will_auto_apply).toBe(false);
  });

  it("still waiting for the founder: false", async () => {
    const d = deps([card({ phase: "waiting" })], null);
    const out = JSON.parse((await withAdCardReceipt(ctx, "google_ads", ok(noClaim), d)).content);
    expect(out.will_auto_apply).toBe(false);
  });
});
