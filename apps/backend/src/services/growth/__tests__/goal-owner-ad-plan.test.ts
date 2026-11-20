import { beforeAll, describe, expect, it, vi } from "vitest";
import { planModelQuestions } from "@/services/growth/goal-owner";
import { adPlanReply, applyAdPlanYes, loadReplyReader, reshapeForAmount, type AdPlanOnYes } from "@/services/growth/ad-plan-yes";

const GOAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GOAL = { id: GOAL_ID, status: "active", objective: "More bookings", target_metric: "bookings", target_value: 100, due_date: "2026-12-31" } as never;
const TODAY = "2026-10-15";
const moves = (questions: unknown[]) => ({ note: { questions } }) as never;
const ctx = (left: number, connected: string[]) => ({ left_usd: left, days_left: 17, margin: 1, connected });

describe("planModelQuestions with ad plans", () => {
  it("aethel: $58 left, ChatGPT only -> one question for a $58 lifetime total over 2 days, recommended yes", () => {
    const r = planModelQuestions({ moves: moves([{ topic: "ChatGPT test", ask: "x", ad_plan: { channel_slug: "chatgpt_ads", amount_usd: 58 } }]), goals: [GOAL], today: TODAY, acts: true, adPlan: ctx(58, ["chatgpt_ads"]) });
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]).toMatchObject({ topic_key: "ad_plan:chatgpt_ads", recommended: "yes", ask: "Should I spend $58.00 on ChatGPT ads from Oct 15 to Oct 16? It is one total for the whole test, so it can never spend more." });
    expect(r.asks[0].on_yes).toMatchObject({ kind: "ad_plan", goal_id: GOAL_ID, plan: { budget_type: "lifetime", total_usd: 58, days: 2 } });
  });
  it("$40 left, only TikTok -> one 'Add $10' line, nothing to say yes to", () => {
    const r = planModelQuestions({ moves: moves([{ topic: "TikTok test", ask: "x", ad_plan: { channel_slug: "tiktok_ads", amount_usd: 40 } }]), goals: [GOAL], today: TODAY, acts: true, adPlan: ctx(40, ["tiktok_ads"]) });
    expect(r.asks).toEqual([{ topic_key: "ad_plan:none", ask: "Add $10 or wait for next month to run an ad test.", default_action: null }]);
  });
  it("the preferred channel cannot fit -> silent switch to the next connected one", () => {
    const r = planModelQuestions({ moves: moves([{ topic: "t", ask: "x", ad_plan: { channel_slug: "tiktok_ads", amount_usd: 40 } }]), goals: [GOAL], today: TODAY, acts: true, adPlan: ctx(40, ["tiktok_ads", "chatgpt_ads"]) });
    expect(r.asks[0].on_yes).toMatchObject({ kind: "ad_plan", plan: { channel_slug: "chatgpt_ads", total_usd: 40, switched_from: "tiktok_ads" } });
  });
  it("kill switch off (no ad plan context): the question is the model's own words, no plan", () => {
    const r = planModelQuestions({ moves: moves([{ topic: "t", ask: "Run a ChatGPT test?", ad_plan: { channel_slug: "chatgpt_ads", amount_usd: 58 } }]), goals: [GOAL], today: TODAY, acts: true });
    expect(r.asks[0]).toMatchObject({ ask: "Run a ChatGPT test?" });
    expect(r.asks[0].on_yes).toBeUndefined();
  });
});

describe("the founder's words", () => {
  beforeAll(loadReplyReader);
  it("a plain yes, a numbered yes, and 'yes but $30'", () => {
    expect(adPlanReply("Yes", null)).toEqual({ yes: true, amount_usd: null });
    expect(adPlanReply("1 yes", 1)).toEqual({ yes: true, amount_usd: null });
    expect(adPlanReply("2 yes", 1)).toBeNull();
    expect(adPlanReply("yes but $30", null)).toEqual({ yes: true, amount_usd: 30 });
    expect(adPlanReply("ok, $40", null)).toEqual({ yes: true, amount_usd: 40 });
  });
  it("no, maybe, a question or a condition is not a yes", () => {
    for (const t of ["no", "not now", "yes if it works", "maybe", "why ChatGPT?", "", null]) expect(adPlanReply(t as string, null)).toBeNull();
  });
  it("'yes but $30' reshapes the plan to $30 on the same channel", () => {
    const plan = { channel_slug: "chatgpt_ads", budget_type: "lifetime" as const, total_usd: 58, daily_usd: null, start: TODAY, end: "2026-10-17", days: 2, switched_from: null };
    expect(reshapeForAmount(plan, 30, TODAY, 17)).toMatchObject({ channel_slug: "chatgpt_ads", budget_type: "lifetime", total_usd: 30, days: 1 });
    expect(reshapeForAmount(plan, 10, TODAY, 17)).toBeNull();
  });
});

