import { describe, it, expect } from "vitest";
import { budgetRaiseNeed, computeBudgetRaiseNeed, raiseFromCard, type LiveHold } from "../ad-budget-shortfall";
import type { AdBudgetMonthView } from "@/services/decisions/ad-budget";

const view = (over: Partial<AdBudgetMonthView> = {}): AdBudgetMonthView => ({
  id: "b-1",
  status: "active",
  monthly_usd: 25000,
  month_cap_usd: 25000,
  spent_usd: 4000,
  held_usd: 20645.57,
  creator_held_usd: 0,
  creator_spent_usd: 0,
  left_usd: 354.43,
  daily_limit_usd: null,
  next_month_start: "2026-11-01",
  days_left: 25,
  days_in_month: 31,
  started_on: "2026-08-10",
  created_at: "2026-08-10T00:00:00Z",
  stopped_at: null,
  month_start: "2026-10-01",
  margin: 1,
  ...over,
});
const google = (to: number, from: number) => ({
  exec_class: "google_ads.update_campaign_budget_review",
  exec_payload: { campaign_id: "c-1", daily_budget_usd: to, expected_current_daily_budget_usd: from, rationale: "", over_cap: true },
});
const meta = (to: number, from: number, currency?: string) => ({
  exec_class: "meta_ads.update_ad_set_budget",
  exec_payload: { ad_set_id: "as-1", daily_budget_usd: to, expected_current_daily_budget_usd: from, rationale: "", over_cap: false, ...(currency ? { currency } : {}) },
});
const hold = (platform: string, object_id: string, daily: number, pause_due = false): LiveHold => ({ platform, object_id, daily_delta_usd: daily, pause_due });
const need = (card: { exec_class: string; exec_payload: unknown }, v: AdBudgetMonthView | null, holds: LiveHold[] = []) =>
  budgetRaiseNeed("t-1", card, { readView: async () => v, readHolds: async () => holds });

