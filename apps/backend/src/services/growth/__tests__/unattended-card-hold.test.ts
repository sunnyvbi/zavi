
import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "44444444-4444-4444-4444-444444444444";

type Update = { patch: Record<string, unknown>; filters: Array<[string, string, unknown]> };
const updates: Update[] = [];
let updatedRows: unknown[] | null = [{ id: "ca-1" }];
let updateError: { message: string } | null = null;

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const u: Update = { patch, filters: [["table", table, null]] };
        updates.push(u);
        const q = {
          eq: (c: string, v: unknown) => (u.filters.push(["eq", c, v]), q),
          is: (c: string, v: unknown) => (u.filters.push(["is", c, v]), q),
          select: async () => ({ data: updatedRows, error: updateError }),
        };
        return q;
      },
    }),
  }),
}));

vi.mock("@/services/approvals/card-location", async (orig) => ({
  ...(await orig<typeof import("@/services/approvals/card-location")>()),
  readCardState: vi.fn(async () => ({ table: "decisions", status: "proposed", approved_by_source: null, home: { kind: "growth" }, in_chat: false })),
}));

const askFounderOutsideReview = vi.fn().mockResolvedValue(true);
const assertNoContradictingOpenAdvice = vi.fn().mockResolvedValue(false);
vi.mock("../open-advice", () => ({
  refsFromPayload: () => ({ ids: ["c1"] }),
  adObjectFor: async () => ({ name: "Search - hosts", ids: ["c1"] }),
  channelsForAdClass: () => ["chatgpt_ads"],
  normName: (s: string) => s.toLowerCase(),
  assertNoContradictingOpenAdvice: (...a: unknown[]) => assertNoContradictingOpenAdvice(...a),
  askFounderOutsideReview: (...a: unknown[]) => askFounderOutsideReview(...a),
}));

