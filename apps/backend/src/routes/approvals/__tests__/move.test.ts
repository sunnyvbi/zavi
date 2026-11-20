import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuth = vi.fn();
vi.mock("@/services/auth/middleware", () => ({ requireAuth: (...a: unknown[]) => requireAuth(...a) }));
const mc = vi.hoisted(() => ({ approveMove: vi.fn(), rejectMove: vi.fn(), moveFit: vi.fn(), findMoneyView: vi.fn() }));
vi.mock("@/services/growth/move-card", () => mc);

import { approvalsApproveMove, approvalsFindMoney, approvalsMoveFit, approvalsRejectMove } from "../move";

const ID = "33333333-3333-4333-8333-333333333333";
const CUT = "44444444-4444-4444-8444-444444444444";
function res() {
  const out: { status: number; body: unknown } = { status: 200, body: null };
  return { out, json: (b: unknown) => void (out.body = b), status: (s: number) => ((out.status = s), { json: (b: unknown) => void (out.body = b) }) };
}
const req = (body: unknown, id = ID) => ({ params: { decision_id: id }, body }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ tenant_id: "t-1", user_id: "u-1", access_token: "x" });
});

describe("move routes", () => {
  it("400 on a bad body or id", async () => {
    const r = res();
    await approvalsApproveMove(req({ ticked_ids: ["not-a-uuid"] }), r as never);
    expect(r.out.status).toBe(400);
    const r2 = res();
    await approvalsApproveMove(req({ ticked_ids: [] }, "nope"), r2 as never);
    expect(r2.out.status).toBe(400);
    expect(mc.approveMove).not.toHaveBeenCalled();
  });
  it("403 for a staff session acting as the tenant", async () => {
    requireAuth.mockResolvedValue({ tenant_id: "t-1", user_id: "staff", access_token: "x", tenant_overridden: true });
    for (const h of [approvalsApproveMove, approvalsRejectMove, approvalsMoveFit, approvalsFindMoney]) {
      const r = res();
      await h(req({ ticked_ids: [CUT] }), r as never);
      expect(r.out.status).toBe(403);
    }
    expect(mc.approveMove).not.toHaveBeenCalled();
  });
  it("passes the ticks and the choice through; a refusal is a 409 with budget_choice and done", async () => {
    const view = { kind: "over", raise_to_usd: 27100 };
    mc.approveMove.mockResolvedValue({ ok: false, code: "budget_choice_required", detail: "October is projected...", budget_choice: view, done: [] });
    const r = res();
    await approvalsApproveMove(req({ ticked_ids: [ID, CUT], raise_budget_to_usd: 27100 }), r as never);
    expect(mc.approveMove).toHaveBeenCalledWith({ tenant_id: "t-1", actor_user_id: "u-1", anchor_id: ID, ticked_ids: [ID, CUT], raise_budget_to_usd: 27100 });
    expect(r.out).toEqual({ status: 409, body: { error: { code: "budget_choice_required", message: "October is projected...", line_id: null, done: [], budget_choice: view } } });
    mc.approveMove.mockResolvedValue({ ok: false, code: "move_cut_refused", line_id: CUT, done: [ID] });
    const r2 = res();
    await approvalsApproveMove(req({ ticked_ids: [ID, CUT] }), r2 as never);
    expect(r2.out).toMatchObject({ status: 409, body: { error: { code: "move_cut_refused", line_id: CUT, done: [ID] } } });
  });
  it("move-fit answers the net and the choice", async () => {
    mc.moveFit.mockResolvedValue({ ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } });
    const r = res();
    await approvalsMoveFit(req({ ticked_ids: [ID] }), r as never);
    expect(r.out.body).toEqual({ ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } });
  });
  it("reject-move answers what was rejected and kept", async () => {
    mc.rejectMove.mockResolvedValue({ ok: true, rejected: [ID], kept: ["Cut Dallas from $40 to $10 a day"] });
    const r = res();
    await approvalsRejectMove(req({}), r as never);
    expect(r.out.body).toEqual({ ok: true, rejected: [ID], kept: ["Cut Dallas from $40 to $10 a day"] });
  });
  it("find the money elsewhere: new_cuts are validated and passed through; a part-way filing names what it filed; changed candidates come back", async () => {
    const r0 = res();
    await approvalsApproveMove(req({ ticked_ids: [ID], new_cuts: [{ platform: "tiktok", object_id: "g1", to_usd: 80 }] }), r0 as never);
    expect(r0.out.status).toBe(400);
    const r1 = res();
    await approvalsApproveMove(req({ ticked_ids: [ID], new_cuts: Array.from({ length: 5 }, (_, i) => ({ platform: "google", object_id: `g${i}`, to_usd: 10 })) }), r1 as never);
    expect(r1.out.status).toBe(400);
    expect(mc.approveMove).not.toHaveBeenCalled();
    mc.approveMove.mockResolvedValue({ ok: false, code: "move_cut_file_failed", detail: "Zavi filed one of the cuts you picked", filed: [CUT], line_id: ID });
    const r2 = res();
    await approvalsApproveMove(req({ ticked_ids: [ID], new_cuts: [{ platform: "google", object_id: "g1", to_usd: 80 }] }), r2 as never);
    expect(mc.approveMove).toHaveBeenCalledWith(expect.objectContaining({ new_cuts: [{ platform: "google", object_id: "g1", to_usd: 80 }] }));
    expect(r2.out).toMatchObject({ status: 409, body: { error: { code: "move_cut_file_failed", filed: [CUT] } } });
    mc.moveFit.mockResolvedValue({ ok: false, code: "candidates_changed", candidates: [{ object_id: "g1", to_usd: 81 }] });
    const r3 = res();
    await approvalsMoveFit(req({ ticked_ids: [ID], new_cuts: [{ platform: "google", object_id: "g1", to_usd: 80 }] }), r3 as never);
    expect(mc.moveFit).toHaveBeenCalledWith("t-1", ID, [ID], [{ platform: "google", object_id: "g1", to_usd: 80 }]);
    expect(r3.out).toEqual({ status: 409, body: { error: { code: "candidates_changed", line_id: null, candidates: [{ object_id: "g1", to_usd: 81 }] } } });
  });
  it("find-money: the view, 404 for a card that is not an open raise, 503 on a read error", async () => {
    mc.findMoneyView.mockResolvedValue({ kind: "none", why: "no_clearly_worse", candidates: [], budget_choice: null, move: { key: "k", still_filing: false, lines: [] } });
    const r = res();
    await approvalsFindMoney(req(undefined), r as never);
    expect(r.out.body).toMatchObject({ kind: "none", why: "no_clearly_worse" });
    mc.findMoneyView.mockResolvedValue(null);
    const r2 = res();
    await approvalsFindMoney(req(undefined), r2 as never);
    expect(r2.out.status).toBe(404);
    mc.findMoneyView.mockRejectedValue(new Error("db"));
    const r3 = res();
    await approvalsFindMoney(req(undefined), r3 as never);
    expect(r3.out.status).toBe(503);
  });
});