describe("budgetRaiseNeed", () => {
  it("a $55 -> $110 raise with $55 already held needs 55 x 25 days = $1,375 against $354.43 of room", async () => {
    expect(await need(google(110, 55), view(), [hold("google", "c-1", 55)])).toEqual({
      kind: "needs_raise",
      budget_id: "b-1",
      from_usd: 25000,
      to_usd: 26021,
      daily_limit_usd: null,
    });
  });

  it("an object the budget never held reserves only the increase, as one it holds does", async () => {
    expect(await need(google(110, 55), view())).toMatchObject({ kind: "needs_raise", to_usd: 26021 });
    expect(await need(google(110, 55), view(), [hold("google", "c-1", 55, true)])).toMatchObject({ to_usd: 26021 });
  });

  it("fits when the month has room, and a Meta ad set works the same", async () => {
    const roomy = view({ held_usd: 1000, left_usd: 20000 });
    expect(await need(google(110, 55), roomy, [hold("google", "c-1", 55)])).toEqual({ kind: "fits" });
    expect(await need(meta(80, 40), roomy, [hold("meta", "as-1", 40)])).toEqual({ kind: "fits" });
    expect(await need(meta(80, 40), view(), [hold("meta", "as-1", 40)])).toMatchObject({ kind: "needs_raise", to_usd: 25646 });
  });

  it("a Meta campaign budget (CBO) raise is read like an ad set, keyed on the campaign", async () => {
    const card = (to: number, from: number, currency?: string) => ({
      exec_class: "meta_ads.update_campaign_budget_review",
      exec_payload: { campaign_id: "mc-1", daily_budget_usd: to, expected_current_daily_budget_usd: from, rationale: "", over_cap: false, ...(currency ? { currency } : {}) },
    });
    expect(raiseFromCard(card(80, 40).exec_class, card(80, 40).exec_payload)).toEqual({ platform: "meta", object_id: "mc-1", new_daily_usd: 80, current_daily_usd: 40 });
    expect(await need(card(80, 40), view(), [hold("meta", "mc-1", 40)])).toMatchObject({ kind: "needs_raise", to_usd: 25646 });
    expect(await need(card(30, 40), view())).toEqual({ kind: "not_a_raise" });
    expect(await need(card(80, 40, "INR"), view())).toEqual({ kind: "unfixable", why: "non_usd_account" });
    expect(raiseFromCard("meta_ads.update_campaign_budget", { campaign_id: "mc-1" })).toBeNull();
  });

  it("applies the budget's margin", async () => {
    expect(await need(google(110, 55), view({ margin: 1.25 }), [hold("google", "c-1", 55)])).toMatchObject({ to_usd: 26365 });
  });

  it("in the budget's first month the monthly amount rises by more than the shortfall", async () => {
    const v = view({ monthly_usd: 3100, month_cap_usd: 2100, spent_usd: 100, held_usd: 1900, left_usd: 100, started_on: "2026-10-11", days_left: 21 });
    const n = await need(google(30, 20), v, [hold("google", "c-1", 20)]);
    expect(n).toMatchObject({ kind: "needs_raise", from_usd: 3100 });
    const to = (n as { to_usd: number }).to_usd;
    expect(Math.floor((to * 21) / 31 * 100) / 100).toBeGreaterThanOrEqual(2210);
    expect(Math.floor(((to - 1) * 21) / 31 * 100) / 100).toBeLessThan(2210);
  });

  it("a daily limit the raise would break cannot be fixed by a monthly raise", async () => {
    expect(await need(google(110, 55), view({ daily_limit_usd: 100 }), [hold("google", "c-1", 55), hold("meta", "as-9", 40)])).toEqual({ kind: "unfixable", why: "over_daily_limit" });
  });

  it("never reads as fits when it could not be read", async () => {
    expect(await budgetRaiseNeed("t-1", google(110, 55), { readView: async () => { throw new Error("db down"); } })).toEqual({ kind: "unreadable" });
    expect(await budgetRaiseNeed("t-1", google(110, 55), { readView: async () => view(), readHolds: async () => { throw new Error("db down"); } })).toEqual({ kind: "unreadable" });
    expect(await need({ exec_class: "google_ads.update_campaign_budget", exec_payload: { campaign_id: "c-1" } }, view())).toEqual({ kind: "unreadable" });
  });

  it("no active budget, a cut, another class and a non-USD account each say what they are", async () => {
    expect(await need(google(110, 55), null)).toEqual({ kind: "no_budget" });
    expect(await need(google(110, 55), view({ status: "stopped" }))).toEqual({ kind: "no_budget" });
    expect(await need(google(40, 55), view())).toEqual({ kind: "not_a_raise" });
    expect(await need({ exec_class: "google_ads.set_status", exec_payload: {} }, view())).toEqual({ kind: "not_a_raise" });
    expect(await need(meta(80, 40, "INR"), view())).toEqual({ kind: "unfixable", why: "non_usd_account" });
    expect(await need(meta(80, 40, "INR"), null)).toEqual({ kind: "no_budget" });
  });
});

describe("computeBudgetRaiseNeed", () => {
  it("Upcar 2026-10-08: a $1 raise on an ad set Zavi never held fits $530.07 of room (it holds $24, not $984)", () => {
    const r = raiseFromCard(meta(41, 40).exec_class, meta(41, 40).exec_payload);
    expect(r).toMatchObject({ platform: "meta", object_id: "as-1", new_daily_usd: 41, current_daily_usd: 40 });
    const upcar = view({ spent_usd: 4002.25, held_usd: 20467.68, left_usd: 530.07, days_left: 24 });
    expect(computeBudgetRaiseNeed(r as never, upcar, [])).toEqual({ kind: "fits" });
  });
});

it("ChatGPT previews the same 2x increase and daily-limit check as its reservation", async () => {
  const payload = { campaign_id: "cmpn_test", name: "Raise", origin: "agent", summary: "Raise budget", rationale: "A verified reason", expected_updated_at: 1, daily_budget_usd: 35, expected_current_daily_budget_usd: 25 };
  const card = { exec_class: "chatgpt_ads.update_campaign_budget", exec_payload: payload };
  expect(raiseFromCard(card.exec_class, payload)).toMatchObject({ platform: "chatgpt", new_daily_usd: 35 });
  expect(await need(card, view())).toMatchObject({ kind: "needs_raise", to_usd: 25146 });
  expect(await need(card, view({ daily_limit_usd: 60 }), [hold("chatgpt", "cmpn_test", 50)])).toEqual({ kind: "unfixable", why: "over_daily_limit" });
});
