
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  send: vi.fn(async () => undefined),
  mark: vi.fn(),
  parse: vi.fn((): { ok: true; value: object } | { ok: false; reason: string } => ({ ok: true, value: {} })),
}));

vi.mock("@/../workers/client", () => ({ inngest: { send: m.send } }));
vi.mock("@/services/tenant-client", () => {
  const query = { eq: vi.fn(), error: null };
  query.eq.mockReturnValue(query);
  return { asTenantId: (id: string) => id, tenantClient: () => ({ from: () => ({ update: (patch: object) => { m.mark(patch); return query; } }) }) };
});
vi.mock("@/services/growth/goal-owner", () => ({
  OWN_GOALS_STAGE: "own_goals",
  parseGoalMoves: () => m.parse(),
  applyGoalMoves: vi.fn(async () => ({ note_visible: true, note_notify: true, note_id: "note-1" })),
  evidenceFromPayload: () => null,
  reviewMetaFromPayload: () => ({ autopilot: false }),
  reviewedRevsFromPayload: () => ({}),
  shownCardsFromPayload: () => [],
}));
vi.mock("@/agents/content-design/post-run", () => ({ resolveContentSeoPublishRepo: vi.fn() }));
vi.mock("@/services/memory", () => ({ writeNote: vi.fn() }));
vi.mock("@/services/growth/apply-strategy", () => ({ applyGrowthStrategy: vi.fn(), strategyFingerprint: vi.fn() }));
vi.mock("@/services/personalization/store", () => ({ getTenantPersonalization: vi.fn(), saveTenantPersonalization: vi.fn() }));
vi.mock("../plan-review", () => ({ isPlanReviewEnabled: () => false, reviewAndRevisePlan: vi.fn() }));

import { cgoPostProcess } from "../post-run";

const ctx = { tenant_id: "t-1", runId: "run-1", emitDecision: vi.fn() } as never;
const result = () => ({ raw_response_text: "<goal_moves>{}</goal_moves>", output_text: "", parse_ok: false }) as never;

beforeEach(() => {
  m.send.mockReset().mockResolvedValue(undefined);
  m.mark.mockClear();
  m.parse.mockReset().mockReturnValue({ ok: true, value: {} });
});

describe("cgo post-run note delivery", () => {
  it("an anomaly review sends no note email or DM", async () => {
    await cgoPostProcess(ctx, result(), { stage: "own_goals", reason: "metric_anomaly" });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.mark).not.toHaveBeenCalled();
  });

  it("any other visible review still sends its note", async () => {
    await cgoPostProcess(ctx, result(), { stage: "own_goals", reason: "daily_check" });
    expect(m.send).toHaveBeenCalledWith(expect.objectContaining({ name: "cgo/note.email", id: "cgo-note-email:run-1" }));
    expect(m.mark).toHaveBeenCalledWith({ queued_at: expect.any(String) });
    expect(m.send.mock.invocationCallOrder[0]).toBeLessThan(m.mark.mock.invocationCallOrder[0]);
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it("does not mark a review note as notified when queueing fails", async () => {
    m.send.mockRejectedValueOnce(new Error("queue unavailable"));
    await cgoPostProcess(ctx, result(), { stage: "own_goals", reason: "daily_check" });
    expect(m.mark).not.toHaveBeenCalled();
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it("a review that does not parse keeps the real reason on the run, and sends nothing", async () => {
    m.parse.mockReturnValue({ ok: false, reason: "Too big: expected string to have <=160 characters" });
    const r = { raw_response_text: "<goal_moves>{}</goal_moves>", output_text: "", parse_ok: false, parse_error: "no <strategy>...</strategy> block found" };
    await cgoPostProcess(ctx, r as never, { stage: "own_goals", reason: "ad_budget_review" });
    expect(r.parse_ok).toBe(false);
    expect(r.parse_error).toBe("goal review not applied: Too big: expected string to have <=160 characters");
    expect(m.send).not.toHaveBeenCalled();
  });

  it("a capped review keeps the cap first and adds the parse reason", async () => {
    m.parse.mockReturnValue({ ok: false, reason: "no <goal_moves> block" });
    const r = { raw_response_text: "partial", output_text: "", parse_ok: false, parse_error: "budget_cap" };
    await cgoPostProcess(ctx, r as never, { stage: "own_goals", reason: "daily_check" });
    expect(r.parse_error).toBe("budget_cap; goal review not applied: no <goal_moves> block");
  });
});
