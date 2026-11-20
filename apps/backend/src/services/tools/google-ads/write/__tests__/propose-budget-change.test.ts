
import { describe, it, expect, vi, beforeEach } from "vitest";

const flagEnabled = vi.fn(async () => true);

const videoGuard = vi.hoisted(() => ({ campaign: vi.fn(async (_t: string, _id: string) => {}), adGroup: vi.fn(async (_t: string, _id: string) => {}) }));
vi.mock("../_video-guard", () => ({ assertNotVideoCampaign: videoGuard.campaign, assertNotVideoAdGroup: videoGuard.adGroup }));
vi.mock("../_flag-check", () => ({
  isGoogleAdsWriteEnabled: () => flagEnabled(),
}));
vi.mock("../_currency-guard", () => ({ assertUsdGoogleAccount: vi.fn(async (_c: unknown, _w: string) => {}) }));

const capState = {
  cap: {
    enabled: true,
    max_daily_budget_usd: 100_000,
    max_pct_change_per_run: null as number | null,
    max_daily_total_change_usd: null as number | null,
  } as unknown,
  today_total_change_usd: 0,
};
vi.mock("../cap-reader", () => ({
  readTenantGoogleCapAndToday: vi.fn(async () => capState),
}));

const cgoBudget = vi.fn(async (): Promise<unknown> => null);
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: () => cgoBudget() }));

import { googleProposeBudgetChangeTool } from "../propose_budget_change";
import type { ToolContext } from "@/services/tools/types";

function makeCtx() {
  const emit = vi.fn(async () => "decision-id-1");
  const ctx: ToolContext = {
    tenant_id: "tenant-1",
    log: () => {},
    emit_decision: emit,
  };
  return { ctx, emit };
}

