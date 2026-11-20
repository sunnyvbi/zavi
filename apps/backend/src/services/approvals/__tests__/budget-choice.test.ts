import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rpc: [] as Array<{ data?: unknown; error?: { message: string } | null }>,
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (_t: string, fn: string, args: Record<string, unknown>) => {
    m.calls.push({ fn, args });
    const next = m.rpc.shift() ?? { data: null, error: { message: "no answer queued" } };
    return { data: next.data ?? null, error: next.error ?? null };
  },
  globalClient: () => ({}),
}));

import { adBudgetChoiceFromBlob } from "@/services/decisions/ad-budget-choice-flag";
import { approveRaiseWithBudget, budgetChoiceRefusal, budgetChoiceView, type BudgetChoiceView } from "../budget-choice";
import type { ChangeFit, MonthCount } from "@/services/decisions/ad-month-counter";

const count = (o: Partial<MonthCount> = {}): MonthCount => ({
  budget_id: "b-1", month_start: "2026-10-01", monthly_usd: 27000, month_cap_usd: 27000, days_left: 8, spent_usd: 18000,
  creator_usd: 0, running_daily_usd: 1100, pending_daily_usd: 0, projection_usd: 26800, ...o,
});
const raise = { platform: "google" as const, object_id: "c1", delta_daily_usd: 30 };
const over = (raise_to: number | null, daily_to: number | null = null, o: Partial<MonthCount> = {}): ChangeFit => ({
  kind: "over", count: count(o), with_usd: 27040, over_by_usd: 40, raise_to_usd: raise_to, daily_limit_usd: daily_to === null ? null : 1000,
  daily_limit_to_usd: daily_to, token: "tok-1", raise, gate_usd: 0, set_aside_over: false,
});
const fits: ChangeFit = { kind: "fits", count: count(), with_usd: 26000, token: "tok-1", raise };
const args = (o: Partial<Parameters<typeof approveRaiseWithBudget>[0]> = {}) => ({
  tenant_id: "t-1", decision_id: "d-1", actor_user_id: "u-1", decision_class: "google_ads.update_campaign_budget", body: {}, surface: "web" as const, ask: {}, ...o,
});
const queueFits = (...f: ChangeFit[]) => {
  const q = [...f];
  return { readFit: async () => q.shift() ?? f[f.length - 1] };
};

beforeEach(() => {
  m.rpc = [];
  m.calls = [];
});

describe("adBudgetChoiceFromBlob", () => {
  it("absent is ON, false is OFF, an unreadable blob is OFF", () => {
    expect(adBudgetChoiceFromBlob({})).toBe(true);
    expect(adBudgetChoiceFromBlob({ ad_budget_choice_enabled: true })).toBe(true);
    expect(adBudgetChoiceFromBlob({ ad_budget_choice_enabled: false })).toBe(false);
    expect(adBudgetChoiceFromBlob(null)).toBe(false);
  });
});

describe("budgetChoiceView", () => {
  it("the month label follows month_start, not the clock (Oct 31 6pm Pacific already counts November)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T23:00:00-07:00"));
    try {
      const v = budgetChoiceView(over(27100, null, { month_start: "2026-11-01" })) as Extract<BudgetChoiceView, { kind: "over" }>;
      expect(v.month_label).toBe("November");
      expect(v).toMatchObject({ kind: "over", projection_usd: 27040, monthly_usd: 27000, over_by_usd: 40, raise_to_usd: 27100 });
    } finally {
      vi.useRealTimers();
    }
  });
  it("no budget and not a raise give null; unreadable keeps its reason", () => {
    expect(budgetChoiceView({ kind: "no_budget" })).toBeNull();
    expect(budgetChoiceView({ kind: "not_a_raise" })).toBeNull();
    expect(budgetChoiceView({ kind: "unreadable", why: "google was last read 2026-10-20" })).toEqual({ kind: "unreadable", why: "google was last read 2026-10-20" });
  });
});

