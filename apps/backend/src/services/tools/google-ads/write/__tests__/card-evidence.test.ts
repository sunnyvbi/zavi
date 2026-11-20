
import { describe, it, expect, vi, beforeEach } from "vitest";

const videoGuard = vi.hoisted(() => ({ campaign: vi.fn(async (_t: string, _id: string) => {}), adGroup: vi.fn(async (_t: string, _id: string) => {}) }));
vi.mock("../_video-guard", () => ({ assertNotVideoCampaign: videoGuard.campaign, assertNotVideoAdGroup: videoGuard.adGroup }));
vi.mock("../_flag-check", () => ({ isGoogleAdsWriteEnabled: async () => true }));
vi.mock("../_currency-guard", () => ({ assertUsdGoogleAccount: vi.fn(async (_c: unknown, _w: string) => {}) }));
vi.mock("../cap-reader", () => ({
  readTenantGoogleCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0 })),
}));

import { googleProposeBudgetChangeTool } from "../propose_budget_change";
import { googleProposeKeywordsTool } from "../propose_keywords";
import { googleProposeRemovalTool } from "../propose_removal";
import { buildGoogleAdsDecisionEvidence } from "../_card-evidence";
import { decisionEvidenceSchema } from "@/services/agents/decision-evidence";
import type { ToolContext } from "@/services/tools/types";

function makeCtx() {
  const emit = vi.fn(async (_cls: string, _body: Record<string, unknown>) => "d-1");
  const ctx = { tenant_id: "t-1", log: () => {}, emit_decision: emit } as unknown as ToolContext;
  return { ctx, emit };
}

const budgetInput = {
  campaign_id: "123",
  current_daily_budget_usd: 100,
  proposed_daily_budget_usd: 110,
  rationale: "Capped most days at the cheapest cost per booking.",
};

describe("google_ads proposal card evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores stats, window and estimate on body.decision_evidence and it validates", async () => {
    const { ctx, emit } = makeCtx();
    await googleProposeBudgetChangeTool.execute(ctx, {
      ...budgetInput,
      evidence_stats: [{ value: "26 of 30", caption: "days at cap" }],
      evidence_window: { from: "2026-08-01", to: "2026-08-30" },
      estimate: [{ value: "≈ 23", caption: "more bookings a month" }],
    });
    const body = emit.mock.calls[0][1] as { decision_evidence: unknown };
    const ev = decisionEvidenceSchema.parse(body.decision_evidence);
    expect(ev.stats).toEqual([{ value: "26 of 30", caption: "days at cap" }]);
    expect(ev.window).toEqual({ from: "2026-08-01", to: "2026-08-30" });
    expect(ev.estimate?.[0].value).toBe("≈ 23");
    expect(ev.reversibility).toBe("reversible");
  });

  it("a malformed evidence field is dropped and the proposal still emits", async () => {
    const { ctx, emit } = makeCtx();
    await googleProposeBudgetChangeTool.execute(ctx, {
      ...budgetInput,
      evidence_stats: "not an array",
      evidence_window: { from: 5 },
      estimate: [{ nope: true }],
      confidence: 7,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const body = emit.mock.calls[0][1] as { decision_evidence: Record<string, unknown>; daily_budget_usd: number };
    expect(body.daily_budget_usd).toBe(110);
    expect(body.decision_evidence.stats).toBeUndefined();
    expect(body.decision_evidence.window).toBeUndefined();
    expect(body.decision_evidence.estimate).toBeUndefined();
    expect(() => decisionEvidenceSchema.parse(body.decision_evidence)).not.toThrow();
  });

  it("the CRUD tools keep their dispatch body and add evidence alongside it", async () => {
    const { ctx, emit } = makeCtx();
    await googleProposeKeywordsTool.execute(ctx, {
      level: "campaign",
      campaign_id: "123",
      negative: true,
      keywords: [{ text: "free", match_type: "PHRASE" }],
      rationale: "Price-led queries with no bookings.",
      evidence_stats: [{ value: "$310", caption: "spent, 0 bookings" }],
    });
    const body = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.keywords).toEqual([{ text: "free", match_type: "PHRASE" }]);
    expect((body.decision_evidence as { stats: unknown[] }).stats).toHaveLength(1);
    expect(body.evidence_stats).toBeUndefined();
  });

  it("the risk of an action comes from its kind, not from the model", () => {
    expect(buildGoogleAdsDecisionEvidence("removal", "r", {}).reversibility).toBe("irreversible");
    expect(buildGoogleAdsDecisionEvidence("removal", "r", {}).blast_radius).toBe("RED");
    expect(buildGoogleAdsDecisionEvidence("budget", "r", {}).reversibility).toBe("reversible");
  });

  it("removal proposals are stored as irreversible", async () => {
    const { ctx, emit } = makeCtx();
    const input = {
      level: "campaign",
      campaign_id: "123",
      rationale: "Duplicate campaign.",
    };
    await googleProposeRemovalTool.execute(ctx, input);
    expect(emit).toHaveBeenCalledTimes(1);
    const body = emit.mock.calls[0][1] as { decision_evidence: { reversibility: string } };
    expect(body.decision_evidence.reversibility).toBe("irreversible");
  });

  it("stores a headline for the card title and drops one that is too long", async () => {
    const { ctx, emit } = makeCtx();
    await googleProposeBudgetChangeTool.execute(ctx, { ...budgetInput, headline: "Give your cheapest campaign more budget" });
    expect((emit.mock.calls[0][1] as { decision_evidence: { headline?: string } }).decision_evidence.headline).toBe(
      "Give your cheapest campaign more budget",
    );
    await googleProposeBudgetChangeTool.execute(ctx, { ...budgetInput, headline: "x".repeat(200) });
    expect(emit).toHaveBeenCalledTimes(2);
    expect((emit.mock.calls[1][1] as { decision_evidence: { headline?: string } }).decision_evidence.headline).toBeUndefined();
  });
});