describe("google_ads__propose_budget_change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagEnabled.mockResolvedValue(true);
    capState.cap = {
      enabled: true,
      max_daily_budget_usd: 100_000,
      max_pct_change_per_run: null,
      max_daily_total_change_usd: null,
    };
    capState.today_total_change_usd = 0;
  });

  it("a VIDEO campaign → REFUSES before any cap read, emits NO decision", async () => {
    videoGuard.campaign.mockRejectedValueOnce(Object.assign(new Error("VIDEO"), { code: "google_ads_video_mutate_unsupported" }));
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeBudgetChangeTool.execute(ctx, { campaign_id: "111", current_daily_budget_usd: 50, proposed_daily_budget_usd: 60, rationale: "scale" }),
    ).rejects.toMatchObject({ code: "google_ads_video_mutate_unsupported" });
    expect(videoGuard.campaign).toHaveBeenCalledWith("tenant-1", "111");
    expect(emit).not.toHaveBeenCalled();
  });

  it("flag OFF → REFUSES, emits NO decision (no write capability)", async () => {
    flagEnabled.mockResolvedValue(false);
    const { ctx, emit } = makeCtx();
    await expect(
      googleProposeBudgetChangeTool.execute(ctx, {
        campaign_id: "111",
        current_daily_budget_usd: 50,
        proposed_daily_budget_usd: 60,
        rationale: "scale a winner",
      }),
    ).rejects.toMatchObject({ code: "google_ads_write_disabled" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("within-cap → auto class", async () => {
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(ctx, {
      campaign_id: "111",
      current_daily_budget_usd: 50,
      proposed_daily_budget_usd: 55,
      rationale: "graduated step",
    })) as { decision_class: string; within_cap: boolean };
    expect(out.within_cap).toBe(true);
    expect(out.decision_class).toBe("google_ads.update_campaign_budget");
  });

  it("review Q6: the founder's own chat command is stamped origin user_initiated_chat; a cron run or a rule-steered turn is not", async () => {
    const args = { campaign_id: "111", current_daily_budget_usd: 50, proposed_daily_budget_usd: 300, rationale: "founder asked" };
    const chat = makeCtx();
    chat.ctx.run_trigger = "chat";
    await googleProposeBudgetChangeTool.execute(chat.ctx, args);
    expect((chat.emit.mock.calls[0] as unknown[])[1]).toMatchObject({ origin: "user_initiated_chat" });
    for (const over of [{ run_trigger: "cron" }, { run_trigger: "chat", rules_steered: { budget: true, status: false } }]) {
      const m = makeCtx();
      Object.assign(m.ctx, over);
      await googleProposeBudgetChangeTool.execute(m.ctx, args);
      expect(((m.emit.mock.calls[0] as unknown[])[1] as Record<string, unknown>).origin, JSON.stringify(over)).toBeUndefined();
    }
  });

  it("Founder Rules: a rule-steered within-cap change goes to review, not auto", async () => {
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(
      { ...ctx, rules_steered: { budget: true, status: false } },
      {
        campaign_id: "111",
        current_daily_budget_usd: 50,
        proposed_daily_budget_usd: 55,
        rationale: "a rule says raise winners",
      },
    )) as { decision_class: string; within_cap: boolean };
    expect(out.within_cap).toBe(true);
    expect(out.decision_class).toBe("google_ads.update_campaign_budget_review");
  });

  it("a run that read a captured web page never auto-applies a Google budget change", async () => {
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(
      { ...ctx, untrusted_context: true },
      { campaign_id: "111", current_daily_budget_usd: 50, proposed_daily_budget_usd: 55, rationale: "page said so" },
    )) as { decision_class: string };
    expect(out.decision_class).toBe("google_ads.update_campaign_budget_review");
  });

  it("over absolute ceiling → review class", async () => {
    capState.cap = {
      enabled: true,
      max_daily_budget_usd: 100,
      max_pct_change_per_run: null,
      max_daily_total_change_usd: null,
    };
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(ctx, {
      campaign_id: "111",
      current_daily_budget_usd: 90,
      proposed_daily_budget_usd: 150,
      rationale: "big scale",
    })) as { decision_class: string; within_cap: boolean };
    expect(out.within_cap).toBe(false);
    expect(out.decision_class).toBe("google_ads.update_campaign_budget_review");
  });

  it("no cap configured (cap null) → review (safe default refuse-to-auto)", async () => {
    capState.cap = null;
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(ctx, {
      campaign_id: "111",
      current_daily_budget_usd: 50,
      proposed_daily_budget_usd: 55,
      rationale: "step",
    })) as { decision_class: string; within_cap: boolean; cap_reason: string | null };
    expect(out.within_cap).toBe(false);
    expect(out.cap_reason).toBe("no_cap_configured");
    expect(out.decision_class).toBe("google_ads.update_campaign_budget_review");
  });

  it("a CUT with no cap configured: same review class and over_cap as before, plus cap_reason saying why", async () => {
    capState.cap = null;
    const { ctx, emit } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(ctx, {
      campaign_id: "111",
      current_daily_budget_usd: 20,
      proposed_daily_budget_usd: 10,
      rationale: "move $10/day to the better channel",
    })) as { decision_class: string; within_cap: boolean };
    expect(out.decision_class).toBe("google_ads.update_campaign_budget_review");
    const body = (emit.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(body.over_cap).toBe(true);
    expect(body.cap_reason).toBe("no_cap_configured");
  });

  it("a within-cap change carries no cap_reason", async () => {
    const { ctx, emit } = makeCtx();
    await googleProposeBudgetChangeTool.execute(ctx, { campaign_id: "111", current_daily_budget_usd: 50, proposed_daily_budget_usd: 55, rationale: "step" });
    const body = (emit.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(body.over_cap).toBe(false);
    expect("cap_reason" in body).toBe(false);
  });

  it("an over-long rationale is trimmed at a word to 500 chars instead of failing the proposal", async () => {
    const { ctx, emit } = makeCtx();
    const long = "Founder approved in chat. ".repeat(40);
    const args = googleProposeBudgetChangeTool.input_schema.parse({ campaign_id: "111", current_daily_budget_usd: 50, proposed_daily_budget_usd: 55, rationale: long });
    await googleProposeBudgetChangeTool.execute(ctx, args);
    const body = (emit.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    const r = body.rationale as string;
    expect(r.length).toBeLessThanOrEqual(500);
    expect(r.endsWith("…")).toBe(true);
    expect(r.startsWith("Founder approved in chat.")).toBe(true);
    expect(long.replace(/\s+/g, " ").startsWith(r.slice(0, -1))).toBe(true);
  });

  it(">30% raise on a DELIVERING campaign UNDER the dollar cap → FORCED to review (step guard)", async () => {
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(ctx, {
      campaign_id: "111",
      current_daily_budget_usd: 72,
      proposed_daily_budget_usd: 144,
      rationale: "top ROAS, scale hard",
      currently_delivering: true,
    })) as {
      decision_class: string;
      within_cap: boolean;
      forced_to_approval_by_step_guard: boolean;
      step_guard_reason: string | null;
    };
    expect(out.within_cap).toBe(true);
    expect(out.decision_class).toBe("google_ads.update_campaign_budget_review");
    expect(out.forced_to_approval_by_step_guard).toBe(true);
    expect(out.step_guard_reason).toBe("oversized_learning_phase_step");
  });

  it("within-step raise (+30%) on delivering campaign under cap → stays AUTO", async () => {
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(ctx, {
      campaign_id: "111",
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 130,
      rationale: "graduated scale",
      currently_delivering: true,
    })) as { decision_class: string; forced_to_approval_by_step_guard: boolean };
    expect(out.decision_class).toBe("google_ads.update_campaign_budget");
    expect(out.forced_to_approval_by_step_guard).toBe(false);
  });

  it("NON-delivering campaign + 2x raise → unaffected (stays auto under cap)", async () => {
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(ctx, {
      campaign_id: "111",
      current_daily_budget_usd: 72,
      proposed_daily_budget_usd: 144,
      rationale: "paused line, ramping back up",
      currently_delivering: false,
    })) as { decision_class: string; forced_to_approval_by_step_guard: boolean };
    expect(out.decision_class).toBe("google_ads.update_campaign_budget");
    expect(out.forced_to_approval_by_step_guard).toBe(false);
  });

  it("no emit_decision plumbed → refuses (cannot emit)", async () => {
    const ctx: ToolContext = { tenant_id: "tenant-1", log: () => {} };
    await expect(
      googleProposeBudgetChangeTool.execute(ctx, {
        campaign_id: "111",
        current_daily_budget_usd: 50,
        proposed_daily_budget_usd: 55,
        rationale: "step",
      }),
    ).rejects.toMatchObject({ code: "google_ads_propose_no_emit" });
  });
});

describe("google propose_budget_change: Autopilot with an ad budget", () => {
  const raise80 = { campaign_id: "111", current_daily_budget_usd: 100, proposed_daily_budget_usd: 180, rationale: "behind pace", currently_delivering: true };

  it("raise +80% on Autopilot + budget -> normal class", async () => {
    cgoBudget.mockResolvedValueOnce({ id: "b1" });
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(ctx, raise80)) as { decision_class: string };
    expect(out.decision_class).toBe("google_ads.update_campaign_budget");
  });

  it("the same raise without a budget -> review class", async () => {
    cgoBudget.mockResolvedValueOnce(null);
    const { ctx } = makeCtx();
    const out = (await googleProposeBudgetChangeTool.execute(ctx, raise80)) as { decision_class: string };
    expect(out.decision_class).toBe("google_ads.update_campaign_budget_review");
  });
});