describe("budgetChoiceRefusal", () => {
  const v = budgetChoiceView(over(27100)) as BudgetChoiceView;
  it("Slack (other) over budget is told to choose in Zavi, with the numbers", () => {
    expect(budgetChoiceRefusal(v, "other", { raise_budget_to_usd: 27100 })).toEqual({
      code: "budget_choice_in_zavi",
      detail: "October is projected at about $27,040, over your $27,000 budget. Open it in Zavi to choose.",
    });
  });
  it("web without the ask needs the choice; an ask below the need is budget_raise_changed; enough passes", () => {
    expect(budgetChoiceRefusal(v, "web", {})?.code).toBe("budget_choice_required");
    expect(budgetChoiceRefusal(v, "web", { raise_budget_to_usd: 27000 })?.code).toBe("budget_raise_changed");
    expect(budgetChoiceRefusal(v, "web", { raise_budget_to_usd: 27100 })).toBeNull();
  });
  it("must-catch Q3/B: a daily-limit block needs the daily ask too", () => {
    const d = budgetChoiceView(over(null, 1021)) as BudgetChoiceView;
    expect(budgetChoiceRefusal(d, "web", {})).toMatchObject({ code: "budget_choice_required", detail: "This goes over your $1,000 daily ad limit." });
    expect(budgetChoiceRefusal(d, "web", { raise_daily_limit_to_usd: 1021 })).toBeNull();
    const both = budgetChoiceView(over(27100, 1020)) as BudgetChoiceView;
    expect(budgetChoiceRefusal(both, "web", { raise_budget_to_usd: 27100 })?.code).toBe("budget_choice_required");
    expect(budgetChoiceRefusal(both, "web", { raise_budget_to_usd: 27100, raise_daily_limit_to_usd: 1020 })).toBeNull();
  });
});

