import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuth = vi.fn();
const decideOnDecision = vi.fn();
vi.mock("@/services/decisions/ad-budget-choice-flag", () => ({ adBudgetChoiceEnabled: async () => false }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: (...a: unknown[]) => requireAuth(...a) }));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: (...a: unknown[]) => decideOnDecision(...a) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/staff/capture-admin-correction", () => ({ captureAdminCorrection: vi.fn() }));
vi.mock("@/services/humans/applications", () => ({ settleHumanApplicationDecision: vi.fn(), HUMAN_APPLICATION_REVIEW_CLASS: "human.application_review" }));

const ID = "33333333-3333-4333-8333-333333333333";
const CONFIRM = { message: "This turns on “X”: +$60/day.", daily_add: 60, currency: "USD", open_legs: 2, why: "cut_untapped" };
function res() {
  const out: { status: number; body: unknown } = { status: 200, body: null };
  return { out, json: (b: unknown) => void (out.body = b), status: (s: number) => ((out.status = s), { json: (b: unknown) => void (out.body = b) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ tenant_id: "t-1", user_id: "u-1", access_token: "x" });
});

describe("Run it alone on the approve route", () => {
  it("a held raise answers 409 paired_move_waits carrying the confirm", async () => {
    decideOnDecision.mockResolvedValue({ ok: false, code: "paired_move_waits", changed: false, status: "proposed", decision_id: ID, decision_class: "meta_ads.set_status_review", allowlisted: false, detail: "old words", run_alone: CONFIRM });
    const { approvalsApprove } = await import("../decide");
    const r = res();
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: {} } as never, r as never);
    expect(r.out.status).toBe(409);
    expect(r.out.body).toEqual({ error: { code: "paired_move_waits", message: "old words", run_alone: CONFIRM } });
    expect(decideOnDecision).toHaveBeenCalledWith(expect.objectContaining({ run_alone: false, offer_run_alone: true }));
  });

  it("the flag reaches the service for the tenant's own person", async () => {
    decideOnDecision.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "approved", decision_id: ID, decision_class: "meta_ads.set_status_review", allowlisted: false });
    const { approvalsApprove } = await import("../decide");
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: { run_alone: true } } as never, res() as never);
    expect(decideOnDecision).toHaveBeenCalledWith(expect.objectContaining({ run_alone: true, actor: { user_id: "u-1" } }));
  });

  it("a staff session acting as the tenant cannot send it", async () => {
    requireAuth.mockResolvedValue({ tenant_id: "t-1", user_id: "staff-1", access_token: "x", tenant_overridden: true });
    decideOnDecision.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "approved", decision_id: ID, decision_class: "meta_ads.set_status_review", allowlisted: false });
    const { approvalsApprove } = await import("../decide");
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: { run_alone: true } } as never, res() as never);
    expect(decideOnDecision).toHaveBeenCalledWith(expect.objectContaining({ run_alone: false, offer_run_alone: false }));
  });
});

describe("budget choice on the approve route (plan 2026-10-23)", () => {
  it("the person's chosen limits reach the service with surface web; a staff session sends neither", async () => {
    decideOnDecision.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "approved", decision_id: ID, decision_class: "google_ads.update_campaign_budget_review", allowlisted: false });
    const { approvalsApprove } = await import("../decide");
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: { raise_budget_to_usd: 27100, raise_daily_limit_to_usd: 1020 } } as never, res() as never);
    expect(decideOnDecision).toHaveBeenCalledWith(expect.objectContaining({ surface: "web", raise_budget_to_usd: 27100, raise_daily_limit_to_usd: 1020 }));
    requireAuth.mockResolvedValue({ tenant_id: "t-1", user_id: "staff-1", access_token: "x", tenant_overridden: true });
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: { raise_budget_to_usd: 27100 } } as never, res() as never);
    expect(decideOnDecision).toHaveBeenLastCalledWith(expect.objectContaining({ surface: undefined, raise_budget_to_usd: undefined }));
  });

  it("a budget refusal is a 409 carrying the choice; an unreadable month is a 503", async () => {
    const view = { kind: "over", month_label: "October", projection_usd: 27040, monthly_usd: 27000, over_by_usd: 40, raise_to_usd: 27100, daily_limit_usd: null, daily_limit_to_usd: null };
    decideOnDecision.mockResolvedValue({ ok: false, code: "budget_choice_required", changed: false, status: "proposed", decision_id: ID, decision_class: "google_ads.update_campaign_budget_review", allowlisted: false, detail: "October is projected at about $27,040, over your $27,000 budget.", budget_choice: view });
    const { approvalsApprove } = await import("../decide");
    const r = res();
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: {} } as never, r as never);
    expect(r.out).toEqual({ status: 409, body: { error: { code: "budget_choice_required", message: "October is projected at about $27,040, over your $27,000 budget.", budget_choice: view } } });
    decideOnDecision.mockResolvedValue({ ok: false, code: "budget_unreadable", changed: false, status: "proposed", decision_id: ID, decision_class: "google_ads.update_campaign_budget_review", allowlisted: false, detail: "Zavi can't check your ad budget right now." });
    const r2 = res();
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: {} } as never, r2 as never);
    expect(r2.out.status).toBe(503);
  });

  it("a non-integer or negative limit is not a choice", async () => {
    decideOnDecision.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "approved", decision_id: ID, decision_class: "google_ads.update_campaign_budget_review", allowlisted: false });
    const { approvalsApprove } = await import("../decide");
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: { raise_budget_to_usd: -5 } } as never, res() as never);
    expect(decideOnDecision).toHaveBeenCalledWith(expect.objectContaining({ raise_budget_to_usd: undefined }));
  });
});

describe("email send plan refusal on the approve route", () => {
  it("answers with the plan refusal the service carries: 403 upgrade, 503 unreadable", async () => {
    const upgrade = { status: 403, body: { error: { code: "plan_upgrade_required", required_tier: "pro", message: "Needs Pro." } } };
    decideOnDecision.mockResolvedValue({ ok: false, code: "plan_required", changed: false, status: "proposed", decision_id: ID, decision_class: "bulk_outbound.send", allowlisted: false, detail: "Needs Pro.", plan_refusal: upgrade });
    const { approvalsApprove } = await import("../decide");
    const r = res();
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: { email_variant: 1, request_id: "req-12345678" } } as never, r as never);
    expect(r.out).toEqual(upgrade);
    const unreadable = { status: 503, body: { error: { code: "plan_unreadable", message: "Try again in a minute." } } };
    decideOnDecision.mockResolvedValue({ ok: false, code: "plan_required", changed: false, status: "proposed", decision_id: ID, decision_class: "bulk_outbound.send", allowlisted: false, detail: "Try again in a minute.", plan_refusal: unreadable });
    const r2 = res();
    await approvalsApprove({ params: { decision_id: ID }, query: {}, body: { email_variant: 1, request_id: "req-12345678" } } as never, r2 as never);
    expect(r2.out).toEqual(unreadable);
  });
});
