import { describe, expect, it, vi, beforeEach } from "vitest";

const logs = vi.hoisted(() => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/logging/logEvent", () => logs);

import { buildAdOrderCard, maybeEmitInlineConfirmCard, type MaybeEmitInlineCardDeps, type MaybeEmitInlineCardInput } from "../build-inline-decision";

const D = "11111111-1111-4111-8111-111111111111";
const input = (decision_class: string, body: Record<string, unknown>, over: Partial<MaybeEmitInlineCardInput> = {}): MaybeEmitInlineCardInput => ({
  decision_id: D,
  decision_class,
  body,
  run_trigger: "chat",
  thread_id: "thread-1",
  agent_run_id: "run-1",
  agent_slug: "cgo",
  tenant_id: "tenant-1",
  founder_chat_order: true,
  founder_card_thread_id: "thread-1",
  founder_card_agent_slug: "cgo",
  founder_card_run_id: "run-1",
  ...over,
});
function deps(over: Partial<MaybeEmitInlineCardDeps> = {}) {
  const emitted: Array<Parameters<MaybeEmitInlineCardDeps["emit"]>[0]> = [];
  const advised: string[] = [];
  const d: MaybeEmitInlineCardDeps = {
    isSpendFlagOn: async () => false,
    isUrgentCardsFlagOn: async () => false,
    emit: async (e) => void emitted.push(e),
    alreadyEmitted: async () => false,
    decisionIsOpen: async () => true,
    onFounderCardEmitted: (id) => void advised.push(id),
    ...over,
  };
  return { d, emitted, advised };
}

const founder = (b: Record<string, unknown> = {}) => ({ origin: "user_initiated_chat", ...b });

describe("founder ad order card", () => {
  beforeEach(() => logs.logEvent.mockClear());

  it("ACCEPTANCE A1 (card side): the incident's Google cut gets one full card titled with the campaign, flags off", async () => {
    const { d, emitted, advised } = deps();
    const ok = await maybeEmitInlineConfirmCard(
      input("google_ads.update_campaign_budget_review", founder({ campaign_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, name: "Search - hosts" })),
      d,
    );
    expect(ok).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].body).toEqual({ decision_id: D, decision_class: "google_ads.update_campaign_budget_review", title: "Cut “Search - hosts” (campaign 1) from $20 to $10 a day", full_card: true });
    expect(emitted[0].thread_id).toBe("thread-1");
    expect(advised).toEqual([D]);
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "founder_order.card_emitted" }));
  });

  it.each([
    "google_ads.add_keywords",
    "google_ads.set_status_review",
    "google_ads.update_campaign",
    "meta_ads.update_ad_set_budget_review",
    "meta_ads.update_campaign",
    "meta_ads.set_status_review",
  ])("%s gets a card", async (cls) => {
    const { d, emitted } = deps();
    expect(await maybeEmitInlineConfirmCard(input(cls, founder()), d)).toBe(true);
    expect(emitted[0].body.full_card).toBe(true);
    expect(emitted[0].body.title).toMatch(/^(Google|Meta) Ads: a change you asked for$/);
  });

  it("an agent's own card (no founder origin, or no founder marker) gets none; an auto class gets none", async () => {
    for (const [cls, body, over] of [
      ["google_ads.update_campaign_budget_review", { campaign_id: "1" }, {}],
      ["google_ads.update_campaign_budget_review", founder(), { founder_chat_order: false }],
      ["google_ads.update_campaign_budget", founder(), {}],
      ["meta_ads.set_status", founder(), {}],
      ["google_ads.add_keywords", founder(), { founder_card_thread_id: null }],
    ] as const) {
      const { d, emitted } = deps();
      expect(await maybeEmitInlineConfirmCard(input(cls, body as Record<string, unknown>, over as Partial<MaybeEmitInlineCardInput>), d), `${cls} ${JSON.stringify(over)}`).toBe(false);
      expect(emitted).toHaveLength(0);
    }
    expect(buildAdOrderCard({ decision_id: D, decision_class: "tiktok_ads.set_status", body: founder() })).toBeNull();
  });

  it("a second emit for the same decision is skipped; the advice event is still sent (its id dedupes)", async () => {
    const { d, emitted, advised } = deps({ alreadyEmitted: async () => true });
    expect(await maybeEmitInlineConfirmCard(input("google_ads.add_keywords", founder()), d)).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(advised).toEqual([D]);
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "founder_order.card_duplicate_skipped" }));
  });

  it("a race the unique index refuses counts as the card already being there", async () => {
    const { d, advised } = deps({ emit: async () => Promise.reject(new Error("emitThreadEvent failed: duplicate key value violates unique constraint")) });
    expect(await maybeEmitInlineConfirmCard(input("google_ads.add_keywords", founder()), d)).toBe(false);
    expect(advised).toEqual([D]);
    const other = deps({ emit: async () => Promise.reject(new Error("db down")) });
    await expect(maybeEmitInlineConfirmCard(input("google_ads.add_keywords", founder()), other.d)).rejects.toThrow("db down");
  });

  it("a closed decision (superseded, or an older rejection emit_decision handed back) gets no card and no advice", async () => {
    const { d, emitted, advised } = deps({ decisionIsOpen: async () => false });
    expect(await maybeEmitInlineConfirmCard(input("google_ads.add_keywords", founder()), d)).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(advised).toHaveLength(0);
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "founder_order.card_skipped_closed" }));
  });

  it("G2: a handoff child's card goes to the founder's thread, as the founder's run and agent", async () => {
    const { d, emitted } = deps();
    expect(
      await maybeEmitInlineConfirmCard(
        input("google_ads.update_campaign_budget_review", founder({ name: "Search - hosts" }), {
          run_trigger: "handoff",
          thread_id: null,
          agent_run_id: "run-child",
          agent_slug: "google_ads",
          founder_card_thread_id: "thread-founder",
          founder_card_agent_slug: "cgo",
          founder_card_run_id: "run-root",
        }),
        d,
      ),
    ).toBe(true);
    expect(emitted[0]).toMatchObject({ thread_id: "thread-founder", agent_slug: "cgo", agent_run_id: "run-root" });
  });

  it("an unreadable once-check throws (no card rather than two; the caller logs and the row stays approvable)", async () => {
    const { d, emitted } = deps({ alreadyEmitted: async () => Promise.reject(new Error("db down")) });
    await expect(maybeEmitInlineConfirmCard(input("google_ads.add_keywords", founder()), d)).rejects.toThrow("db down");
    expect(emitted).toHaveLength(0);
  });

  it("the meta budget review without the founder marker keeps today's confirm card under its flag", async () => {
    const { d, emitted } = deps({ isSpendFlagOn: async () => true });
    await maybeEmitInlineConfirmCard(
      input("meta_ads.update_ad_set_budget_review", { ad_set_id: "a", daily_budget_usd: 10, expected_current_daily_budget_usd: 5, origin: "user_initiated_chat" }, { founder_chat_order: false }),
      d,
    );
    expect(emitted[0].body.full_card).toBeUndefined();
    expect(emitted[0].body.after_usd).toBe(10);
  });
});