describe("approveRaiseWithBudget", () => {
  it("must-catch concurrent taps (TS side): stale, then the re-read needs more than asked: refused with the new number, no second RPC", async () => {
    m.rpc = [{ data: { status: "stale" } }];
    const r = await approveRaiseWithBudget(args({ ask: { raise_budget_to_usd: 27100 } }), queueFits(over(27100), over(27200)));
    expect(r).toMatchObject({ kind: "refused", code: "budget_raise_changed" });
    expect(r.kind === "refused" && r.detail).toContain("$27,200");
    expect(m.calls).toHaveLength(1);
  });
  it("stale, then the same need: retried silently and approved (2 RPC calls)", async () => {
    m.rpc = [{ data: { status: "stale" } }, { data: { status: "approved", changed: true } }];
    expect(await approveRaiseWithBudget(args({ ask: { raise_budget_to_usd: 27100 } }), queueFits(over(27100)))).toEqual({ kind: "approved", changed: true });
    expect(m.calls).toHaveLength(2);
  });
  it("must-catch F1: over_month under the lock re-reads; a need that grew is refused with the new number", async () => {
    m.rpc = [{ data: { status: "over_month", used_usd: 955, hold_usd: 55, month_cap_usd: 1000 } }];
    const r = await approveRaiseWithBudget(args({ ask: { raise_budget_to_usd: 27100 } }), queueFits(over(27100), over(27200)));
    expect(r).toMatchObject({ kind: "refused", code: "budget_raise_changed" });
    expect(m.calls).toHaveLength(1);
  });
  it("set-aside over: the card says what is set aside, never a projection it does not have", () => {
    const f = { ...over(1100), set_aside_over: true, gate_usd: 1010 } as ChangeFit;
    const v = budgetChoiceView(f) as Extract<BudgetChoiceView, { kind: "over" }>;
    expect(budgetChoiceRefusal(v, "other", {})?.detail).toBe("With what is already set aside for your running ads in October, this goes past your $27,000 budget. Open it in Zavi to choose.");
  });
  it("3 x stale is budget_unreadable", async () => {
    m.rpc = [{ data: { status: "stale" } }, { data: { status: "stale" } }, { data: { status: "stale" } }];
    expect(await approveRaiseWithBudget(args(), queueFits(fits))).toMatchObject({ kind: "refused", code: "budget_unreadable" });
    expect(m.calls).toHaveLength(3);
  });
  it("limits_below_used gives plain words naming the used amount", async () => {
    m.rpc = [{ data: { status: "limits_below_used", used_usd: 27350 } }];
    const r = await approveRaiseWithBudget(args({ ask: { raise_budget_to_usd: 27100 } }), queueFits(over(27100)));
    expect(r).toMatchObject({ kind: "refused", code: "budget_raise_failed", detail: "That budget would be below the $27,350 already spent or set aside this month, so nothing was approved." });
  });
  it("an RPC exception about the Pro plan says so", async () => {
    m.rpc = [{ error: { message: "ad_budget: the Pro plan is required" } }];
    expect(await approveRaiseWithBudget(args({ ask: { raise_budget_to_usd: 27100 } }), queueFits(over(27100)))).toMatchObject({
      kind: "refused", code: "budget_raise_failed", detail: "Raising the ad budget needs the Pro plan, so nothing was approved.",
    });
  });
  it("Slack over budget is budget_choice_in_zavi with no RPC call; Slack that fits calls the RPC with no targets", async () => {
    expect(await approveRaiseWithBudget(args({ surface: "other" }), queueFits(over(27100)))).toMatchObject({ kind: "refused", code: "budget_choice_in_zavi" });
    expect(m.calls).toHaveLength(0);
    m.rpc = [{ data: { status: "approved", changed: true } }];
    expect(await approveRaiseWithBudget(args({ surface: "other", ask: { raise_budget_to_usd: 99999 } }), queueFits(fits))).toEqual({ kind: "approved", changed: true });
    expect(m.calls[0].args).toMatchObject({ p_monthly_to: null, p_daily_limit_to: null });
  });
  it("no_budget / not_a_raise pass through, also when the RPC answers not_a_raise", async () => {
    expect(await approveRaiseWithBudget(args(), queueFits({ kind: "no_budget" }))).toEqual({ kind: "passthrough" });
    expect(await approveRaiseWithBudget(args(), queueFits({ kind: "not_a_raise" }))).toEqual({ kind: "passthrough" });
    m.rpc = [{ data: { status: "not_a_raise" } }];
    expect(await approveRaiseWithBudget(args(), queueFits(fits))).toEqual({ kind: "passthrough" });
  });
  it("must-catch R2: an RPC answer of changed is card_changed, with no retry", async () => {
    m.rpc = [{ data: { status: "changed" } }];
    expect(await approveRaiseWithBudget(args(), queueFits(fits))).toMatchObject({ kind: "refused", code: "card_changed" });
    expect(m.calls).toHaveLength(1);
  });
  it("the RPC gets the token and the fit's object and $/day, never a platform", async () => {
    m.rpc = [{ data: { status: "approved", changed: true } }];
    await approveRaiseWithBudget(args({ ask: { raise_budget_to_usd: 27100 } }), queueFits(over(27100)));
    expect(m.calls[0]).toEqual({
      fn: "approve_ad_raise_with_budget",
      args: { p_decision_id: "d-1", p_actor_user_id: "u-1", p_token: "tok-1", p_expected_object_id: "c1", p_expected_daily_delta_usd: 30, p_monthly_to: 27100, p_daily_limit_to: null },
    });
  });
  it("an unreadable month refuses before any RPC", async () => {
    expect(await approveRaiseWithBudget(args(), queueFits({ kind: "unreadable", why: "read" }))).toMatchObject({ kind: "refused", code: "budget_unreadable" });
    expect(m.calls).toHaveLength(0);
  });
});