describe("applyAdPlanYes", () => {
  const onYes: AdPlanOnYes = { kind: "ad_plan", goal_id: GOAL_ID, goal_rev: "r1", plan: { channel_slug: "chatgpt_ads", budget_type: "lifetime", total_usd: 58, daily_usd: null, start: TODAY, end: "2026-10-17", days: 2, switched_from: null } };
  const base = { tenant_id: "t1", question: { id: "q1", ordinal: 1, on_yes: onYes }, surface: "web_button" as const, amount_usd: null, days_left: 17, now: new Date("2026-10-15T12:00:00Z") };
  const deps = () => ({
    emitDecision: vi.fn(async () => "card-1"),
    loadRole: vi.fn(async () => "admin"),
    setEnvelope: vi.fn(async () => ({ ok: true })),
    approve: vi.fn(async () => true),
    enabled: async () => true,
  });
  it("an admin's yes files one card with the question id, writes the envelope as THAT admin, and approves it as them", async () => {
    const d = deps();
    const r = await applyAdPlanYes({ ...base, approver_user_id: "admin-1" }, d);
    expect(r.refused).toBeNull();
    expect(d.emitDecision).toHaveBeenCalledWith("cgo.dispatch-specialist", expect.objectContaining({ target_agent_slug: "chatgpt_ads", source_question_id: "q1", goal_id: GOAL_ID }));
    expect(d.setEnvelope).toHaveBeenCalledWith("t1", "decisions", "card-1", expect.objectContaining({ envelope_id: "q:q1", actor_user_id: "admin-1", actor_role: "admin", max_total_usd: 58, max_daily_usd: null, surface: "cgo_yes" }));
    expect(d.approve).toHaveBeenCalledWith("t1", "card-1", "admin-1");
  });
  it("a member, or no known answerer, files nothing", async () => {
    const d = { ...deps(), loadRole: vi.fn(async () => "member") };
    expect((await applyAdPlanYes({ ...base, approver_user_id: "m-1" }, d)).refused).toMatch(/owner or admin/);
    expect((await applyAdPlanYes({ ...base, approver_user_id: null }, d)).refused).toMatch(/owner or admin/);
    expect(d.emitDecision).not.toHaveBeenCalled();
  });
  it("a second delivery of the same yes reconciles to the card the first made (unique per question)", async () => {
    const d = { ...deps(), emitDecision: vi.fn(async () => { throw new Error("duplicate key value violates unique constraint"); }), existingCard: vi.fn(async () => "card-1") };
    const r = await applyAdPlanYes({ ...base, approver_user_id: "admin-1" }, d);
    expect(r.refused).toBeNull();
    expect(d.setEnvelope).toHaveBeenCalledWith("t1", "decisions", "card-1", expect.anything());
  });
  it("'yes but $30' approves $30, never the original $58", async () => {
    const d = deps();
    await applyAdPlanYes({ ...base, approver_user_id: "admin-1", amount_usd: 30 }, d);
    expect(d.setEnvelope).toHaveBeenCalledWith("t1", "decisions", "card-1", expect.objectContaining({ max_total_usd: 30 }));
  });
  it("a late answer starts the approved length from the answer day", async () => {
    const d = deps();
    await applyAdPlanYes({ ...base, approver_user_id: "admin-1", now: new Date("2026-10-20T09:00:00Z") }, d);
    expect(d.setEnvelope).toHaveBeenCalledWith("t1", "decisions", "card-1", expect.objectContaining({ starts_on: "2026-10-20", ends_on: "2026-10-22" }));
  });
  it("kill switch off: nothing", async () => {
    const d = { ...deps(), enabled: async () => false };
    expect((await applyAdPlanYes({ ...base, approver_user_id: "admin-1" }, d)).line).toBeNull();
    expect(d.emitDecision).not.toHaveBeenCalled();
  });
});

describe("over the month: one raise question", () => {
  it("$300 budget, $280 used, a $50 founder ad -> 'uses $330 of your $300 ... Raise it to $330?'", async () => {
    const { budgetRaiseAsk } = await import("@/services/growth/ad-plan-yes");
    const q = budgetRaiseAsk({ id: "b1", monthly_usd: 300, month_cap_usd: 300, left_usd: 0, spent_usd: 230, held_usd: 100 });
    expect(q).toMatchObject({ topic_key: "ad_budget", recommended: "yes", ask: "That uses $330 of your $300 monthly ad budget. Raise it to $330 so Autopilot can keep testing?", on_yes: { kind: "budget_raise", budget_id: "b1", to_usd: 330 } });
    expect(budgetRaiseAsk({ id: "b1", monthly_usd: 300, month_cap_usd: 300, left_usd: 20, spent_usd: 200, held_usd: 80 })).toBeNull();
  });
  it("a yes raises it as the owner or admin who answered; a member changes nothing", async () => {
    const { applyBudgetRaiseYes } = await import("@/services/growth/ad-plan-yes");
    const update = vi.fn(async () => true);
    const readBudget = async () => ({ id: "b1", monthly_usd: 300, daily_limit_usd: 40 });
    expect(await applyBudgetRaiseYes("t1", { kind: "budget_raise", budget_id: "b1", to_usd: 330 }, "u1", { loadRole: async () => "owner", readBudget, update })).toEqual({ line: "Your monthly ad budget is now $330.", refused: null });
    expect(update).toHaveBeenCalledWith({ actor: "u1", budget_id: "b1", monthly_usd: 330, daily_limit_usd: 40 });
    update.mockClear();
    expect((await applyBudgetRaiseYes("t1", { kind: "budget_raise", budget_id: "b1", to_usd: 330 }, "m1", { loadRole: async () => "member", readBudget, update })).line).toBeNull();
    expect((await applyBudgetRaiseYes("t1", { kind: "budget_raise", budget_id: "other", to_usd: 330 }, "u1", { loadRole: async () => "owner", readBudget, update })).refused).toMatch(/changed/);
    expect(update).not.toHaveBeenCalled();
  });
});
