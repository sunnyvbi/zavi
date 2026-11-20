import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuth = vi.fn();
const decideOnDecision = vi.fn();
const logEvent = vi.fn();
vi.mock("@/services/auth/middleware", () => ({ requireAuth: (...a: unknown[]) => requireAuth(...a) }));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: (...a: unknown[]) => decideOnDecision(...a) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/staff/capture-admin-correction", () => ({ captureAdminCorrection: vi.fn() }));
vi.mock("@/services/humans/applications", () => ({ settleHumanApplicationDecision: vi.fn(), HUMAN_APPLICATION_REVIEW_CLASS: "human.application_review" }));

const ID = "33333333-3333-4333-8333-333333333333";
function res() {
  const out: { status: number; body: unknown } = { status: 200, body: null };
  return { out, json: (b: unknown) => void (out.body = b), status: (s: number) => ((out.status = s), { json: (b: unknown) => void (out.body = b) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ tenant_id: "t-1", user_id: "u-1", access_token: "x" });
});

describe("approvals.decide_outcome", () => {
  it("logs the surface, class, outcome and changed on an approve", async () => {
    decideOnDecision.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "approved", decision_id: ID, decision_class: "pm.ticket", allowlisted: false });
    const { approvalsApprove } = await import("../decide");
    const r = res();
    await approvalsApprove({ params: { decision_id: ID }, query: { surface: "needs_you" }, body: {} } as never, r as never);
    expect(r.out.status).toBe(200);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "approvals.decide_outcome",
        tenant_id: "t-1",
        meta: { surface: "needs_you", decision_class: "pm.ticket", outcome: "ok", changed: true, op: "approve" },
      }),
    );
  });

  it("an unknown surface is logged as other, and a refused approve as a warn with changed:false", async () => {
    decideOnDecision.mockResolvedValue({ ok: false, code: "not_authorized", changed: false, status: "proposed", decision_id: ID, decision_class: "meta_ads.launch_campaign", allowlisted: false });
    const { approvalsApprove } = await import("../decide");
    const r = res();
    await approvalsApprove({ params: { decision_id: ID }, query: { surface: "<script>" }, body: {} } as never, r as never);
    expect(r.out.status).toBe(403);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", meta: expect.objectContaining({ surface: "other", outcome: "not_authorized", changed: false }) }));
  });

  it("a reject with no surface logs other", async () => {
    decideOnDecision.mockResolvedValue({ ok: true, code: "ok", changed: false, status: "rejected", decision_id: ID, decision_class: "pm.ticket", allowlisted: false });
    const { approvalsReject } = await import("../decide");
    await approvalsReject({ params: { decision_id: ID }, query: {}, body: {} } as never, res() as never);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ surface: "other", op: "reject", changed: false }) }));
  });
});