const logs = vi.hoisted(() => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/logging/logEvent", () => logs);

import { askFounderAboutHeld, heldChangeAsk, heldReasonWords } from "../unattended-policy";

const card = (table: "channel_actions" | "decisions" = "channel_actions") => ({
  kind: "ad" as const,
  exec_class: "chatgpt_ads.create_campaign",
  payload: { campaign_id: "c1" },
  source: { table, id: "ca-1", run_id: "run-1" },
  title: "Launch a $20/day ChatGPT test",
});
const held = { verdict: "ask_founder" as const, reasons: ["chatgpt_wallet_insufficient"], evidence: "Wallet $12, schedule needs $140." };

describe("askFounderAboutHeld", () => {
  beforeEach(() => {
    updates.length = 0;
    updatedRows = [{ id: "ca-1" }];
    updateError = null;
    askFounderOutsideReview.mockClear();
    assertNoContradictingOpenAdvice.mockClear();
  });

  it("a door hold on a waiting channel card is written on the card, and no question, note or email is filed", async () => {
    expect(await askFounderAboutHeld(T, card(), held)).toBe(true);
    expect(askFounderOutsideReview).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u.filters).toEqual(
      expect.arrayContaining([
        ["table", "channel_actions", null],
        ["eq", "id", "ca-1"],
        ["eq", "tenant_id", T],
        ["eq", "status", "pending"],
        ["is", "exec_status", null],
      ]),
    );
    const hold = u.patch.cgo_hold as { reasons: string[]; words: string[]; evidence: string | null; at: string };
    expect(hold.reasons).toEqual(["chatgpt_wallet_insufficient"]);
    expect(hold.words[0]).toMatch(/prepaid ChatGPT wallet/);
    expect(hold.evidence).toBe("Wallet $12, schedule needs $140.");
    expect(Number.isNaN(Date.parse(hold.at))).toBe(false);
  });

  it("falls back to asking when the hold could not be written (never silent)", async () => {
    for (const fail of [() => (updateError = { message: "boom" }), () => (updatedRows = [])]) {
      updates.length = 0;
      updatedRows = [{ id: "ca-1" }];
      updateError = null;
      askFounderOutsideReview.mockClear();
      fail();
      expect(await askFounderAboutHeld(T, card(), held)).toBe(true);
      expect(askFounderOutsideReview).toHaveBeenCalledTimes(1);
      const ask = (askFounderOutsideReview.mock.calls[0][0] as { ask: string }).ask;
      expect(ask).toContain("Add balance first; approving before that will not launch it.");
      expect(ask).not.toContain("Approve it if you agree");
    }
  });

  it("a channel gate's own code gets words on the card; a code with no words falls back to asking", async () => {
    expect(await askFounderAboutHeld(T, card(), { verdict: "ask_founder", reasons: ["open_advice_unresolved"] })).toBe(true);
    expect(updates).toHaveLength(1);
    expect((updates[0].patch.cgo_hold as { words: string[] }).words.length).toBeGreaterThan(0);
    expect(askFounderOutsideReview).not.toHaveBeenCalled();
    updates.length = 0;
    expect(await askFounderAboutHeld(T, card(), { verdict: "ask_founder", reasons: ["made_up_code_nobody_mapped"] })).toBe(true);
    expect(updates).toHaveLength(0);
    expect(askFounderOutsideReview).toHaveBeenCalledTimes(1);
  });

  it("every reason the ChatGPT, LinkedIn, X and Reddit gates hold with has plain words", async () => {
    const { heldReasonWords } = await import("../unattended-policy");
    const codes = [
      "open_advice_unresolved", "raise_step_too_large", "raised_recently", "channel_unavailable", "chatgpt_facts_unavailable",
      "chatgpt_wallet_unknown", "chatgpt_paid_consent_required", "active_growth_budget_and_autopilot_required", "daily_budget_required",
      "campaign_changed", "campaign_ended_or_archived", "founder_pause_or_unknown", "founder_set_budget", "founder_requested_change",
      "budget_cut_needs_founder", "linkedin_facts_unavailable", "linkedin_paid_consent_required", "open_advice_unreadable_or_conflicting",
      "x_existing_objects_need_founder", "x_currency_unsupported", "x_finite_budget_and_schedule_required", "x_launch_outside_reserved_month",
      "x_conversion_health_unverified", "x_permissions_or_funding_unverified", "founder_staged_change", "reddit_budget_change_needs_founder",
      "reddit_readiness_unverified",
    ];
    for (const c of codes) {
      const w = heldReasonWords([c]);
      expect(w, c).toHaveLength(1);
      expect(w[0], c).not.toMatch(/\u2014/);
    }
  });

  it("a held controller order (no card) still asks once, ending with the top-up ask", async () => {
    expect(await askFounderAboutHeld(T, card(), held, false)).toBe(true);
    expect(updates).toHaveLength(0);
    expect(askFounderOutsideReview).toHaveBeenCalledTimes(1);
    expect((askFounderOutsideReview.mock.calls[0][0] as { ask: string }).ask.endsWith("Add prepaid ChatGPT balance, or tell me a smaller experiment.")).toBe(true);
  });

  it("a decisions card records the hold on the row and asks nothing: the card is where the founder decides (cgo-log 2026-10-23)", async () => {
    expect(await askFounderAboutHeld(T, card("decisions"), { verdict: "ask_founder", reasons: ["pause_needs_founder"] })).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toEqual(
      expect.arrayContaining([["table", "decisions", null], ["eq", "id", "ca-1"], ["eq", "tenant_id", T], ["eq", "status", "proposed"]]),
    );
    expect(askFounderOutsideReview).not.toHaveBeenCalled();
  });

  it("a card that did not take the hold asks once per CARD (held:card:<id>, either table), so the sweep can close it when the card is decided", async () => {
    updatedRows = [];
    await askFounderAboutHeld(T, card("decisions"), { verdict: "ask_founder", reasons: ["pause_needs_founder"] });
    await askFounderAboutHeld(T, { ...card("decisions"), source: { table: "decisions" as const, id: "d-newer", run_id: "run-2" } }, { verdict: "ask_founder", reasons: ["pause_needs_founder"] });
    await askFounderAboutHeld(T, card("channel_actions"), { verdict: "ask_founder", reasons: ["pause_needs_founder"] });
    const topics = askFounderOutsideReview.mock.calls.map((c) => (c[0] as { topic: string }).topic);
    expect(topics).toEqual(["held:card:ca-1", "held:card:d-newer", "held:card:ca-1"]);
  });

  it("must-not-touch: a held controller order with no card keeps its per-object question", async () => {
    await askFounderAboutHeld(T, card("decisions"), { verdict: "ask_founder", reasons: ["pause_needs_founder"] }, false);
    expect((askFounderOutsideReview.mock.calls[0][0] as { topic: string }).topic).toBe("held:chatgpt_ads:c1");
  });

  it("ACCEPTANCE A2 (backend): Autopilot's held Google cut stores words and cleaned, capped evidence on the decisions row", async () => {
    logs.logEvent.mockClear();
    const cut = {
      kind: "ad" as const,
      exec_class: "google_ads.update_campaign_budget",
      payload: { campaign_id: "c1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 },
      source: { table: "decisions" as const, id: "ca-1", run_id: "run-1" },
      title: "Cut Search - hosts from $20 to $10 a day",
    };
    const evidence = `7-day spend $40,\n0 conversions\u0007 ${"x".repeat(400)}`;
    await askFounderAboutHeld(T, cut, { verdict: "ask_founder", reasons: ["objective_metric_mismatch", "results_not_goal"], evidence });
    const hold = updates[0].patch.cgo_hold as { reasons: string[]; words: string[]; evidence: string };
    expect(hold.reasons).toEqual(["objective_metric_mismatch", "results_not_goal"]);
    expect(hold.words[0]).toBe("it is not set up to get conversions, so zero conversions says nothing");
    expect(hold.evidence.startsWith("7-day spend $40, 0 conversions")).toBe(true);
    expect(hold.evidence).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(hold.evidence.length).toBeLessThanOrEqual(300);
    expect(updates[0].filters).toEqual(expect.arrayContaining([["eq", "status", "proposed"], ["eq", "tenant_id", T]]));
    expect(logs.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "cgo.card_hold_recorded", meta: { table: "decisions", hold_reasons: "objective_metric_mismatch,results_not_goal" } }),
    );
    expect(askFounderOutsideReview).not.toHaveBeenCalled();
  });

  it("Flow 5: a held budget change is asked by name and both amounts, never an id or a cut-off title", async () => {
    updatedRows = [];
    const cut = {
      kind: "ad" as const,
      exec_class: "google_ads.update_campaign_budget",
      payload: { campaign_id: "c1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 },
      source: { table: "decisions" as const, id: "ca-1", run_id: "run-1" },
      title: "Cut Search - hosts from $20 to $10 a day",
    };
    await askFounderAboutHeld(T, cut, { verdict: "ask_founder", reasons: ["objective_metric_mismatch"] });
    const ask = (askFounderOutsideReview.mock.calls[0][0] as { ask: string }).ask;
    expect(ask.startsWith("I did not cut “Search - hosts” from $20 to $10 a day on my own:")).toBe(true);
    expect(ask).not.toMatch(/\bc1\b|update campaign budget/);
  });

  it("an open-advice conflict records the hold on the card and asks only the conflict question", async () => {
    const v = { verdict: "ask_founder" as const, reasons: ["open_advice_conflict"] };
    expect(await askFounderAboutHeld(T, card(), v)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(assertNoContradictingOpenAdvice).toHaveBeenCalledTimes(1);
    expect(askFounderOutsideReview).not.toHaveBeenCalled();
    assertNoContradictingOpenAdvice.mockResolvedValueOnce(true);
    expect(await askFounderAboutHeld(T, card(), v)).toBe(true);
    expect(askFounderOutsideReview).not.toHaveBeenCalled();
  });
});

describe("the words for a launch held by saved controls", () => {
  it("a held LinkedIn launch says the controls do not support LinkedIn and never blames purchase tracking", () => {
    const ask = heldChangeAsk("launch this LinkedIn campaign", ["business_controls_no_linkedin"]);
    expect(ask).toMatch(/^I did not launch this LinkedIn campaign on my own: experiments and controlled campaigns do not support LinkedIn yet/);
    expect(ask).not.toMatch(/purchase|revenue|tracking|measured/i);
  });

  it("must not catch: every other channel's hold keeps its purchase wording", () => {
    expect(heldReasonWords(["business_results_unavailable"])).toEqual(["measured purchases or purchase revenue are unavailable"]);
  });
});
